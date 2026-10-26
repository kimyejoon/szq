'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { stateKey, gitTop } = require('../src/cache');
const { mkRepo, git, tmpDir } = require('./helpers');

async function key(repo, argv = ['node', '-v'], extra = {}) {
  const top = gitTop(repo);
  return stateKey({ cwd: repo, top, argv, ...extra });
}

test('same state, same command -> same key', async () => {
  const repo = mkRepo();
  assert.equal(await key(repo), await key(repo));
});

test('different command or sub-directory -> different key', async () => {
  const repo = mkRepo();
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub);
  const top = gitTop(repo);
  const a = await stateKey({ cwd: repo, top, argv: ['node', '-v'] });
  const b = await stateKey({ cwd: repo, top, argv: ['node', '-p', '1'] });
  const c = await stateKey({ cwd: sub, top, argv: ['node', '-v'] });
  assert.equal(new Set([a, b, c]).size, 3);
});

test('editing a tracked file, adding an untracked file and committing all change the key', async () => {
  const repo = mkRepo();
  const k0 = await key(repo);
  fs.appendFileSync(path.join(repo, 'a.txt'), 'more\n');
  const k1 = await key(repo);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  const k2 = await key(repo);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'y');
  const k3 = await key(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'second');
  const k4 = await key(repo);
  assert.equal(new Set([k0, k1, k2, k3]).size, 4);
  assert.equal(k4, k3, 'the key follows the content of the tree, not the commit: committing the same files keeps it');
});

test('ignored files do not change the key (documented limitation)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore');
  fs.mkdirSync(path.join(repo, 'dist'));
  const k1 = await key(repo);
  fs.writeFileSync(path.join(repo, 'dist', 'out.js'), 'built');
  assert.equal(await key(repo), k1);
});

test('cache.env values are part of the key', async () => {
  const repo = mkRepo();
  const a = await key(repo, ['node', '-v'], { cacheEnv: ['SZQ_TEST_VAR'], env: { SZQ_TEST_VAR: '1' } });
  const b = await key(repo, ['node', '-v'], { cacheEnv: ['SZQ_TEST_VAR'], env: { SZQ_TEST_VAR: '2' } });
  assert.notEqual(a, b);
});

test('outside a git repository there is no key', async () => {
  const dir = tmpDir();
  assert.equal(gitTop(dir), null);
});

test('an untracked FIFO does not hang key computation', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const repo = mkRepo();
  cp.execFileSync('mkfifo', [path.join(repo, 'pipe')]);
  assert.ok(await key(repo));
});

test('an untracked symlink is hashed by target, not followed', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const repo = mkRepo();
  fs.symlinkSync('/dev/zero', path.join(repo, 'zero'));
  assert.ok(await key(repo));
});

test('repository config cannot make git run helper programs (textconv, external diff, clean filters)', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const repo = mkRepo();
  const marker = path.join(tmpDir(), 'pwned');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil filter=evil\n');
  git(repo, 'add', '.gitattributes');
  git(repo, 'commit', '-q', '-m', 'attrs');
  git(repo, 'config', 'diff.evil.textconv', `sh -c 'touch ${marker}'`);
  git(repo, 'config', 'diff.external', `sh -c 'touch ${marker}'`);
  git(repo, 'config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`);
  git(repo, 'config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`);
  fs.appendFileSync(path.join(repo, 'a.txt'), 'change\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
  await key(repo);
  assert.equal(fs.existsSync(marker), false, 'no helper program of the repository may run while computing a key');
});

test('a change inside a submodule changes the key', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const sub = mkRepo();
  const repo = mkRepo();
  const r = require('child_process').spawnSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.email=t@e', '-c', 'user.name=t', 'submodule', 'add', sub, 'vendor/sub'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  git(repo, 'commit', '-q', '-m', 'add submodule');
  const k0 = await key(repo);
  fs.appendFileSync(path.join(repo, 'vendor', 'sub', 'a.txt'), 'dirty\n');
  const k1 = await key(repo);
  fs.writeFileSync(path.join(repo, 'vendor', 'sub', 'untracked.txt'), 'u');
  const k2 = await key(repo);
  assert.equal(new Set([k0, k1, k2]).size, 3);
});

test('file boundaries cannot be forged: one file "x\\0B\\0y" is not two files', { skip: process.platform === 'win32' }, async () => {
  const a = mkRepo();
  const b = mkRepo();
  fs.writeFileSync(path.join(a, 'A'), 'x\0B\0y');
  fs.writeFileSync(path.join(b, 'A'), 'x');
  fs.writeFileSync(path.join(b, 'B'), 'y');
  assert.notEqual(await key(a), await key(b));
});

test('a deleted tracked file changes the key', async () => {
  const repo = mkRepo();
  const k0 = await key(repo);
  fs.rmSync(path.join(repo, 'a.txt'));
  assert.notEqual(await key(repo), k0);
});

test('extraFiles that git ignores can be added to the key', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'state.txt\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore');
  fs.writeFileSync(path.join(repo, 'state.txt'), 'one');
  const top = gitTop(repo);
  const statDir = tmpDir();
  const { fingerprint } = require('../src/cache');
  const f = () => fingerprint({ cwd: repo, top, argv: ['x'], extraFiles: ['state.txt'], statDir }).key;
  const k1 = f();
  fs.writeFileSync(path.join(repo, 'state.txt'), 'two');
  assert.notEqual(f(), k1);
});

test('the stat cache does not hide edits (same size, new mtime)', async () => {
  const repo = mkRepo();
  const top = gitTop(repo);
  const statDir = tmpDir();
  const { fingerprint } = require('../src/cache');
  const f = () => fingerprint({ cwd: repo, top, argv: ['x'], statDir }).key;
  fs.writeFileSync(path.join(repo, 'a.txt'), 'aaaaa\n');
  const k1 = f();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'bbbbb\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(repo, 'a.txt'), later, later);
  assert.notEqual(f(), k1);
});

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
  assert.equal(new Set([k0, k1, k2, k3, k4]).size, 5);
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

test('repository config cannot make git run helper programs', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const repo = mkRepo();
  const marker = path.join(tmpDir(), 'pwned');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil\n');
  git(repo, 'config', 'diff.evil.textconv', `sh -c 'touch ${marker}'`);
  git(repo, 'config', 'diff.external', `sh -c 'touch ${marker}'`);
  fs.appendFileSync(path.join(repo, 'a.txt'), 'change\n');
  await key(repo);
  assert.equal(fs.existsSync(marker), false, 'textconv/external diff helper must not run');
});

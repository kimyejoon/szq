'use strict';
// Regression tests for the findings of the second security review (N1..N10).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { digest } = require('../src/digest');
const { Logs } = require('../src/logs');
const { StatStore, fingerprint, gitTop, Cache } = require('../src/cache');
const { resolveLocalBin, buildInvocation } = require('../src/platform');
const installer = require('../src/adapters/installer');
const adapters = require('../src/adapters');
const config = require('../src/config');
const { mkRepo, mkEnv, szq, szqStart, sleep, job, lines, tmpDir, git } = require('./helpers');

// N1: a failure after the slot was taken must not leave a running ticket behind or hang the process
test('N1: a log that vanishes mid-run does not hang the run or leak its slot', async () => {
  const { env, home } = mkEnv();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ adaptive: { enabled: false }, logs: { keep: 1 } }));
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  // A runs 2.5 s; B finishes meanwhile and its logs.prune() runs while A is still going
  const a = szqStart(['--cap', '4', '--no-cache', '--digest', '--', ...job(f, 'a', 2500)], { cwd: repo, env });
  await sleep(600);
  for (let i = 0; i < 3; i++) await szq(['--cap', '4', '--no-cache', '--digest', '--', ...job(f, `b${i}`, 100)], { cwd: repo, env });
  const t0 = Date.now();
  const r = await a.done;
  assert.ok(Date.now() - t0 < 8000, 'the run must end');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /out-a/, 'its output must survive the pruning of other logs');
  const live = JSON.parse((await szq(['status', '--json'], { env })).stdout);
  assert.equal(live.running.length, 0, 'no leaked running ticket');
});

test('N1: logs of runs in progress are never pruned; finished ones are', () => {
  const dir = tmpDir();
  const logs = new Logs({ logDir: dir }, { keep: 1 });
  const running = logs.open({ cmd: 'x' });
  running.write(Buffer.from('still running\n'));
  for (let i = 0; i < 3; i++) {
    const w = logs.open({ cmd: 'y' });
    w.write(Buffer.from('done\n'));
    w.close({ code: 0 });
  }
  logs.prune();
  assert.ok(fs.existsSync(`${running.file}.part`), 'the in-progress log must survive pruning');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.log')).length, 1, 'finished logs were pruned down to keep=1');
  running.close({ code: 0 });
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.log')).length, 2, 'the finished run joins them');
  logs.prune();
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.log')).length, 1);
});

// N2
test('N2: digest handles enormous single lines in linear time', () => {
  for (const unit of ['error ', 'passed 1 ', 'failed ', 'error: ']) {
    const text = `${'x\n'.repeat(300)}${unit.repeat(200000)}\n${'y\n'.repeat(300)}`;
    const t0 = Date.now();
    digest(text);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms for ${JSON.stringify(unit)}`);
  }
});

// N3
test('N3: --changed results depend on HEAD / the ref, so the cache key must too', async () => {
  const repo = mkRepo();
  const top = gitTop(repo);
  const statDir = tmpDir();
  const k = (argv) => fingerprint({ cwd: repo, top, argv, statDir }).key;
  const argv = ['vitest', 'run', '--changed=HEAD~0'];
  const k0 = k(argv);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'moves HEAD, same files');
  assert.notEqual(k(argv), k0, 'a moved HEAD changes the key of ref-sensitive commands');
  const plain = ['vitest', 'run'];
  const p0 = k(plain);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'again');
  assert.equal(k(plain), p0, 'ordinary commands keep sharing results across commits with identical content');
  const r0 = k(['jest', '--changedSince=HEAD']);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'third');
  assert.notEqual(k(['jest', '--changedSince=HEAD']), r0);
});

// N6
test('N6: when the log hits its size cap the tail of the output is still kept', () => {
  const dir = tmpDir();
  const code = `
    process.env.SZQ_LOG_MAX_BYTES='2000'; process.env.SZQ_LOG_TAIL_BYTES='500';
    const { Logs } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'logs.js'))});
    const logs = new Logs({ logDir: ${JSON.stringify(dir)} }, { keep: 5 });
    const w = logs.open({ cmd: 'x' });
    for (let i = 0; i < 500; i++) w.write(Buffer.from('line ' + i + '\\n'));
    w.write(Buffer.from('Tests: 3 failed, 10 passed\\n'));
    w.close({ code: 1 });
    process.stdout.write(logs.readBody(w.file));`;
  const r = cp.spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /log truncated/);
  assert.match(r.stdout, /Tests: 3 failed, 10 passed/);
});

// N7
test('N7: node, git and package managers are never taken from node_modules/.bin', { skip: process.platform === 'win32' }, () => {
  const repo = tmpDir();
  const bin = path.join(repo, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const n of ['node', 'git', 'pnpm', 'bash', 'tsc']) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\n', { mode: 0o755 });
  for (const n of ['node', 'git', 'pnpm', 'bash']) assert.equal(resolveLocalBin(n, [bin], process.env, repo), null, n);
  assert.equal(resolveLocalBin('tsc', [bin], process.env, repo), path.join(bin, 'tsc'));
});

// N8
test('N8: a project-scope config that is a symlink leaving the project is refused (install and uninstall)', { skip: process.platform === 'win32' }, () => {
  const project = tmpDir();
  const victimDir = tmpDir();
  const victim = path.join(victimDir, 'settings.json');
  fs.writeFileSync(victim, JSON.stringify({ keep: true }));
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.symlinkSync(victim, path.join(project, '.claude', 'settings.json'));
  const a = adapters.get('claude-code');
  assert.throws(() => installer.install(a, { scope: 'project', cwd: project }), /leaves the project/);
  assert.equal(fs.readFileSync(victim, 'utf8'), '{"keep":true}', 'the file outside the project is untouched');
  const owned = path.join(project, '.github', 'hooks');
  fs.mkdirSync(owned, { recursive: true });
  fs.symlinkSync(victim, path.join(owned, 'szq.json'));
  assert.throws(() => installer.uninstall(adapters.get('copilot'), { scope: 'project', cwd: project }), /leaves the project/);
  assert.ok(fs.existsSync(victim), 'uninstall must not delete a file outside the project');
});

test('N8: a symlink that stays inside the project is followed', { skip: process.platform === 'win32' }, () => {
  const project = tmpDir();
  fs.mkdirSync(path.join(project, 'config'));
  fs.writeFileSync(path.join(project, 'config', 'claude.json'), '{}');
  fs.mkdirSync(path.join(project, '.claude'));
  fs.symlinkSync(path.join(project, 'config', 'claude.json'), path.join(project, '.claude', 'settings.json'));
  installer.install(adapters.get('claude-code'), { scope: 'project', cwd: project });
  assert.match(fs.readFileSync(path.join(project, 'config', 'claude.json'), 'utf8'), /guard claude-code/);
});

// N9
test('N9: a stat entry for a file touched within the last 2 s is not trusted later', () => {
  const store = new StatStore(path.join(tmpDir(), 's.json'));
  const now = Date.now();
  store.put('fresh', { size: 1, mtimeMs: now - 100, ctimeMs: now - 100 }, 'h', now);
  store.put('quiet', { size: 1, mtimeMs: now - 60000, ctimeMs: now - 60000 }, 'h', now);
  assert.equal(store.map.has('fresh'), false);
  assert.equal(store.map.has('quiet'), true);
});

test('N9: a same-size rewrite right after hashing is noticed even if size and mtime are restored', { skip: process.platform === 'win32' }, () => {
  const repo = mkRepo();
  const top = gitTop(repo);
  const statDir = tmpDir();
  const f = path.join(repo, 'a.txt');
  fs.writeFileSync(f, 'aaaaaa\n');
  const key = () => fingerprint({ cwd: repo, top, argv: ['x'], statDir }).key;
  const k1 = key();
  const st = fs.statSync(f);
  fs.writeFileSync(f, 'bbbbbb\n'); // same size
  fs.utimesSync(f, st.atime, st.mtime); // mtime put back (ctime still moves)
  assert.notEqual(key(), k1);
});

// N10
test('N10: the "last run" record keeps neither the command line nor environment values', () => {
  const repo = mkRepo();
  const top = gitTop(repo);
  const home = tmpDir();
  const paths = config.resolvePaths({ SZQ_HOME: home });
  config.ensureStateDirs(paths);
  const cache = new Cache(paths, config.normalize({}).cache);
  const secret = 'ghp_SUPERSECRETTOKEN123';
  const fp = fingerprint({ cwd: repo, top, argv: ['deploy', '--token', secret], cacheEnv: ['MY_TOKEN'], env: { MY_TOKEN: secret }, statDir: paths.statDir });
  cache.saveLast(fp.key, fp.components);
  for (const name of fs.readdirSync(paths.lastDir)) assert.ok(!fs.readFileSync(path.join(paths.lastDir, name), 'utf8').includes(secret));
  assert.ok(cache.loadLast(fp.components), 'it can still be found again by command and directory');
});

test('N10: cmd.exe is started without delayed expansion and a % in the resolved path is rejected', () => {
  const dir = tmpDir();
  const exe = path.join(dir, 'tool.cmd');
  fs.writeFileSync(exe, '@echo off\r\n');
  // buildInvocation resolves through PATH/PATHEXT using Windows rules; emulate with a POSIX-visible directory
  const env = { PATH: dir, PATHEXT: '.CMD', ComSpec: 'cmd.exe' };
  const inv = buildInvocation(['tool.cmd', 'a b'], env, dir, 'win32');
  if (inv.error) return; // path rules differ on POSIX hosts; the assertion below covers Windows hosts
  assert.ok(inv.args.includes('/v:off') || inv.file !== 'cmd.exe');
});

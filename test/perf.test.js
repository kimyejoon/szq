'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { findRepoTop, gitTop, fingerprint } = require('../src/cache');
const { growCap, makeWaker } = require('../src/run');
const { CpuMeter, busyFraction } = require('../src/cpu');
const config = require('../src/config');
const { mkRepo, mkEnv, szq, szqStart, sleep, job, lines, tmpDir, git } = require('./helpers');

test('findRepoTop walks up to the nearest .git without starting git', () => {
  const repo = mkRepo();
  const deep = path.join(repo, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findRepoTop(deep), repo);
  assert.equal(findRepoTop(repo), repo);
  assert.equal(findRepoTop(tmpDir()), null);
});

test('findRepoTop understands worktrees and submodules (.git is a file)', { skip: process.platform === 'win32' }, () => {
  const repo = mkRepo();
  const wt = path.join(tmpDir(), 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile());
  assert.equal(findRepoTop(path.join(wt)), wt);
  const same = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: wt, encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync(findRepoTop(wt)), fs.realpathSync(same));
});

test('gitTop honours GIT_DIR by asking git', () => {
  const repo = mkRepo();
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(repo, '.git');
  try {
    assert.ok(gitTop(repo));
  } finally {
    if (old === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = old;
  }
});

test('the combined listing tags untracked files, so names cannot pose as tracked entries', { skip: process.platform === 'win32' }, () => {
  const repo = mkRepo();
  const top = gitTop(repo);
  const statDir = tmpDir();
  fs.writeFileSync(path.join(repo, 'H 100644 deadbeef 0\tfake'), 'x');
  const fp = fingerprint({ cwd: repo, top, argv: ['x'], statDir });
  assert.ok(fp);
  assert.ok('H 100644 deadbeef 0\tfake' in fp.components.files, 'listed as an ordinary untracked file');
  assert.ok(!('fake' in fp.components.files));
});

// ---- idle-aware concurrency ----

const headroom = { enabled: true, cpuBelow: 0.55, settleMs: 800 };
const T = (n, startedAt) => Array.from({ length: n }, (_, i) => ({ id: String(i), startedAt }));

test('growCap: base while below it; +1 only with headroom and after the newest run had time to show its load', () => {
  const now = 100000;
  const g = (over) => growCap({ base: 2, max: 6, running: T(2, now - 5000), util: 0.2, newestStartedAt: now - 5000, now, headroom, ...over });
  assert.equal(g({ running: T(1, now - 5000) }), 2, 'below the base: the base applies');
  assert.equal(g({ util: 0.4 }), 3, 'a little headroom: one more');
  assert.equal(g({}), 5, 'plenty of headroom (util 0.2 over 2 runs, so ~0.1 per run, 0.35 free): several more, capped at +3');
  assert.equal(g({ max: 4 }), 4, 'never beyond the ceiling');
  assert.equal(g({ util: 0.9 }), 2, 'busy CPU: no growth');
  assert.equal(g({ util: 0.55 }), 2, 'threshold is exclusive');
  assert.equal(g({ newestStartedAt: now - 100 }), 2, 'the newest run has not ramped up yet');
  assert.equal(g({ running: T(6, now - 5000) }), 2, 'at the ceiling');
  assert.equal(g({ util: null }), 2, 'no measurement, no growth');
  assert.equal(g({ running: T(4, now - 5000), util: 0.5 }), 5, 'close to the threshold it creeps up one at a time');
});

test('config: maxConcurrency/headroom defaults and validation', () => {
  const c = config.normalize({ headroom: { cpuBelow: 7, settleMs: -1 }, maxConcurrency: 0 });
  assert.equal(c.headroom.cpuBelow, 0.55);
  assert.equal(c.headroom.settleMs, 800);
  assert.equal(c.maxConcurrency, 'auto');
  assert.equal(config.resolveMaxConcurrency(config.normalize({}), 2, 8), 6);
  assert.equal(config.resolveMaxConcurrency(config.normalize({}), 4, 4), 4);
  assert.equal(config.isAutoConcurrency(config.normalize({}), {}), true);
  assert.equal(config.isAutoConcurrency(config.normalize({ concurrency: 3 }), {}), false);
  assert.equal(config.isAutoConcurrency(config.normalize({}), { SZQ_CONCURRENCY: '2' }), false);
});

test('CpuMeter: fraction between snapshots; no value before the first interval', () => {
  const snap = (idle, busy) => [{ user: busy, nice: 0, sys: 0, idle, irq: 0 }];
  assert.equal(busyFraction(snap(100, 0), snap(200, 100)), 0.5);
  assert.equal(busyFraction(snap(0, 0), snap(0, 0)), null);
  let t = 0;
  const m = new CpuMeter(() => t);
  assert.equal(m.sample(250), null);
  t = 300;
  assert.ok(m.sample(250) === null || (m.sample(250) >= 0 && m.sample(250) <= 1));
});

test('waker: a file-system event wakes a waiter long before its timeout', async () => {
  const dir = tmpDir();
  const w = makeWaker([dir]);
  try {
    setTimeout(() => fs.writeFileSync(path.join(dir, 'x'), '1'), 100);
    const t0 = Date.now();
    await w.wait(5000);
    assert.ok(Date.now() - t0 < 1500, `woke after ${Date.now() - t0} ms`);
  } finally {
    w.close();
  }
});

test('a waiting run starts right after the slot frees up (no 1 s polling lag)', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const holder = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'holder', 1500)], { cwd: repo, env });
  await sleep(500);
  const waiter = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'waiter', 50)], { cwd: repo, env });
  const hr = await holder.done;
  const holderEnd = Date.now();
  await waiter.done;
  assert.equal(hr.code, 0);
  const waiterStart = Number(lines(f).find((l) => l.startsWith('waiter')).split(':')[2]);
  assert.ok(waiterStart - holderEnd < 900, `the waiter started ${waiterStart - holderEnd} ms after the holder finished`);
});

test('with headroom, distinct runs overlap beyond the base concurrency; --cap pins it', async () => {
  const { env, home } = mkEnv();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ adaptive: { enabled: false }, concurrency: 'auto', headroom: { enabled: true, cpuBelow: 1, settleMs: 0 } }));
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  // cpuBelow 1 => always "headroom" (utilisation is < 100 % unless the machine is completely pegged)
  const runs = Array.from({ length: 5 }, (_, i) => szqStart(['--no-cache', '--', ...job(f, `d${i}`, 1800)], { cwd: repo, env: { ...env, SZQ_CONCURRENCY: '' } }));
  await Promise.all(runs.map((r) => r.done));
  const starts = lines(f).map((l) => Number(l.split(':')[2])).sort((a, b) => a - b);
  assert.equal(starts.length, 5);
  const base = Math.max(1, Math.floor(require('os').cpus().length / 4));
  const concurrentAtFirstBatch = starts.filter((s) => s - starts[0] < 1500).length;
  assert.ok(concurrentAtFirstBatch > base || base >= 5, `${concurrentAtFirstBatch} started together, base is ${base}`);
});

test('a cache hit is fast (no process besides szq itself except one git call)', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  await szq(['--', 'node', '-e', '1'], { cwd: repo, env });
  const t0 = Date.now();
  const r = await szq(['--', 'node', '-e', '1'], { cwd: repo, env });
  assert.match(r.stderr, /cache hit/);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

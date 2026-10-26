'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkRepo, mkEnv, szq, szqStart, sleep, job, lines, tmpDir } = require('./helpers');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

test('runs a command and passes its exit code and output through', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const ok = await szq(['--', 'node', '-e', 'console.log("hi")'], { cwd: repo, env });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /hi/);
  const bad = await szq(['--no-cache', '--', 'node', '-e', 'process.exit(7)'], { cwd: repo, env });
  assert.equal(bad.code, 7);
});

test('a second identical run is served from the cache', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const first = await szq(['--', ...job(f, 'A')], { cwd: repo, env });
  const second = await szq(['--', ...job(f, 'A')], { cwd: repo, env });
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(lines(f).length, 1);
  assert.match(second.stdout, /out-A/);
  assert.match(second.stderr, /cache hit/);
});

test('changing the working tree invalidates the cache', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  await szq(['--', ...job(f, 'A')], { cwd: repo, env });
  fs.appendFileSync(path.join(repo, 'a.txt'), 'edit\n');
  await szq(['--', ...job(f, 'A')], { cwd: repo, env });
  assert.equal(lines(f).length, 2);
});

test('--no-cache neither reads nor writes', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  await szq(['--no-cache', '--', ...job(f, 'A')], { cwd: repo, env });
  await szq(['--no-cache', '--', ...job(f, 'A')], { cwd: repo, env });
  assert.equal(lines(f).length, 2);
});

test('outside a git repository nothing is cached', async () => {
  const { env, home } = mkEnv();
  const dir = tmpDir();
  const f = path.join(home, 'runs.txt');
  await szq(['--', ...job(f, 'A')], { cwd: dir, env });
  await szq(['--', ...job(f, 'A')], { cwd: dir, env });
  assert.equal(lines(f).length, 2);
});

test('identical concurrent requests execute once and share the result', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const runs = Array.from({ length: 6 }, () => szqStart(['--cap', '4', '--', ...job(f, 'same', 1500)], { cwd: repo, env }));
  const results = await Promise.all(runs.map((r) => r.done));
  for (const r of results) {
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /out-same/);
  }
  assert.equal(lines(f).length, 1, 'the command must have run exactly once');
});

test('identical concurrent requests share a failure too, --no-cache re-runs', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const runs = Array.from({ length: 3 }, () => szqStart(['--cap', '3', '--', ...job(f, 'bad', 800, 2)], { cwd: repo, env }));
  const results = await Promise.all(runs.map((r) => r.done));
  for (const r of results) assert.equal(r.code, 2);
  assert.equal(lines(f).length, 1);
  await szq(['--no-cache', '--', ...job(f, 'bad', 0, 2)], { cwd: repo, env });
  assert.equal(lines(f).length, 2);
});

test('distinct requests are serialised by the concurrency cap', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const n = 3;
  const runs = Array.from({ length: n }, (_, i) => szqStart(['--cap', '1', '--no-cache', '--', ...job(f, `j${i}`, 700)], { cwd: repo, env }));
  await Promise.all(runs.map((r) => r.done));
  const starts = lines(f)
    .map((l) => Number(l.split(':')[2]))
    .sort((a, b) => a - b);
  assert.equal(starts.length, n);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 600, `run ${i} started only ${starts[i] - starts[i - 1]}ms after the previous one`);
  }
});

test('with cap 2 two distinct requests overlap', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const runs = [0, 1].map((i) => szqStart(['--cap', '2', '--no-cache', '--', ...job(f, `p${i}`, 1200)], { cwd: repo, env }));
  await Promise.all(runs.map((r) => r.done));
  const starts = lines(f).map((l) => Number(l.split(':')[2]));
  assert.equal(starts.length, 2);
  assert.ok(Math.abs(starts[0] - starts[1]) < 1000, 'both should start together');
});

test('a run that exceeds --timeout is killed (exit 124)', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const t0 = Date.now();
  const r = await szq(['--timeout', '1', '--no-cache', '--', ...job(f, 'slow', 30000)], { cwd: repo, env });
  assert.equal(r.code, 124, r.stderr);
  assert.ok(Date.now() - t0 < 15000);
});

test('waiting longer than --max-wait gives up with exit 75', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const holder = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'holder', 6000)], { cwd: repo, env });
  await sleep(800);
  const r = await szq(['--cap', '1', '--no-cache', '--max-wait', '1', '--', ...job(f, 'late', 0)], { cwd: repo, env });
  assert.equal(r.code, 75, r.stderr);
  holder.child.kill();
  await holder.done;
});

test('watch mode is refused', async () => {
  const { env } = mkEnv();
  const r = await szq(['vitest', '--watch'], { cwd: mkRepo(), env });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /watch mode/);
});

test('a nested szq call inside a running job does not deadlock', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const entry = path.resolve(__dirname, '..', 'bin', 'szq.js');
  const inner = `const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(entry)},'node','-e','console.log("inner-ok")'],{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status)`;
  const r = await szq(['--cap', '1', '--no-cache', '--', 'node', '-e', inner], { cwd: repo, env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /inner-ok/);
});

test('node_modules/.bin of the project is on PATH for the command', { skip: process.platform === 'win32' }, async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const bin = path.join(repo, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'mytool'), '#!/bin/sh\necho from-local-bin\n', { mode: 0o755 });
  const r = await szq(['--no-cache', '--', 'mytool'], { cwd: repo, env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /from-local-bin/);
});

test('if the leader dies, a follower takes over and runs the command', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const leader = szqStart(['--cap', '1', '--', ...job(f, 'L', 2500)], { cwd: repo, env });
  await sleep(1200);
  const follower = szqStart(['--cap', '1', '--', ...job(f, 'L', 2500)], { cwd: repo, env });
  await sleep(1200);
  assert.equal(lines(f).length, 1, 'follower must not run while the leader is alive');
  leader.child.kill('SIGKILL');
  await leader.done;
  const r = await follower.done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lines(f).length, 2, 'follower ran the command itself after the leader died');
});

test('the orphaned child of a killed owner is reaped by the next run', { skip: process.platform === 'win32' }, async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const owner = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'orphan', 60000)], { cwd: repo, env });
  await sleep(1500);
  const childPid = Number(lines(f)[0].split(':')[1]);
  assert.ok(alive(childPid));
  owner.child.kill('SIGKILL');
  await owner.done;
  assert.ok(alive(childPid), 'child survives its owner (that is the orphan)');
  const next = await szq(['--cap', '1', '--no-cache', '--', 'node', '-e', 'console.log("next")'], { cwd: repo, env });
  assert.equal(next.code, 0, next.stderr);
  await sleep(500);
  assert.equal(alive(childPid), false, 'orphan must be terminated');
});

test('szq status lists running and waiting work', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const a = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'a', 3000)], { cwd: repo, env });
  await sleep(700);
  const b = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'b', 100)], { cwd: repo, env });
  await sleep(700);
  const st = await szq(['status'], { cwd: repo, env: { ...env, SZQ_CONCURRENCY: '1' } });
  assert.match(st.stdout, /running 1\/1/);
  assert.match(st.stdout, /waiting 1/);
  await Promise.all([a.done, b.done]);
});

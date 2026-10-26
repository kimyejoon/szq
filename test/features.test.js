'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { admit } = require('../src/queue');
const run = require('../src/run');
const platform = require('../src/platform');
const config = require('../src/config');
const { mkRepo, mkEnv, szq, szqStart, sleep, job, lines, tmpDir } = require('./helpers');

const T = (id, extra = {}) => ({ id, prio: 1, exclusive: false, ...extra });

// ---------- admission rules (pure) ----------

test('admit: FIFO within a priority, higher priority first', () => {
  const { admitted, order } = admit([T('1'), T('2'), T('3', { prio: 2 })], [], 2);
  assert.deepEqual(order.map((t) => t.id), ['3', '1', '2']);
  assert.deepEqual([...admitted].sort(), ['1', '3']);
});

test('admit: respects running runs and the cap', () => {
  assert.equal(admit([T('1')], [T('r1'), T('r2')], 2).admitted.size, 0);
  assert.equal(admit([T('1'), T('2')], [T('r1')], 2).admitted.size, 1);
});

test('admit: an exclusive run needs an empty machine and blocks everyone behind it', () => {
  assert.equal(admit([T('x', { exclusive: true })], [T('r1')], 4).admitted.size, 0);
  const idle = admit([T('x', { exclusive: true }), T('y')], [], 4);
  assert.deepEqual([...idle.admitted], ['x']);
  const behind = admit([T('a'), T('x', { exclusive: true }), T('y')], [T('r1')], 4);
  assert.deepEqual([...behind.admitted], ['a'], 'runs ahead of the exclusive one may start, the ones behind wait');
  assert.equal(admit([T('a')], [T('r1', { exclusive: true })], 4).admitted.size, 0, 'nobody starts while an exclusive run is active');
});

// ---------- helpers that are pure ----------

test('effectiveCap backs off to 1 when the machine is busy, never below 1, never on a single slot', () => {
  const adaptive = { enabled: true, loadPerCpu: 1.5 };
  assert.deepEqual(run.effectiveCap(4, adaptive, [2, 0, 0], 8), { cap: 4, throttled: false, load: 2 });
  const busy = run.effectiveCap(4, adaptive, [40, 0, 0], 8);
  assert.equal(busy.cap, process.platform === 'win32' ? 4 : 1);
  assert.equal(run.effectiveCap(1, adaptive, [40, 0, 0], 8).throttled, false);
  assert.equal(run.effectiveCap(4, { enabled: false, loadPerCpu: 1.5 }, [40, 0, 0], 8).cap, 4);
});

test('isWatch refuses real watch modes only (jest -w is --maxWorkers)', () => {
  assert.equal(run.isWatch(['vitest', '--watch']), true);
  assert.equal(run.isWatch(['vitest', '-w']), true);
  assert.equal(run.isWatch(['tsc', '-w']), true);
  assert.equal(run.isWatch(['vitest', 'watch']), true);
  assert.equal(run.isWatch(['jest', '--watchAll']), true);
  assert.equal(run.isWatch(['jest', '-w', '2']), false);
  assert.equal(run.isWatch(['pnpm', '-w', 'test']), false);
  assert.equal(run.isWatch(['vitest', 'run', '--watch=false']), false);
  assert.equal(run.isWatch(['node', 'watch.js']), false);
});

test('wantDigest: explicit flags win, auto needs an agent environment and a non-terminal stdout', () => {
  const cfg = (digest) => ({ output: { digest } });
  assert.equal(run.wantDigest({ digest: true }, cfg('never'), {}, true), true);
  assert.equal(run.wantDigest({ digest: false }, cfg('always'), {}, false), false);
  assert.equal(run.wantDigest({}, cfg('always'), {}, true), true);
  assert.equal(run.wantDigest({}, cfg('never'), { CLAUDECODE: '1' }, false), false);
  assert.equal(run.wantDigest({}, cfg('auto'), { CLAUDECODE: '1' }, false), true);
  assert.equal(run.wantDigest({}, cfg('auto'), { CLAUDECODE: '1' }, true), false);
  assert.equal(run.wantDigest({}, cfg('auto'), {}, false), false, 'plain pipes are never rewritten');
});

// ---------- process safety ----------

test('killTree never signals pid 0, 1 or negative numbers', { skip: process.platform === 'win32' }, () => {
  const calls = [];
  const real = process.kill;
  process.kill = (...a) => {
    calls.push(a);
    return true;
  };
  try {
    for (const pid of [0, 1, -1, -90314, NaN, 1.5, 2 ** 40, '123', null, undefined]) platform.killTree(pid, 'SIGKILL');
  } finally {
    process.kill = real;
  }
  assert.deepEqual(calls, []);
});

test('killTree of a vanished group does not fall back to signalling the bare pid', { skip: process.platform === 'win32' }, () => {
  const calls = [];
  const real = process.kill;
  process.kill = (pid, sig) => {
    calls.push([pid, sig]);
    const e = new Error('no such process');
    e.code = 'ESRCH';
    throw e;
  };
  try {
    platform.killTree(54321, 'SIGTERM');
  } finally {
    process.kill = real;
  }
  assert.deepEqual(calls, [[-54321, 'SIGTERM']]);
});

function writeTicket(home, t) {
  const id = `${String(Date.now()).padStart(13, '0')}-${t.pid}-test`;
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'queue', `${id}.json`), JSON.stringify({ id, host: os.hostname(), cwd: '/x', cmd: 'x', key: null, state: 'running', createdAt: Date.now(), ...t }));
}

test('reaping a dead ticket never kills an unrelated process that reused its recorded child pid', { skip: process.platform === 'win32' }, async () => {
  const { env, home } = mkEnv();
  const bystander = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore' });
  bystander.unref();
  await sleep(300);
  try {
    // dead owner; childPid is alive but the recorded start time does not match -> must be left alone
    writeTicket(home, { pid: 2 ** 22 + 77, childPid: bystander.pid, childStart: 'Thu Jan  1 00:00:00 1970' });
    // a ticket without any start time is never trusted either
    writeTicket(home, { pid: 2 ** 22 + 78, childPid: bystander.pid });
    // absurd pids
    writeTicket(home, { pid: 2 ** 22 + 79, childPid: 1, childStart: 'x' });
    writeTicket(home, { pid: 2 ** 22 + 80, childPid: -1, childStart: 'x' });
    const r = await szq(['status'], { env });
    assert.equal(r.code, 0, r.stderr);
    await sleep(3500);
    assert.equal(platform.pidAlive(bystander.pid), true, 'the bystander must survive');
    assert.equal(fs.readdirSync(path.join(home, 'queue')).filter((n) => n.endsWith('.json')).length, 0, 'dead tickets are removed');
  } finally {
    try {
      process.kill(-bystander.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('positive control: an orphan whose start time matches IS terminated', { skip: process.platform === 'win32' }, async () => {
  const { env, home } = mkEnv();
  const orphan = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  await sleep(300);
  try {
    writeTicket(home, { pid: 2 ** 22 + 91, childPid: orphan.pid, childStart: platform.procStart(orphan.pid) });
    await szq(['status'], { env });
    await sleep(500);
    assert.equal(platform.pidAlive(orphan.pid), false);
  } finally {
    try {
      process.kill(-orphan.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('garbage tickets and stale mutexes do not break the queue', async () => {
  const { env, home } = mkEnv();
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'queue', '0000000000000-1-bad.json'), JSON.stringify({ id: 'x', pid: 5, cwd: 42, cmd: ['not', 'a', 'string'], state: 'running' }));
  fs.writeFileSync(path.join(home, 'queue', '0000000000001-1-bad2.json'), '{ nope');
  fs.mkdirSync(path.join(home, 'claim.lock'));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(home, 'claim.lock'), old, old);
  const repo = mkRepo();
  const r = await szq(['--no-cache', '--', 'node', '-e', 'console.log("ok")'], { cwd: repo, env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});

// ---------- scheduling ----------

test('priority: a high-priority run overtakes waiting normal runs', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const holder = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'holder', 2500)], { cwd: repo, env });
  await sleep(700);
  const normal = szqStart(['--cap', '1', '--no-cache', '--', ...job(f, 'normal', 100)], { cwd: repo, env });
  await sleep(300);
  const high = szqStart(['--cap', '1', '--no-cache', '--priority', 'high', '--', ...job(f, 'high', 100)], { cwd: repo, env });
  await Promise.all([holder.done, normal.done, high.done]);
  const order = lines(f).map((l) => l.split(':')[0]);
  assert.deepEqual(order, ['holder', 'high', 'normal']);
});

test('exclusive: runs alone, blocks later arrivals, waits for running work', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const a = szqStart(['--cap', '3', '--no-cache', '--', ...job(f, 'a', 2000)], { cwd: repo, env });
  await sleep(700);
  const x = szqStart(['--cap', '3', '--no-cache', '--exclusive', '--', ...job(f, 'x', 1200)], { cwd: repo, env });
  await sleep(300);
  const c = szqStart(['--cap', '3', '--no-cache', '--', ...job(f, 'c', 100)], { cwd: repo, env });
  await Promise.all([a.done, x.done, c.done]);
  const events = lines(f).map((l) => ({ id: l.split(':')[0], t: Number(l.split(':')[2]) }));
  const at = (id) => events.find((e) => e.id === id).t;
  assert.ok(at('x') - at('a') >= 1700, 'x starts only after a finished');
  assert.ok(at('c') - at('x') >= 1000, 'c starts only after x finished');
});

// ---------- supervision ----------

test('--stall kills a run that goes quiet (exit 125) but not one that keeps talking', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const quiet = await szq(['--no-cache', '--stall', '1', '--', 'node', '-e', 'setTimeout(()=>{},30000)'], { cwd: repo, env });
  assert.equal(quiet.code, 125, quiet.stderr);
  const chatty = await szq(
    ['--no-cache', '--stall', '2', '--', 'node', '-e', 'let n=0;const i=setInterval(()=>{console.log(++n);if(n>=5){clearInterval(i)}},500)'],
    { cwd: repo, env },
  );
  assert.equal(chatty.code, 0, chatty.stderr);
});

test('--max-mem kills a run whose process tree is too large (exit 126)', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const { env } = mkEnv({ SZQ_MEM_INTERVAL_MS: '300' });
  const repo = mkRepo();
  const r = await szq(['--no-cache', '--max-mem', '60', '--', 'node', '-e', 'const b=Buffer.alloc(200*1024*1024,1);setTimeout(()=>{console.log(b.length)},20000)'], { cwd: repo, env });
  assert.equal(r.code, 126, r.stderr);
  assert.match(r.stderr, /MiB/);
});

test('a result is not cached when the working tree changed while the command ran', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const f = path.join(home, 'runs.txt');
  const mutate = `require('fs').appendFileSync(${JSON.stringify(path.join(repo, 'a.txt'))},'changed during the run\\n');require('fs').appendFileSync(${JSON.stringify(f)},'run:1:1\\n')`;
  const r1 = await szq(['--', 'node', '-e', mutate], { cwd: repo, env });
  assert.equal(r1.code, 0, r1.stderr);
  assert.match(r1.stderr, /files changed while the command was running/);
  const cacheDir = path.join(home, 'cache');
  assert.equal(fs.readdirSync(cacheDir).length, 0, 'nothing may be cached');
});

// ---------- output digest and logs ----------

const noisy = `for(let i=0;i<2000;i++)console.log('line '+i);console.log('src/a.ts(1,1): error TS2322: boom');for(let i=0;i<500;i++)console.log('more '+i)`;

test('--digest prints a short digest, keeps the full output in a log, and `szq logs show` returns all of it', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const r = await szq(['--digest', '--', 'node', '-e', noisy], { cwd: repo, env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /error TS2322: boom/);
  assert.match(r.stdout, /digest: showing \d+ of 2501 lines/);
  const logPath = /Full output: (.+)\n/.exec(r.stdout)[1];
  assert.ok(fs.existsSync(logPath));
  assert.ok(r.stdout.split('\n').length < 300);
  const shown = await szq(['logs', 'show'], { cwd: repo, env });
  assert.equal(shown.stdout.split('\n').filter((l) => l.startsWith('line ')).length, 2000);
  const listed = await szq(['logs'], { cwd: repo, env });
  assert.match(listed.stdout, /exit 0/);
});

test('--no-digest streams everything; a cached replay can be digested', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const full = await szq(['--no-digest', '--', 'node', '-e', noisy], { cwd: repo, env });
  assert.equal(full.stdout.split('\n').filter((l) => l.startsWith('line ')).length, 2000);
  const replay = await szq(['--digest', '--', 'node', '-e', noisy], { cwd: repo, env });
  assert.match(replay.stderr, /cache hit/);
  assert.match(replay.stdout, /digest: showing/);
  assert.ok(replay.stdout.length < full.stdout.length / 5);
});

test('digest is on by default only for agents (CLAUDECODE) writing to a pipe', async () => {
  const { env } = mkEnv({ CLAUDECODE: '1' });
  const repo = mkRepo();
  const r = await szq(['--no-cache', '--', 'node', '-e', noisy], { cwd: repo, env });
  assert.match(r.stdout, /digest: showing/);
  const { env: plain } = mkEnv();
  delete plain.CLAUDECODE;
  const r2 = await szq(['--no-cache', '--', 'node', '-e', noisy], { cwd: repo, env: plain });
  assert.doesNotMatch(r2.stdout, /digest: showing/);
});

test('only the newest logs are kept', async () => {
  const { env, home } = mkEnv();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ adaptive: { enabled: false }, logs: { keep: 2 } }));
  const repo = mkRepo();
  for (let i = 0; i < 4; i++) await szq(['--no-cache', '--', 'node', '-e', `console.log(${i})`], { cwd: repo, env });
  assert.equal(fs.readdirSync(path.join(home, 'logs')).filter((n) => n.endsWith('.log')).length, 2);
});

// ---------- stats ----------

test('szq stats reports the work that caching saved', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  await szq(['--', 'node', '-e', 'setTimeout(()=>console.log(1),1200)'], { cwd: repo, env });
  await szq(['--', 'node', '-e', 'setTimeout(()=>console.log(1),1200)'], { cwd: repo, env });
  const s = JSON.parse((await szq(['stats', '--json'], { env })).stdout);
  assert.equal(s.executed, 1);
  assert.equal(s.hits, 1);
  assert.ok(s.savedMs >= 1000, `savedMs ${s.savedMs}`);
  const text = (await szq(['stats'], { env })).stdout;
  assert.match(text, /served from cache: 1/);
});

// ---------- cli odds and ends ----------

test('status --json is machine readable', async () => {
  const { env } = mkEnv();
  const j = JSON.parse((await szq(['status', '--json'], { env })).stdout);
  assert.ok(Array.isArray(j.running) && Array.isArray(j.waiting) && Array.isArray(j.joined));
  assert.equal(typeof j.concurrency, 'number');
});

test('config set refuses to touch a broken file and writes a backup otherwise', async () => {
  const { env, home } = mkEnv();
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, '{"concurrency": 3, "cache": {"env": ["X"]},}');
  const bad = await szq(['config', 'set', 'lang', '"ko"'], { env });
  assert.equal(bad.code, 64);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"concurrency": 3, "cache": {"env": ["X"]},}', 'untouched');
  fs.writeFileSync(file, '{"concurrency": 3}');
  const ok = await szq(['config', 'set', 'lang', '"ko"'], { env });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { concurrency: 3, lang: 'ko' });
  assert.ok(fs.readdirSync(home).some((n) => n.startsWith('config.json.szq-backup-')));
});

test('shim install never overwrites foreign files, skips dangerous names, and uninstall only removes real shims', { skip: process.platform === 'win32' }, async () => {
  const { env, home } = mkEnv();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ adaptive: { enabled: false }, guard: { commands: ['tsc', 'node', 'jest'] } }));
  const dir = path.join(tmpDir(), 'bin');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'jest'), 'my own jest wrapper\n');
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'line one\n# szq run-shim\nnot a shim\n');
  cp.execFileSync('mkfifo', [path.join(dir, 'fifo')]);
  const i = await szq(['shim', 'install', '--dir', dir], { env });
  assert.match(i.stdout, /skipped: jest/);
  assert.match(i.stdout, /skipped: node/);
  assert.equal(fs.readFileSync(path.join(dir, 'jest'), 'utf8'), 'my own jest wrapper\n');
  assert.ok(fs.existsSync(path.join(dir, 'tsc')));
  const u = await szq(['shim', 'uninstall', '--dir', dir], { env });
  assert.equal(u.code, 0, u.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'jest')), 'foreign file stays');
  assert.equal(fs.existsSync(path.join(dir, 'tsc')), false);
});

test('local node_modules/.bin tools win for the command word only; PATH is not modified', { skip: process.platform === 'win32' }, async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const bin = path.join(repo, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'mytool'), '#!/bin/sh\necho local-mytool\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho PLANTED-NODE\n', { mode: 0o755 });
  const tool = await szq(['--no-cache', '--', 'mytool'], { cwd: repo, env });
  assert.match(tool.stdout, /local-mytool/);
  // a planted `node` in the repository must not shadow the real one used by the child's own PATH lookups
  const viaPath = await szq(['--no-cache', '--', process.execPath, '-e', "console.log(require('child_process').spawnSync('node',['-p','1'],{encoding:'utf8'}).stdout.trim())"], { cwd: repo, env });
  assert.equal(viaPath.stdout.trim(), '1');
});

test('config: state directory permission problems are reported, not ignored', { skip: process.platform === 'win32' }, async () => {
  const { env, home } = mkEnv();
  fs.chmodSync(home, 0o777);
  const r = await szq(['--no-cache', '--', 'node', '-v'], { cwd: mkRepo(), env });
  assert.equal(r.code, 70);
  assert.match(r.stderr, /unsafe state directory/);
  assert.ok(config);
});

// ---------- leader election must not depend on arrival order ----------

test('leaderOf: an already running ticket wins over arrival order, otherwise the oldest waiting one leads', () => {
  const { Queue } = require('../src/queue');
  const mk = (id, state, key = 'K') => ({ id, state, key });
  const older = mk('0001', 'waiting');
  const younger = mk('0002', 'running');
  assert.equal(Queue.leaderOf(older, [older, younger]), younger, 'the older ticket follows a younger one that already runs');
  assert.equal(Queue.leaderOf(younger, [older, younger]), null, 'a run that has started follows nobody');
});

test('leaderOf: waiting tickets follow the oldest; different keys and null keys never follow', () => {
  const { Queue } = require('../src/queue');
  const a = { id: '1', state: 'waiting', key: 'K' };
  const b = { id: '2', state: 'waiting', key: 'K' };
  const c = { id: '3', state: 'waiting', key: 'OTHER' };
  const d = { id: '4', state: 'waiting', key: null };
  assert.equal(Queue.leaderOf(a, [a, b, c, d]), null);
  assert.equal(Queue.leaderOf(b, [a, b, c, d]), a);
  assert.equal(Queue.leaderOf(c, [a, b, c, d]), null);
  assert.equal(Queue.leaderOf(d, [a, b, c, d]), null);
});

test('identical requests that arrive in a scrambled order still execute exactly once (stress)', async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  for (let round = 0; round < 5; round++) {
    const f = path.join(home, `runs-${round}.txt`);
    const runs = Array.from({ length: 8 }, () => szqStart(['--cap', '4', '--', ...job(f, 'same', 1200)], { cwd: repo, env: { ...env, SZQ_CACHE_SALT: `round-${round}` } }));
    const res = await Promise.all(runs.map((r) => r.done));
    for (const r of res) assert.equal(r.code, 0, r.stderr);
    assert.equal(lines(f).length, 1, `round ${round}: the command must run exactly once`);
  }
});

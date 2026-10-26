'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const cp = require('child_process');

// Control the precise boundary between the cache lookup and the slot claim. Each probe runs in a
// separate process, with real temporary git/state directories and a real child command.
function probe(scenario) {
  const root = path.resolve(__dirname, '..');
  const source = `
    delete process.env.SZQ_ACTIVE;
    const fs = require('fs'), path = require('path');
    const root = ${JSON.stringify(root)}, scenario = ${JSON.stringify(scenario)};
    const { mkRepo, mkEnv, lines } = require(path.join(root, 'test/helpers'));
    const { Queue } = require(path.join(root, 'src/queue'));
    const cacheMod = require(path.join(root, 'src/cache'));
    const config = require(path.join(root, 'src/config'));
    const { home, env } = mkEnv();
    const repo = mkRepo();
    const ctx = { config: config.normalize({ adaptive: { enabled: false } }), paths: config.resolvePaths(env) };
    config.ensureStateDirs(ctx.paths);
    const cache = new cacheMod.Cache(ctx.paths, ctx.config.cache);
    const originalFingerprint = cacheMod.fingerprint;
    let fingerprints = 0;
    cacheMod.fingerprint = (args) => {
      fingerprints++;
      return scenario === 'unavailable' && fingerprints > 1 ? null : originalFingerprint(args);
    };
    const { run } = require(path.join(root, 'src/run'));
    const claim = Queue.prototype.tryClaim;
    const create = Queue.prototype.create;
    const update = Queue.prototype.update;
    let injected = false, childKey, expectedKey;
    Queue.prototype.create = function(...args) {
      const me = create.apply(this, args);
      if (scenario === 'created-stale') {
        injected = true;
        cache.write(me.t.key, { code: 0, cmd: 'node', ms: 1,
          chunks: [[1, Buffer.from('result-for-old-tree\\n').toString('base64')]] });
        fs.writeFileSync(path.join(repo, 'a.txt'), 'new-tree\\n');
      }
      return me;
    };
    Queue.prototype.update = function(me, patch) {
      if (patch.childPid) childKey = me.t.key;
      return update.call(this, me, patch);
    };
    Queue.prototype.tryClaim = function(me, cap) {
      if (!injected) {
        injected = true;
        if (scenario === 'race' || scenario === 'stale') {
          cache.write(me.t.key, { code: 0, cmd: 'node', ms: 1,
            chunks: [[1, Buffer.from('result-for-old-tree\\n').toString('base64')]] });
        }
        if (scenario !== 'race') {
          fs.writeFileSync(path.join(repo, 'a.txt'), 'new-tree\\n');
          return { ok: false, following: true, leader: { pid: process.pid, cwd: repo } };
        }
      }
      return claim.call(this, me, cap);
    };
    const marker = path.join(home, 'executions');
    const argv = [process.execPath, '-e',
      'const fs=require("fs");fs.appendFileSync(' + JSON.stringify(marker) + ',"ran"+String.fromCharCode(10));console.log(fs.readFileSync("a.txt","utf8").trim())'];
    process.chdir(repo);
    run({ opts: { cap: 1, digest: false }, argv, ctx }).then(code => {
      expectedKey = originalFingerprint({ cwd: repo, top: repo, argv, statDir: ctx.paths.statDir }).key;
      console.log('PROBE ' + JSON.stringify({ code, executions: lines(marker).length, childKey, expectedKey,
        tickets: fs.readdirSync(ctx.paths.queueDir).length, cacheEntries: fs.readdirSync(ctx.paths.cacheDir).length }));
    }).catch(e => { console.error(e); process.exitCode = 1; });
  `;
  return new Promise((resolve, reject) => {
    // Includes Node startup and a temporary git repository under parallel CI load.
    // These are correctness probes; performance bounds live in perf.test.js.
    cp.execFile(process.execPath, ['-e', source], { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\ncode=${error.code} signal=${error.signal} killed=${error.killed}\n${stdout}\n${stderr}`));
      const match = /^PROBE (.+)$/m.exec(stdout);
      if (!match) return reject(new Error(`missing result: ${stdout}\n${stderr}`));
      resolve({ ...JSON.parse(match[1]), stdout, stderr });
    });
  });
}

test('a result published between cache lookup and slot claim prevents a duplicate execution', async () => {
  const r = await probe('race');
  assert.equal(r.code, 0);
  assert.equal(r.executions, 0, r.stdout);
  assert.match(r.stdout, /result-for-old-tree/);
  assert.equal(r.tickets, 0);
});

test('a follower revalidates the tree before replaying a result received while waiting', async () => {
  const r = await probe('stale');
  assert.equal(r.code, 0);
  assert.equal(r.executions, 1, r.stdout);
  assert.match(r.stdout, /^new-tree$/m);
  assert.doesNotMatch(r.stdout, /result-for-old-tree/);
  assert.equal(r.childKey, r.expectedKey);
  assert.equal(r.tickets, 0);
});

test('a result arriving during ticket creation is revalidated before the first wait', async () => {
  const r = await probe('created-stale');
  assert.equal(r.code, 0);
  assert.equal(r.executions, 1);
  assert.match(r.stdout, /^new-tree$/m);
  assert.doesNotMatch(r.stdout, /result-for-old-tree/);
  assert.equal(r.childKey, r.expectedKey);
  assert.equal(r.tickets, 0);
});

test('a changed request re-enters admission with its new key before starting', async () => {
  const r = await probe('rekey');
  assert.equal(r.code, 0);
  assert.equal(r.executions, 1);
  assert.equal(r.childKey, r.expectedKey);
  assert.equal(r.tickets, 0);
});

test('an unavailable refreshed fingerprint clears the old sharing key', async () => {
  const r = await probe('unavailable');
  assert.equal(r.code, 0);
  assert.equal(r.executions, 1);
  assert.equal(r.childKey, null);
  assert.equal(r.cacheEntries, 0);
  assert.equal(r.tickets, 0);
});

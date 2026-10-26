'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { tmpDir } = require('./helpers');

// Load an isolated Queue with the Windows mkdir failure injected. The lock and
// owner file still use the real filesystem; only retries use a virtual clock.
function fixture(platform, failures, code = 'EPERM') {
  const filename = path.resolve(__dirname, '../src/queue.js');
  const realRequire = createRequire(filename);
  const claimDir = path.join(tmpDir(), 'claim.lock');
  const error = Object.assign(new Error('injected mkdir failure'), { code });
  let attempts = 0;
  let elapsed = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process: { platform, pid: process.pid }, Date: { now: () => elapsed },
    require(name) {
      if (name === 'fs') return { ...fs, mkdirSync(dir, opts) {
        assert.equal(dir, claimDir);
        if (++attempts <= failures) throw error;
        return fs.mkdirSync(dir, opts);
      } };
      if (name === './platform') return { ...realRequire(name), sleepSync: (ms) => { elapsed += ms; } };
      return realRequire(name);
    },
  }, { filename });
  return {
    queue: new module.exports.Queue({ claimDir }), claimDir, error,
    attempts: () => attempts, elapsed: () => elapsed,
  };
}

test('a transient Windows EPERM retries and enters only after acquiring the mutex', () => {
  const f = fixture('win32', 2);
  let calls = 0;
  assert.equal(f.queue.withClaim(() => {
    calls++;
    assert.equal(f.attempts(), 3);
    assert.ok(fs.readFileSync(path.join(f.claimDir, 'owner'), 'utf8'));
    return 'claimed';
  }), 'claimed');
  assert.equal(calls, 1);
  assert.equal(f.elapsed(), 80);
  assert.equal(fs.existsSync(f.claimDir), false, 'the acquired lock is released');
});

test('persistent Windows EPERM is bounded and never enters the critical section', () => {
  const f = fixture('win32', Infinity);
  assert.throws(() => f.queue.withClaim(() => assert.fail('must not enter')), (e) => e === f.error);
  assert.equal(f.attempts(), 26);
  assert.equal(f.elapsed(), 1000);
  assert.equal(fs.existsSync(f.claimDir), false);
});

for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EACCES']]) {
  test(`${platform} ${code} is propagated without retry or admission`, () => {
    const f = fixture(platform, Infinity, code);
    assert.throws(() => f.queue.withClaim(() => assert.fail('must not enter')), (e) => e === f.error);
    assert.equal(f.attempts(), 1);
    assert.equal(f.elapsed(), 0);
  });
}

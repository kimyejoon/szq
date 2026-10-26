'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const { tmpDir } = require('./helpers');

test('defaults are returned for garbage input', () => {
  const c = cfg.normalize('nonsense');
  assert.equal(c.concurrency, 'auto');
  assert.equal(c.cache.enabled, true);
  assert.deepEqual(c.guard.commands, ['tsc', 'vitest', 'jest']);
});

test('bad types fall back, good values are kept', () => {
  const c = cfg.normalize({
    concurrency: 3,
    timeoutSec: -5,
    cache: { enabled: false, env: ['NODE_ENV', 'bad name', 7], successTtlHours: 'x' },
    guard: { commands: ['pytest', '../evil', 'ok-name'], scripts: [] },
    unknown: true,
  });
  assert.equal(c.concurrency, 3);
  assert.equal(c.timeoutSec, 900);
  assert.equal(c.cache.enabled, false);
  assert.deepEqual(c.cache.env, ['NODE_ENV']);
  assert.equal(c.cache.successTtlHours, 24);
  assert.deepEqual(c.guard.commands, ['pytest', 'ok-name']);
  assert.deepEqual(c.guard.scripts, ['test', 'typecheck']);
  assert.equal(c.unknown, undefined);
});

test('auto concurrency is cpus/4, at least 1; env wins', () => {
  assert.equal(cfg.resolveConcurrency(cfg.normalize({}), {}, 8), 2);
  assert.equal(cfg.resolveConcurrency(cfg.normalize({}), {}, 2), 1);
  assert.equal(cfg.resolveConcurrency(cfg.normalize({ concurrency: 5 }), {}, 8), 5);
  assert.equal(cfg.resolveConcurrency(cfg.normalize({ concurrency: 5 }), { SZQ_CONCURRENCY: '3' }, 8), 3);
  assert.equal(cfg.resolveConcurrency(cfg.normalize({}), { SZQ_CONCURRENCY: 'zero' }, 8), 2);
});

test('SZQ_HOME and SZQ_CONFIG override locations', () => {
  const p = cfg.resolvePaths({ SZQ_HOME: '/x/state', SZQ_CONFIG: '/x/c.json' }, '/home/u');
  assert.equal(p.stateDir, path.resolve('/x/state'));
  assert.equal(p.configFile, path.resolve('/x/c.json'));
  assert.equal(p.queueDir, path.join(path.resolve('/x/state'), 'queue'));
});

test('setDotted refuses prototype pollution', () => {
  const o = {};
  assert.throws(() => cfg.setDotted(o, '__proto__.polluted', 1));
  assert.throws(() => cfg.setDotted(o, 'a.constructor.b', 1));
  cfg.setDotted(o, 'cache.enabled', false);
  assert.deepEqual(o, { cache: { enabled: false } });
  assert.equal({}.polluted, undefined);
});

test('ensureDir creates a private directory and rejects group-writable ones', { skip: process.platform === 'win32' }, () => {
  const base = tmpDir();
  const d = path.join(base, 'state');
  cfg.ensureDir(d);
  assert.equal(fs.statSync(d).mode & 0o077, 0);
  fs.chmodSync(d, 0o777);
  assert.throws(() => cfg.ensureDir(d), /writable/);
});

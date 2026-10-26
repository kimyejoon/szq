'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const stats = require('../src/stats');
const { tmpDir } = require('./helpers');

test('summary counts executions, cache hits and shared runs and the work they avoided', () => {
  const file = path.join(tmpDir(), 'stats.jsonl');
  stats.record(file, { k: 'run', cmd: 'tsc', ms: 60000, code: 0 });
  stats.record(file, { k: 'hit', cmd: 'tsc', saved: 60000 });
  stats.record(file, { k: 'hit', cmd: 'tsc', saved: 60000 });
  stats.record(file, { k: 'share', cmd: 'vitest', saved: 30000, waited: 10000 });
  const s = stats.summarize(file, 7);
  assert.equal(s.runs, 4);
  assert.equal(s.executed, 1);
  assert.equal(s.hits, 2);
  assert.equal(s.shared, 1);
  assert.equal(s.savedMs, 150000);
  assert.equal(s.waitedMs, 10000);
  assert.equal(s.byCmd.tsc.hits, 2);
});

test('events older than the window are ignored, torn lines are skipped', () => {
  const file = path.join(tmpDir(), 'stats.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ t: Date.now() - 30 * 86400000, k: 'hit', cmd: 'x', saved: 1 })}\n{"t":\n${JSON.stringify({ t: Date.now(), k: 'hit', cmd: 'x', saved: 5 })}\n`);
  const s = stats.summarize(file, 7);
  assert.equal(s.hits, 1);
  assert.equal(s.savedMs, 5);
});

test('the file is rotated instead of growing without bound', () => {
  const file = path.join(tmpDir(), 'stats.jsonl');
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 10));
  stats.record(file, { k: 'run', cmd: 'a', ms: 1 });
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(file).size < 1000);
});

test('a missing or unwritable stats file never throws', () => {
  assert.doesNotThrow(() => stats.record(path.join(tmpDir(), 'no', 'such', 'dir', 'f.jsonl'), { k: 'run' }));
  assert.equal(stats.summarize(path.join(tmpDir(), 'nope.jsonl')).runs, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const platform = require('../src/platform');
const { szq, mkEnv, mkRepo, job, tmpDir } = require('./helpers');
const path = require('path');

test('cmdUnsafeChars reports quote and percent only', () => {
  assert.deepEqual(platform.cmdUnsafeChars(['a b', '&|<>']), []);
  assert.deepEqual(platform.cmdUnsafeChars(['say "hi"', '100%']).sort(), ['"', '%']);
});

test('quoteForCmd quotes arguments cmd.exe would split or interpret', () => {
  assert.equal(platform.quoteForCmd('plain'), 'plain');
  assert.equal(platform.quoteForCmd('a b'), '"a b"');
  assert.equal(platform.quoteForCmd('a&b'), '"a&b"');
  assert.equal(platform.quoteForCmd(''), '""');
});

test('POSIX invocation is a plain argv spawn (no shell)', { skip: process.platform === 'win32' }, () => {
  const inv = platform.buildInvocation(['tsc', '--noEmit', 'a b; rm -rf /'], process.env, process.cwd());
  assert.equal(inv.file, 'tsc');
  assert.deepEqual(inv.args, ['--noEmit', 'a b; rm -rf /']);
});

test('pidAlive', () => {
  assert.equal(platform.pidAlive(process.pid), true);
  assert.equal(platform.pidAlive(0), false);
  assert.equal(platform.pidAlive(2 ** 22 + 12345), false);
});

test('findOnPath resolves a command on PATH', () => {
  const found = platform.findOnPath('node', process.env, process.cwd());
  assert.ok(found, 'node should be on PATH');
});

// ---- Windows only: .cmd shims go through cmd.exe ----
test('Windows: runs npm (a .cmd shim) and rejects unsafe arguments', { skip: process.platform !== 'win32' }, async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const ok = await szq(['--no-cache', '--', 'npm', '--version'], { cwd: repo, env });
  assert.equal(ok.code, 0, ok.stderr);
  const bad = await szq(['--no-cache', '--', 'npm', 'run', 'x%PATH%'], { cwd: repo, env });
  assert.equal(bad.code, 64);
});

test('Windows: process tree is killed on timeout', { skip: process.platform !== 'win32' }, async () => {
  const { env, home } = mkEnv();
  const repo = mkRepo();
  const log = path.join(tmpDir(), 'log.txt');
  const r = await szq(['--no-cache', '--timeout', '1', '--', ...job(log, 'slow', 30000)], { cwd: repo, env });
  assert.equal(r.code, 124, r.stderr);
  assert.ok(home);
});

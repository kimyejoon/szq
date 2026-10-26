'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const { szq, mkEnv, mkRepo, tmpDir } = require('./helpers');

test('--version and --help', async () => {
  const { env } = mkEnv();
  assert.equal((await szq(['--version'], { env })).stdout.trim(), pkg.version);
  const h = await szq(['--help'], { env });
  assert.match(h.stdout, /szq \[options\]/);
  assert.equal(h.code, 0);
});

test('no command is a usage error', async () => {
  const { env } = mkEnv();
  const r = await szq(['--no-cache'], { env });
  assert.equal(r.code, 64);
});

test('config set/show round-trips and rejects prototype keys', async () => {
  const { env } = mkEnv();
  assert.equal((await szq(['config', 'set', 'concurrency', '3'], { env })).code, 0);
  assert.equal((await szq(['config', 'set', 'cache.enabled', 'false'], { env })).code, 0);
  const shown = JSON.parse((await szq(['config', 'show'], { env })).stdout);
  assert.equal(shown.concurrency, 3);
  assert.equal(shown.cache.enabled, false);
  assert.equal((await szq(['config', 'set', '__proto__.x', '1'], { env })).code, 64);
});

test('a broken config file falls back to defaults with a warning', async () => {
  const { env, home } = mkEnv();
  fs.writeFileSync(path.join(home, 'config.json'), '{ oops');
  const r = await szq(['config', 'show'], { env });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /using defaults/);
});

test('cache clear removes entries', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  await szq(['--', 'node', '-e', '1'], { cwd: repo, env });
  const c = await szq(['cache', 'clear'], { env });
  assert.match(c.stdout, /removed 1 cache entries/);
});

test('rules prints a block in both languages', async () => {
  const { env } = mkEnv();
  assert.match((await szq(['rules', '--lang', 'en'], { env })).stdout, /Shared queue/);
  assert.match((await szq(['rules', '--lang', 'ko'], { env })).stdout, /공용 큐/);
});

test('doctor runs and reports hooks', async () => {
  const { env } = mkEnv();
  const r = await szq(['doctor'], { env });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hook claude-code/);
});

test('Korean messages when SZQ_LANG=ko', async () => {
  const { env } = mkEnv({ SZQ_LANG: 'ko' });
  const r = await szq(['vitest', '--watch'], { cwd: mkRepo(), env });
  assert.match(r.stderr, /watch 모드/);
});

test('shims route through the queue and are removable', { skip: process.platform === 'win32' }, async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const dir = path.join(tmpDir(), 'shims');
  const i = await szq(['shim', 'install', '--dir', dir], { env });
  assert.equal(i.code, 0, i.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'tsc')));
  // a fake "tsc" later on PATH proves the shim finds the real tool and not itself
  const realDir = path.join(tmpDir(), 'real');
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, 'tsc'), '#!/bin/sh\necho real-tsc "$@"\n', { mode: 0o755 });
  const pathEnv = [dir, realDir, process.env.PATH].join(path.delimiter);
  const { spawnSync } = require('child_process');
  const r = spawnSync('tsc', ['--noEmit'], { cwd: repo, env: { ...env, PATH: pathEnv }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /real-tsc --noEmit/);
  assert.match(r.stderr, /exit code 0/);
  const u = await szq(['shim', 'uninstall', '--dir', dir], { env });
  assert.match(u.stdout, /removed \d+ shim/);
  assert.equal(fs.existsSync(path.join(dir, 'tsc')), false);
});

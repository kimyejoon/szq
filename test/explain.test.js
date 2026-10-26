'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { diffComponents } = require('../src/explain');
const { szq, mkEnv, mkRepo } = require('./helpers');

const base = { treeHash: 'aaa', files: { 'a.ts': '1', 'b.ts': '2' }, node: 'v22', platform: 'linux', env: [], extras: {}, salt: '' };

test('names modified, added and removed files', () => {
  const cur = { ...base, treeHash: 'bbb', files: { 'a.ts': '9', 'c.ts': '3' } };
  const r = diffComponents(base, cur).join('\n');
  assert.match(r, /modified 1 file\(s\): a\.ts/);
  assert.match(r, /added 1 file\(s\): c\.ts/);
  assert.match(r, /removed 1 file\(s\): b\.ts/);
});

test('reports environment, node and extra-file changes', () => {
  const cur = { ...base, node: 'v24', env: [['CI', '1']], extras: { 'node_modules/.modules.yaml': 'x' } };
  const r = diffComponents({ ...base, env: [['CI', null]] }, cur).join('\n');
  assert.match(r, /Node version changed: v22 -> v24/);
  assert.match(r, /cache\.env changed: CI/);
  assert.match(r, /extraFiles entry changed/);
});

test('lists are shortened', () => {
  const files = {};
  for (let i = 0; i < 30; i++) files[`f${i}.ts`] = String(i);
  const cur = { ...base, treeHash: 'zzz', files: Object.fromEntries(Object.keys(files).map((k) => [k, 'changed'])) };
  const r = diffComponents({ ...base, files }, cur).join('\n');
  assert.match(r, /\(\+22 more\)/);
});

test('szq explain walks through never-run, same, changed and cached', async () => {
  const { env } = mkEnv();
  const repo = mkRepo();
  const cmd = ['node', '-e', 'console.log(1)'];
  let r = await szq(['explain', '--', ...cmd], { cwd: repo, env });
  assert.match(r.stdout, /never run before/);
  await szq(['--', ...cmd], { cwd: repo, env });
  r = await szq(['explain', '--', ...cmd], { cwd: repo, env });
  assert.match(r.stdout, /same fingerprint/);
  assert.match(r.stdout, /served from the cache/);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  fs.appendFileSync(path.join(repo, 'a.txt'), 'edit\n');
  r = await szq(['explain', '--', ...cmd], { cwd: repo, env });
  assert.match(r.stdout, /different from the last run/);
  assert.match(r.stdout, /modified 1 file\(s\): a\.txt/);
  assert.match(r.stdout, /added 1 file\(s\): new\.txt/);
  assert.match(r.stdout, /no fresh cached result/);
});

test('szq explain outside a git repository says so', async () => {
  const { env } = mkEnv();
  const r = await szq(['explain', '--', 'node', '-v'], { cwd: require('os').tmpdir(), env });
  assert.match(r.stdout, /not inside a git repository/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { szq, mkEnv } = require('./helpers');

const ev = {
  claude: (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() }),
  cursor: (command) => JSON.stringify({ command, cwd: process.cwd() }),
  gemini: (command) => JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command } }),
};

test('claude-code guard denies a direct tsc and teaches the szq form', async () => {
  const { env } = mkEnv();
  const r = await szq(['guard', 'claude-code'], { env, input: ev.claude('tsc --noEmit') });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /szq/);
  assert.match(out.permissionDecisionReason, /szq --digest tsc --noEmit/);
});

test('claude-code guard stays silent for ordinary commands and for szq itself', async () => {
  const { env } = mkEnv();
  for (const c of ['git status', 'szq tsc --noEmit', 'git commit -m "tsc"']) {
    const r = await szq(['guard', 'claude-code'], { env, input: ev.claude(c) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', c);
  }
});

test('cursor guard answers explicit JSON both ways', async () => {
  const { env } = mkEnv();
  const deny = await szq(['guard', 'cursor'], { env, input: ev.cursor('pnpm test') });
  assert.equal(JSON.parse(deny.stdout).permission, 'deny');
  const allow = await szq(['guard', 'cursor'], { env, input: ev.cursor('ls') });
  assert.deepEqual(JSON.parse(allow.stdout), { permission: 'allow' });
});

test('gemini guard blocks with exit code 2 and stderr', async () => {
  const { env } = mkEnv();
  const deny = await szq(['guard', 'gemini'], { env, input: ev.gemini('npx vitest run') });
  assert.equal(deny.code, 2);
  assert.match(deny.stderr, /szq/);
  const allow = await szq(['guard', 'gemini'], { env, input: ev.gemini('ls') });
  assert.equal(allow.code, 0);
});

test('fail-open: garbage stdin, unknown adapter, empty input never block', async () => {
  const { env } = mkEnv();
  for (const input of ['not json', '', '{}', '[]']) {
    const r = await szq(['guard', 'claude-code'], { env, input });
    assert.equal(r.code, 0, input);
    assert.equal(r.stdout, '', input);
  }
  const unknown = await szq(['guard', 'no-such-agent'], { env, input: ev.claude('tsc') });
  assert.equal(unknown.code, 0);
  assert.equal(unknown.stdout, '');
});

test('a DISABLE file in the state directory turns the guard off', async () => {
  const { env, home } = mkEnv();
  fs.writeFileSync(path.join(home, 'DISABLE'), '');
  const r = await szq(['guard', 'claude-code'], { env, input: ev.claude('tsc') });
  assert.equal(r.stdout, '');
});

test('guard honours the configured command list', async () => {
  const { env, home } = mkEnv();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ adaptive: { enabled: false }, guard: { commands: ['pytest'], scripts: ['check'] } }));
  assert.equal((await szq(['guard', 'claude-code'], { env, input: ev.claude('pytest -q') })).stdout.includes('deny'), true);
  assert.equal((await szq(['guard', 'claude-code'], { env, input: ev.claude('pnpm run check') })).stdout.includes('deny'), true);
  assert.equal((await szq(['guard', 'claude-code'], { env, input: ev.claude('tsc') })).stdout, '');
});

test('guard answers well under a second (it runs before every shell call)', async () => {
  const { env } = mkEnv();
  const t0 = Date.now();
  await szq(['guard', 'claude-code'], { env, input: ev.claude('git status') });
  assert.ok(Date.now() - t0 < 2000);
});

test('hook install/uninstall via the CLI into a temporary HOME', async () => {
  const { env, home } = mkEnv();
  const fakeHome = path.join(home, 'h');
  fs.mkdirSync(fakeHome);
  const e = { ...env, HOME: fakeHome, USERPROFILE: fakeHome };
  const i = await szq(['hook', 'install', 'claude-code'], { env: e });
  assert.equal(i.code, 0, i.stderr);
  const file = path.join(fakeHome, '.claude', 'settings.json');
  assert.match(fs.readFileSync(file, 'utf8'), /guard claude-code/);
  const s = await szq(['hook', 'status', 'claude-code'], { env: e });
  assert.match(s.stdout, /installed/);
  const u = await szq(['hook', 'uninstall', 'claude-code'], { env: e });
  assert.equal(u.code, 0);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /guard claude-code/);
  const bad = await szq(['hook', 'install', 'nope'], { env: e });
  assert.equal(bad.code, 64);
});

test('windsurf and copilot guards answer in their own dialect', async () => {
  const { env } = mkEnv();
  const ws = await szq(['guard', 'windsurf'], { env, input: JSON.stringify({ agent_action_name: 'pre_run_command', tool_info: { command_line: 'pnpm test', cwd: '/x' } }) });
  assert.equal(ws.code, 2);
  assert.match(ws.stderr, /szq/);
  const cp = await szq(['guard', 'copilot'], { env, input: JSON.stringify({ toolName: 'bash', toolArgs: { command: 'vitest run' } }) });
  assert.equal(cp.code, 0);
  assert.equal(JSON.parse(cp.stdout).permissionDecision, 'deny');
});

test('cursor keeps answering "allow" in JSON even when something goes wrong after the adapter is known', async () => {
  const { env } = mkEnv();
  const r = await szq(['guard', 'cursor'], { env, input: 'not json' });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { permission: 'allow' });
});

test('a relative --adapter-module is ignored by the guard (fail-open, nothing is loaded)', async () => {
  const { env, home } = mkEnv();
  const evil = path.join(home, 'evil.js');
  const marker = path.join(home, 'pwned');
  fs.writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); module.exports = {};`);
  const r = await szq(['guard', 'mine', '--adapter-module', './evil.js'], { cwd: home, env, input: ev.claude('tsc') });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(marker), false, 'a repository-relative module must not be executed');
});

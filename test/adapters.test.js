'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const adapters = require('../src/adapters');
const installer = require('../src/adapters/installer');
const { tmpDir } = require('./helpers');

const ids = adapters.list().map((a) => a.id);

test('built-in adapters satisfy the adapter contract', () => {
  assert.deepEqual(ids.sort(), ['claude-code', 'codex', 'cursor', 'gemini']);
  for (const a of adapters.list()) adapters.validate(a, a.id);
});

test('claude-code: parse + answer formats', () => {
  const a = adapters.get('claude-code');
  assert.deepEqual(a.parse('{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/x"}'), { command: 'ls', cwd: '/x' });
  assert.equal(a.parse('{"tool_name":"Read","tool_input":{"file_path":"x"}}'), null);
  const d = a.deny('nope');
  assert.equal(d.exitCode, 0);
  assert.deepEqual(JSON.parse(d.stdout).hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' });
  assert.equal(a.allow().stdout, '');
});

test('codex: parse + answer formats', () => {
  const a = adapters.get('codex');
  assert.deepEqual(a.parse('{"tool_name":"Bash","tool_input":{"command":"ls"}}'), { command: 'ls', cwd: undefined });
  assert.equal(JSON.parse(a.deny('x').stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('cursor: answers allow explicitly (invalid JSON would block) and denies with agent_message', () => {
  const a = adapters.get('cursor');
  assert.deepEqual(a.parse('{"command":"ls","cwd":"/x"}'), { command: 'ls', cwd: '/x' });
  assert.deepEqual(JSON.parse(a.allow().stdout), { permission: 'allow' });
  const d = JSON.parse(a.deny('why').stdout);
  assert.equal(d.permission, 'deny');
  assert.equal(d.agent_message, 'why');
});

test('gemini: denies with exit code 2 and the reason on stderr', () => {
  const a = adapters.get('gemini');
  assert.deepEqual(a.parse('{"tool_name":"run_shell_command","tool_input":{"command":"ls"}}'), { command: 'ls', cwd: undefined });
  assert.equal(a.parse('{"tool_name":"read_file","tool_input":{}}'), null);
  const d = a.deny('blocked');
  assert.equal(d.exitCode, 2);
  assert.equal(d.stderr, 'blocked');
  assert.equal(a.maturity, 'experimental');
});

for (const id of ['claude-code', 'codex', 'cursor', 'gemini']) {
  test(`${id}: install is idempotent, preserves other settings, backs up, and uninstall removes only ours`, () => {
    const adapter = adapters.get(id);
    const home = tmpDir();
    const file = adapter.target({ scope: 'user', home, cwd: home });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = {
      theme: 'dark',
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
        beforeShellExecution: [{ command: './my-cursor-hook.sh' }],
        BeforeTool: [{ matcher: 'other', hooks: [{ type: 'command', command: 'x' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }],
      },
    };
    fs.writeFileSync(file, JSON.stringify(original));

    const r1 = installer.install(adapter, { home, cwd: home });
    assert.equal(r1.changed, true);
    assert.ok(r1.backup && fs.existsSync(r1.backup), 'a backup of the previous file exists');
    assert.equal(JSON.parse(fs.readFileSync(r1.backup, 'utf8')).theme, 'dark');
    let doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.theme, 'dark');
    assert.deepEqual(doc.hooks.Stop, original.hooks.Stop);
    assert.ok(adapter.has(doc));

    const r2 = installer.install(adapter, { home, cwd: home });
    assert.equal(r2.changed, false, 'second install changes nothing');
    assert.equal(installer.status(adapter, { home, cwd: home }).installed, true);

    const u = installer.uninstall(adapter, { home, cwd: home });
    assert.equal(u.changed, true);
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(adapter.has(doc), false);
    assert.equal(doc.theme, 'dark');
    assert.deepEqual(doc.hooks.Stop, original.hooks.Stop);
    assert.deepEqual(doc.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.equal(installer.uninstall(adapter, { home, cwd: home }).changed, false);
  });
}

test('install into a missing file creates it; uninstall then leaves no empty containers', () => {
  const adapter = adapters.get('claude-code');
  const home = tmpDir();
  const r = installer.install(adapter, { home, cwd: home });
  assert.equal(r.backup, null);
  installer.uninstall(adapter, { home, cwd: home });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), {});
});

test('invalid JSON is never overwritten', () => {
  const adapter = adapters.get('claude-code');
  const home = tmpDir();
  const file = adapter.target({ scope: 'user', home, cwd: home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => installer.install(adapter, { home, cwd: home }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.writeFileSync(file, '[1,2]');
  assert.throws(() => installer.install(adapter, { home, cwd: home }), /JSON object/);
});

test('--dry-run writes nothing', () => {
  const adapter = adapters.get('codex');
  const home = tmpDir();
  const r = installer.install(adapter, { home, cwd: home, dryRun: true });
  assert.ok(r.preview.includes('guard codex'));
  assert.equal(fs.existsSync(r.file), false);
});

test('project scope targets the project directory', () => {
  const dir = tmpDir();
  assert.equal(adapters.get('claude-code').target({ scope: 'project', home: '/h', cwd: dir }), path.join(dir, '.claude', 'settings.json'));
  assert.equal(adapters.get('claude-code').target({ scope: 'local', home: '/h', cwd: dir }), path.join(dir, '.claude', 'settings.local.json'));
  assert.equal(adapters.get('cursor').target({ scope: 'project', home: '/h', cwd: dir }), path.join(dir, '.cursor', 'hooks.json'));
});

test('codex install warns about trust and about inline [hooks] in config.toml', () => {
  const adapter = adapters.get('codex');
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[hooks]\nfoo = 1\n');
  const r = installer.install(adapter, { home, cwd: home });
  assert.ok(r.notes.some((n) => /\/hooks/.test(n)));
  assert.ok(r.notes.some((n) => /inline \[hooks\]/.test(n)));
});

test('external adapters load only from an explicit path and are validated', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'mine.js');
  fs.writeFileSync(file, 'module.exports = { id: "mine" }');
  assert.throws(() => adapters.loadExternal(file), /missing/);
  const good = path.join(dir, 'mine-ok.js');
  fs.writeFileSync(
    good,
    `module.exports = { id: 'mine', parse(){return null}, allow(){return {stdout:'',stderr:'',exitCode:0}}, deny(){return {stdout:'',stderr:'',exitCode:2}}, target(){return ${JSON.stringify(path.join(dir, 's.json'))}}, apply(d){d.x=1;return d}, remove(){return false}, has(d){return !!d.x} };`,
  );
  const a = adapters.loadExternal(good);
  assert.equal(a.id, 'mine');
  const r = installer.install(a, { home: dir, cwd: dir, adapterModule: good });
  assert.ok(r.command.includes('--adapter-module'));
});

test('the generated hook command points at the szq entry script', () => {
  const cmd = installer.hookCommand('claude-code');
  assert.match(cmd, /^node ".*bin[\\/]szq\.js" guard claude-code$/);
  assert.match(installer.hookCommand('cursor', { absoluteNode: true }), new RegExp(`^"${process.execPath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}"`));
});

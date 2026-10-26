'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Entry script that hooks must call. */
function entryPath() {
  return fs.realpathSync(path.resolve(__dirname, '..', '..', 'bin', 'szq.js'));
}

function q(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

/** The shell command line an agent's hook configuration runs. */
function hookCommand(adapterId, { absoluteNode = false, entry = entryPath(), adapterModule } = {}) {
  const node = absoluteNode ? q(process.execPath) : 'node';
  const mod = adapterModule ? ` --adapter-module ${q(adapterModule)}` : '';
  return `${node} ${q(entry)} guard ${adapterId}${mod}`;
}

/** True when a configured command string is one we generated for this adapter. */
function isOurs(command, adapterId) {
  return typeof command === 'string' && /szq/i.test(command) && new RegExp(`\\sguard\\s+${adapterId}(\\s|$)`).test(command);
}

function readJsonStrict(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { doc: {}, existed: false, mode: 0o600 };
    throw e;
  }
  let doc;
  try {
    doc = text.trim() === '' ? {} : JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Refusing to modify it - fix or remove the file first.`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${file} does not contain a JSON object. Refusing to modify it.`);
  }
  return { doc, existed: true, mode: fs.statSync(file).mode & 0o777 };
}

function writeJsonAtomic(file, doc, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.szq-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function resolveTarget(adapter, { scope = 'user', home = os.homedir(), cwd = process.cwd() } = {}) {
  return adapter.target({ scope, home, cwd });
}

/**
 * Install (or refresh) the hook entry. Idempotent: running it twice changes nothing the second time.
 * Never overwrites a file it cannot parse; keeps a timestamped backup of the previous content.
 */
function install(adapter, opts = {}) {
  const file = resolveTarget(adapter, opts);
  const { doc, existed, mode } = readJsonStrict(file);
  const before = JSON.stringify(doc);
  const command = hookCommand(adapter.id, opts);
  adapter.apply(doc, command);
  const changed = JSON.stringify(doc) !== before;
  const notes = adapter.notes ? adapter.notes({ ...opts, file }) : [];
  if (opts.dryRun || !changed) return { file, changed, backup: null, notes, preview: `${JSON.stringify(doc, null, 2)}\n`, command };
  const backup = existed ? backupFile(file) : null;
  writeJsonAtomic(file, doc, mode);
  return { file, changed, backup, notes, command };
}

function uninstall(adapter, opts = {}) {
  const file = resolveTarget(adapter, opts);
  const { doc, existed, mode } = readJsonStrict(file);
  if (!existed) return { file, changed: false, backup: null };
  const changed = adapter.remove(doc);
  if (!changed || opts.dryRun) return { file, changed, backup: null, preview: `${JSON.stringify(doc, null, 2)}\n` };
  const backup = backupFile(file);
  writeJsonAtomic(file, doc, mode);
  return { file, changed, backup };
}

function status(adapter, opts = {}) {
  const file = resolveTarget(adapter, opts);
  try {
    const { doc, existed } = readJsonStrict(file);
    return { file, exists: existed, installed: existed && adapter.has(doc) };
  } catch (e) {
    return { file, exists: true, installed: false, error: e.message };
  }
}

module.exports = { entryPath, hookCommand, isOurs, readJsonStrict, writeJsonAtomic, install, uninstall, status, resolveTarget };

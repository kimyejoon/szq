'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

/** Entry script that hooks must call. */
function entryPath() {
  return fs.realpathSync(path.resolve(__dirname, '..', '..', 'bin', 'szq.js'));
}

/**
 * Quote a path for the shell that will run the hook command.
 * POSIX: single quotes (nothing inside is interpreted). Windows shells (cmd, PowerShell, Git Bash) disagree
 * on quoting, so paths containing any character that one of them treats specially are refused.
 */
function shq(p) {
  const s = String(p);
  if (isWin) {
    if (/["$`%!'&|<>^()\r\n]/.test(s)) throw new Error(`path contains characters that cannot be quoted safely for Windows shells: ${s}`);
    return `"${s}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function nodeWord(absoluteNode) {
  if (!absoluteNode) return 'node';
  // PowerShell would need `&` in front of a quoted program path and cmd.exe cannot have it, so on Windows
  // the absolute path is used only when it needs no quoting.
  if (isWin) return /[\s"$`%!'&|<>^()]/.test(process.execPath) ? 'node' : process.execPath;
  return shq(process.execPath);
}

/** The shell command line an agent's hook configuration runs. */
function hookCommand(adapterId, { absoluteNode = false, entry = entryPath(), adapterModule } = {}) {
  let mod = '';
  if (adapterModule) {
    // pinned to an absolute, symlink-free path NOW: resolving it later against the agent's cwd would
    // let any repository plant a file of that name and have it executed.
    mod = ` --adapter-module ${shq(fs.realpathSync(path.resolve(adapterModule)))}`;
  }
  return `${nodeWord(absoluteNode)} ${shq(entry)} guard ${adapterId}${mod}`;
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

/** Follow a symlinked config file (dotfile managers!) so the link survives and its target is updated. */
function realTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function writeJsonAtomic(file, doc, mode) {
  const real = realTarget(file);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
  fs.renameSync(tmp, real);
}

function backupFile(file) {
  const real = realTarget(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${real}.szq-backup-${stamp}`;
  fs.copyFileSync(real, dest);
  return dest;
}

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where the config lives. For project/local scope a symlinked config file may only point INSIDE the project:
 * a repository could otherwise plant `.claude/settings.json -> ~/somewhere` and have an install (or an uninstall
 * of an owned file) write to, or delete, a file outside the project.
 */
function resolveTarget(adapter, { scope = 'user', home = os.homedir(), cwd = process.cwd() } = {}) {
  const file = adapter.target({ scope, home, cwd });
  if (scope === 'project' || scope === 'local') {
    const real = realTarget(file);
    let root;
    try {
      root = fs.realpathSync(cwd);
    } catch {
      root = path.resolve(cwd);
    }
    if (!within(real, root)) throw new Error(`refusing to use ${file}: it is a symlink that leaves the project (${real})`);
  }
  return file;
}

/**
 * Install (or refresh) the hook entry. Idempotent: running it twice changes nothing the second time.
 * Never overwrites a file it cannot parse; keeps a timestamped backup of the previous content.
 */
function install(adapter, opts = {}) {
  const file = resolveTarget(adapter, opts);
  const { doc, existed, mode } = readJsonStrict(file);
  const before = JSON.stringify(doc);
  const absoluteNode = opts.absoluteNode ?? adapter.preferAbsoluteNode ?? false;
  const command = hookCommand(adapter.id, { ...opts, absoluteNode });
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
  if (adapter.ownsFile && Object.keys(doc).filter((k) => k !== 'version').length === 0) {
    fs.unlinkSync(realTarget(file)); // a file that only ever contained our hook
  } else {
    writeJsonAtomic(file, doc, mode);
  }
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

module.exports = { entryPath, hookCommand, isOurs, shq, readJsonStrict, writeJsonAtomic, install, uninstall, status, resolveTarget };

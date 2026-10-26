'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const isWin = process.platform === 'win32';

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Terminate a process and its descendants.
 * POSIX: the child is started detached, so `-pid` addresses its whole process group.
 * Windows: `taskkill /T` walks the process tree.
 */
function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (isWin) {
    try {
      cp.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------- Windows command resolution ----------

function envGet(env, name) {
  if (!isWin) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/** Find an executable on PATH honouring PATHEXT (Windows). Returns an absolute path or null. */
function findOnPath(command, env, cwd, platform = process.platform) {
  const win = platform === 'win32';
  const pathMod = win ? path.win32 : path.posix;
  const sep = win ? ';' : ':';
  const pathVar = (win ? envGet(env, 'PATH') : env.PATH) || '';
  const exts = win ? (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir ? [''] : pathVar.split(sep).filter(Boolean);
  const hasExt = win && pathMod.extname(command) !== '';
  const candidates = [];
  for (const dir of dirs) {
    const base = hasDir ? pathMod.resolve(cwd || '.', command) : pathMod.join(dir, command);
    if (!win || hasExt) candidates.push(base);
    if (win) for (const ext of exts) candidates.push(base + ext.toLowerCase(), base + ext.toUpperCase());
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const CMD_UNSAFE = /["%]/;
const CMD_QUOTE = /[\s&|<>()^,;=!]/;

/** Characters we refuse to pass through cmd.exe (it re-parses them). */
function cmdUnsafeChars(args) {
  const found = new Set();
  for (const a of args) for (const ch of a) if (CMD_UNSAFE.test(ch)) found.add(ch);
  return [...found];
}

function quoteForCmd(arg) {
  const s = String(arg);
  if (s === '') return '""';
  return CMD_QUOTE.test(s) ? `"${s}"` : s;
}

/**
 * Build the spawn invocation for a command line.
 * POSIX and Windows .exe: spawned directly, no shell, arguments are passed verbatim.
 * Windows .cmd/.bat (pnpm, npm, tsc shims): must go through cmd.exe; arguments containing
 * `"` or `%` are rejected because cmd.exe would re-interpret them.
 */
function buildInvocation(argv, env, cwd, platform = process.platform) {
  const [command, ...args] = argv;
  if (platform !== 'win32') return { file: command, args, options: {} };
  const resolved = findOnPath(command, env, cwd, platform);
  const ext = resolved ? path.win32.extname(resolved).toLowerCase() : '';
  if (resolved && (ext === '.cmd' || ext === '.bat')) {
    const bad = cmdUnsafeChars([command, ...args]);
    if (bad.length) return { error: { code: 'CMD_UNSAFE', chars: bad.join(' ') } };
    const line = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(' ');
    return {
      file: env.ComSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { file: resolved || command, args, options: {} };
}

module.exports = { isWin, pidAlive, killTree, sleepSync, findOnPath, buildInvocation, cmdUnsafeChars, quoteForCmd };

'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const isWin = process.platform === 'win32';

/** A pid we are willing to signal: a real process id, never 0/1 (init/everything) or negative. */
function validPid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid < 2 ** 31;
}

function pidAlive(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Start time of a process as an opaque string, or null when it cannot be determined.
 * Used to tell "the process I started" from "an unrelated process that reused the pid".
 * Not available on Windows (pids are reused aggressively there, so szq never kills by recorded pid).
 */
function procStart(pid) {
  if (isWin || !validPid(pid)) return null;
  try {
    const r = cp.spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 2000,
    });
    const out = r.status === 0 ? r.stdout.trim() : '';
    return out || null;
  } catch {
    return null;
  }
}

function sameProcess(pid, start) {
  return Boolean(start) && procStart(pid) === start;
}

/**
 * Terminate a process and its descendants.
 * POSIX: the child is started detached, so `-pid` addresses its whole process group - and only the group:
 * if the group is gone we do NOT fall back to signalling the bare pid (it may have been reused).
 * Windows: `taskkill /T` walks the process tree.
 */
function killTree(pid, signal = 'SIGTERM') {
  if (!validPid(pid)) return;
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
    /* group already gone */
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Resident memory (KiB) of every process whose process group is `pgid`. POSIX only; null if unavailable. */
function groupRssKiB(pgid) {
  if (isWin || !validPid(pgid)) return null;
  try {
    const r = cp.spawnSync('ps', ['-axo', 'pgid=,rss='], { encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) return null;
    let sum = 0;
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m && Number(m[1]) === pgid) sum += Number(m[2]);
    }
    return sum;
  } catch {
    return null;
  }
}

// ---------- command resolution ----------

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

/**
 * Prefer a project-local executable (node_modules/.bin) for a bare command name.
 * Only the command word is resolved this way - PATH itself is never modified, so tools the command starts
 * itself cannot be shadowed by a binary planted in a repository - and never for interpreters, shells, git or
 * package managers (NEVER_LOCAL).
 */
// Interpreters, shells, git and package managers are never taken from a project directory: a binary committed
// to a repository under one of these names must not replace the tool the user means.
const NEVER_LOCAL = new Set(['node', 'git', 'sh', 'bash', 'zsh', 'env', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'python', 'python3', 'ruby']);

function resolveLocalBin(command, binDirs, env, cwd) {
  if (!command || /[\\/]/.test(command) || binDirs.length === 0) return null;
  if (NEVER_LOCAL.has(String(command).replace(/\.(cmd|exe|ps1|bat)$/i, '').toLowerCase())) return null;
  if (isWin) return findOnPath(command, { ...env, PATH: binDirs.join(';') }, cwd, 'win32');
  for (const dir of binDirs) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
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
 * `"` or `%` (and any embedded newline) are rejected because cmd.exe would re-interpret them.
 */
function buildInvocation(argv, env, cwd, platform = process.platform) {
  const [command, ...args] = argv;
  if (platform !== 'win32') return { file: command, args, options: {} };
  const resolved = findOnPath(command, env, cwd, platform);
  const ext = resolved ? path.win32.extname(resolved).toLowerCase() : '';
  if (resolved && (ext === '.cmd' || ext === '.bat')) {
    const bad = cmdUnsafeChars([command, resolved, ...args]);
    if (argv.some((a) => /[\r\n\0]/.test(a))) bad.push('newline');
    if (bad.length) return { error: { code: 'CMD_UNSAFE', chars: bad.join(' ') } };
    const line = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(' ');
    return {
      file: env.ComSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { file: resolved || command, args, options: {} };
}

module.exports = {
  isWin,
  validPid,
  pidAlive,
  procStart,
  sameProcess,
  killTree,
  sleepSync,
  groupRssKiB,
  findOnPath,
  resolveLocalBin,
  buildInvocation,
  cmdUnsafeChars,
  quoteForCmd,
};

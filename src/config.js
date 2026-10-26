'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

const DEFAULTS = Object.freeze({
  lang: 'auto',
  // 'auto' = max(1, floor(cpus / 4)); a number pins it.
  concurrency: 'auto',
  timeoutSec: 900,
  maxWaitSec: 1800,
  cache: {
    enabled: true,
    successTtlHours: 24,
    failureTtlMinutes: 10,
    maxEntryMB: 4,
    // Names of environment variables whose values are part of the cache key.
    env: [],
  },
  // Opt-in rewriting of the command line (off by default - szq does not change what you run).
  incremental: { tsc: false },
  guard: {
    commands: ['tsc', 'vitest', 'jest'],
    scripts: ['test', 'typecheck'],
  },
});

/** Resolve every directory szq uses. Pure function of the environment (testable). */
function resolvePaths(env = process.env, home = os.homedir()) {
  let stateDir;
  let configDir;
  if (env.SZQ_HOME) {
    stateDir = path.resolve(env.SZQ_HOME);
  } else if (isWin) {
    stateDir = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'szq');
  } else {
    stateDir = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'szq');
  }
  if (isWin) configDir = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'szq');
  else configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'szq');
  const configFile = env.SZQ_CONFIG ? path.resolve(env.SZQ_CONFIG) : path.join(configDir, 'config.json');
  return {
    stateDir,
    configFile,
    queueDir: path.join(stateDir, 'queue'),
    cacheDir: path.join(stateDir, 'cache'),
    tsbuildDir: path.join(stateDir, 'tsbuildinfo'),
    shimDir: path.join(stateDir, 'shims'),
    claimDir: path.join(stateDir, 'claim.lock'),
    disableFile: path.join(stateDir, 'DISABLE'),
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function posInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function strList(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice();
  const out = v.filter((x) => typeof x === 'string' && /^[\w.@:+-]{1,64}$/.test(x));
  return out.length ? out : fallback.slice();
}

/** Merge user JSON over the defaults, ignoring unknown keys and bad types. */
function normalize(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const cache = isPlainObject(r.cache) ? r.cache : {};
  const guard = isPlainObject(r.guard) ? r.guard : {};
  const inc = isPlainObject(r.incremental) ? r.incremental : {};
  return {
    lang: typeof r.lang === 'string' ? r.lang : DEFAULTS.lang,
    concurrency: r.concurrency === 'auto' ? 'auto' : posInt(r.concurrency, 'auto'),
    timeoutSec: posInt(r.timeoutSec, DEFAULTS.timeoutSec),
    maxWaitSec: posInt(r.maxWaitSec, DEFAULTS.maxWaitSec),
    cache: {
      enabled: typeof cache.enabled === 'boolean' ? cache.enabled : DEFAULTS.cache.enabled,
      successTtlHours: posInt(cache.successTtlHours, DEFAULTS.cache.successTtlHours),
      failureTtlMinutes: posInt(cache.failureTtlMinutes, DEFAULTS.cache.failureTtlMinutes),
      maxEntryMB: posInt(cache.maxEntryMB, DEFAULTS.cache.maxEntryMB),
      env: Array.isArray(cache.env) ? cache.env.filter((x) => typeof x === 'string' && /^[A-Za-z_]\w*$/.test(x)) : [],
    },
    incremental: { tsc: typeof inc.tsc === 'boolean' ? inc.tsc : DEFAULTS.incremental.tsc },
    guard: {
      commands: strList(guard.commands, DEFAULTS.guard.commands),
      scripts: strList(guard.scripts, DEFAULTS.guard.scripts),
    },
  };
}

function readConfigFile(file) {
  try {
    return { raw: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { raw: {}, error: null };
    return { raw: {}, error: e };
  }
}

function loadConfig(env = process.env) {
  const paths = resolvePaths(env);
  const { raw, error } = readConfigFile(paths.configFile);
  return { config: normalize(raw), paths, error, raw };
}

function resolveConcurrency(config, env = process.env, cpus = os.cpus().length) {
  const fromEnv = posInt(env.SZQ_CONCURRENCY, 0);
  if (fromEnv) return fromEnv;
  if (config.concurrency !== 'auto') return config.concurrency;
  return Math.max(1, Math.floor(cpus / 4));
}

/**
 * Create a state directory that only the current user can write to.
 * Refuses directories owned by someone else or writable by group/others (POSIX).
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWin || typeof process.getuid !== 'function') return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw Object.assign(new Error('not a directory'), { szqUnsafe: true });
  if (st.uid !== process.getuid()) throw Object.assign(new Error('owned by another user'), { szqUnsafe: true });
  if ((st.mode & 0o022) !== 0) throw Object.assign(new Error('writable by group or others'), { szqUnsafe: true });
}

function ensureStateDirs(paths) {
  for (const d of [paths.stateDir, paths.queueDir, paths.cacheDir, paths.tsbuildDir]) ensureDir(d);
}

/** Set a dotted key (`cache.enabled`) in a plain object. */
function setDotted(obj, key, value) {
  const parts = key.split('.');
  // Validate every segment before touching the object, so a rejected key leaves no partial edit.
  for (const p of parts) {
    if (!p || p === '__proto__' || p === 'constructor' || p === 'prototype') throw new Error('invalid key');
  }
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

module.exports = {
  DEFAULTS,
  resolvePaths,
  normalize,
  loadConfig,
  resolveConcurrency,
  ensureDir,
  ensureStateDirs,
  readConfigFile,
  setDotted,
  isWin,
};

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

const DEFAULTS = Object.freeze({
  lang: 'auto',
  // 'auto' = start with max(1, floor(cpus / 4)) and grow while the machine has CPU headroom (see `headroom`);
  // a number pins it.
  concurrency: 'auto',
  // Upper bound of the growth in 'auto' mode: 'auto' = floor(cpus * 0.75), never below the base value.
  maxConcurrency: 'auto',
  // In 'auto' mode, admit one more run beyond the base while recent CPU utilisation is below `cpuBelow`
  // (0..1) and the newest run started at least `settleMs` ago (so its load is already visible).
  headroom: { enabled: true, cpuBelow: 0.55, settleMs: 800 },
  timeoutSec: 900,
  maxWaitSec: 1800,
  // Kill a run that prints nothing for this long (0 = off). Note: tsc is silent until it finishes.
  stallSec: 0,
  // Kill a run whose process tree exceeds this resident memory (0 = off, POSIX only).
  maxMemMB: 0,
  // Back off when the machine is already busy for reasons outside the queue.
  adaptive: { enabled: true, loadPerCpu: 1.5 },
  // 'auto' = digest when stdout is not a terminal AND an agent environment is detected.
  output: { digest: 'auto', maxLines: 200, head: 15, tail: 40 },
  logs: { keep: 50 },
  cache: {
    enabled: true,
    successTtlHours: 24,
    failureTtlMinutes: 10,
    maxEntryMB: 4,
    // Names of environment variables whose values are part of the cache key.
    env: [],
    // Extra files (relative to the repository root) whose content is part of the cache key,
    // e.g. ["node_modules/.modules.yaml"] to notice installs that git cannot see.
    extraFiles: [],
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
    logDir: path.join(stateDir, 'logs'),
    statDir: path.join(stateDir, 'statcache'),
    lastDir: path.join(stateDir, 'last'),
    statsFile: path.join(stateDir, 'stats.jsonl'),
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function posInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function relPathList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x) => typeof x === 'string' && /^[\w.@+/-]{1,200}$/.test(x) && !x.startsWith('/') && !x.split('/').some((seg) => seg === '..' || seg === ''),
  );
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
  const adaptive = isPlainObject(r.adaptive) ? r.adaptive : {};
  const output = isPlainObject(r.output) ? r.output : {};
  const logs = isPlainObject(r.logs) ? r.logs : {};
  const headroom = isPlainObject(r.headroom) ? r.headroom : {};
  const nonNeg = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
  return {
    lang: typeof r.lang === 'string' ? r.lang : DEFAULTS.lang,
    concurrency: r.concurrency === 'auto' ? 'auto' : posInt(r.concurrency, 'auto'),
    maxConcurrency: r.maxConcurrency === 'auto' ? 'auto' : posInt(r.maxConcurrency, 'auto'),
    headroom: {
      enabled: typeof headroom.enabled === 'boolean' ? headroom.enabled : DEFAULTS.headroom.enabled,
      cpuBelow: Number(headroom.cpuBelow) > 0 && Number(headroom.cpuBelow) <= 1 ? Number(headroom.cpuBelow) : DEFAULTS.headroom.cpuBelow,
      settleMs: Number.isFinite(Number(headroom.settleMs)) && Number(headroom.settleMs) >= 0 ? Math.floor(Number(headroom.settleMs)) : DEFAULTS.headroom.settleMs,
    },
    timeoutSec: posInt(r.timeoutSec, DEFAULTS.timeoutSec),
    maxWaitSec: posInt(r.maxWaitSec, DEFAULTS.maxWaitSec),
    stallSec: nonNeg(r.stallSec, DEFAULTS.stallSec),
    maxMemMB: nonNeg(r.maxMemMB, DEFAULTS.maxMemMB),
    adaptive: {
      enabled: typeof adaptive.enabled === 'boolean' ? adaptive.enabled : DEFAULTS.adaptive.enabled,
      loadPerCpu: Number(adaptive.loadPerCpu) > 0 ? Number(adaptive.loadPerCpu) : DEFAULTS.adaptive.loadPerCpu,
    },
    output: {
      digest: ['auto', 'always', 'never'].includes(output.digest) ? output.digest : DEFAULTS.output.digest,
      maxLines: nonNeg(output.maxLines, DEFAULTS.output.maxLines),
      head: nonNeg(output.head, DEFAULTS.output.head),
      tail: nonNeg(output.tail, DEFAULTS.output.tail),
    },
    logs: { keep: posInt(logs.keep, DEFAULTS.logs.keep) },
    cache: {
      enabled: typeof cache.enabled === 'boolean' ? cache.enabled : DEFAULTS.cache.enabled,
      successTtlHours: posInt(cache.successTtlHours, DEFAULTS.cache.successTtlHours),
      failureTtlMinutes: posInt(cache.failureTtlMinutes, DEFAULTS.cache.failureTtlMinutes),
      maxEntryMB: posInt(cache.maxEntryMB, DEFAULTS.cache.maxEntryMB),
      env: Array.isArray(cache.env) ? cache.env.filter((x) => typeof x === 'string' && /^[A-Za-z_]\w*$/.test(x)) : [],
      extraFiles: relPathList(cache.extraFiles),
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

/** True when the base concurrency is derived (not pinned by --cap, $SZQ_CONCURRENCY or a number in the config). */
function isAutoConcurrency(config, env = process.env) {
  return !posInt(env.SZQ_CONCURRENCY, 0) && config.concurrency === 'auto';
}

function resolveMaxConcurrency(config, base, cpus = os.cpus().length) {
  const max = config.maxConcurrency === 'auto' ? Math.floor(cpus * 0.75) : config.maxConcurrency;
  return Math.max(base, max);
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
  for (const d of [paths.stateDir, paths.queueDir, paths.cacheDir, paths.tsbuildDir, paths.logDir, paths.statDir, paths.lastDir]) ensureDir(d);
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
  isAutoConcurrency,
  resolveMaxConcurrency,
  ensureDir,
  ensureStateDirs,
  readConfigFile,
  setDotted,
  isWin,
};

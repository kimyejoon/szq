'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { t } = require('./i18n');
const { Queue } = require('./queue');
const { Cache, stateKey, gitTop } = require('./cache');
const { killTree, buildInvocation } = require('./platform');
const { resolveConcurrency, ensureStateDirs } = require('./config');

const HEARTBEAT_MS = 5000;
const POLL_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  process.stderr.write(`[szq] ${msg}\n`);
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function shortCwd(p) {
  return p.replace(os.homedir(), '~').split(/[\\/]/).slice(-2).join('/');
}

function shimDirs(paths) {
  return [paths.shimDir, process.env.SZQ_SHIM_DIR].filter(Boolean);
}

/** PATH with node_modules/.bin directories of cwd..repo root prepended (what `pnpm exec` would do). */
function pathWithBins(cwd, top, env, extraRemove = []) {
  const dirs = [];
  let d = cwd;
  for (;;) {
    const bin = path.join(d, 'node_modules', '.bin');
    if (fs.existsSync(bin)) dirs.push(bin);
    if (!top || d === top || path.dirname(d) === d) break;
    d = path.dirname(d);
  }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const rest = (env[key] || '')
    .split(path.delimiter)
    .filter((p) => p && !extraRemove.some((r) => path.resolve(p) === path.resolve(r)));
  return { key, value: [...dirs, ...rest].join(path.delimiter) };
}

/** Opt-in: make `tsc` incremental. Only touches a plain `tsc` / `npx tsc` / `pnpm [exec] tsc` invocation. */
function addIncremental(argv, cwd, tsbuildDir) {
  const base = (p) => path.basename(p || '').replace(/\.(cmd|exe|ps1)$/i, '');
  let i = -1;
  if (base(argv[0]) === 'tsc') i = 0;
  else if (['pnpm', 'npx'].includes(base(argv[0])) && argv[1] === 'tsc') i = 1;
  else if (base(argv[0]) === 'pnpm' && argv[1] === 'exec' && argv[2] === 'tsc') i = 2;
  if (i < 0) return argv;
  const rest = argv.slice(i + 1);
  if (rest.some((x) => /^(--incremental|-b|--build|--tsBuildInfoFile|--watch|-w)/.test(x))) return argv;
  const info = path.join(tsbuildDir, `${crypto.createHash('sha256').update(cwd + rest.join(' ')).digest('hex').slice(0, 32)}.tsbuildinfo`);
  return [...argv.slice(0, i + 1), '--incremental', '--tsBuildInfoFile', info, ...rest];
}

/** Opt-in `--changed[=REF]`: narrow vitest/jest to files related to changes. */
function addChanged(argv, ref) {
  const joined = argv.join(' ');
  const refArgs = ref && ref !== true ? [ref] : [];
  if (/\bvitest\b/.test(joined) && !/--changed/.test(joined)) return [...argv, '--changed', ...refArgs];
  if (/\bjest\b/.test(joined) && !/--changedSince|--onlyChanged/.test(joined)) {
    return ref && ref !== true ? [...argv, `--changedSince=${ref}`] : [...argv, '--onlyChanged'];
  }
  return argv;
}

function replay(entry, how, cacheCfg) {
  for (const [fd, b64] of entry.chunks) (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(b64, 'base64'));
  const failNote = entry.code === 0 ? '' : t('failNote', { minutes: cacheCfg.failureTtlMinutes });
  log(`${how} ${t('reusedAt', { time: new Date(entry.at).toLocaleTimeString(), code: entry.code })}${failNote}`);
  return entry.code;
}

/**
 * Run `argv` through the queue.
 * @returns {Promise<number>} exit code
 */
async function run({ opts, argv, ctx }) {
  const { config, paths } = ctx;
  ensureStateDirs(paths);
  const cwd = fs.realpathSync(process.cwd());
  const top = gitTop(cwd);

  if (process.env.SZQ_ACTIVE) {
    // Called from inside a running job: run directly (no queue) so we never deadlock on ourselves.
    return passThrough(argv, cwd, top, paths);
  }
  if (argv.some((a) => a === '--watch' || a === '-w' || a === 'watch')) {
    log(t('watchUnsupported'));
    return 64;
  }

  if (opts.changed) argv = addChanged(argv, opts.changed);
  if (config.incremental.tsc) argv = addIncremental(argv, cwd, paths.tsbuildDir);

  const cacheable = config.cache.enabled && !opts.noCache && !!top;
  const finalArgv = argv;
  const keyArgs = { cwd, top, argv: finalArgv, cacheEnv: config.cache.env };
  let key = cacheable ? await stateKey(keyArgs) : null;
  const cache = new Cache(paths, config.cache);
  cache.prune();
  if (key) {
    const hit = cache.read(key);
    if (hit) return replay(hit, t('cacheHit'), config.cache);
  }

  const queue = new Queue(paths);
  const cap = opts.cap || resolveConcurrency(config);
  const me = queue.create(cwd, finalArgv, key);
  let child = null;
  let cleaned = false;
  const hb = setInterval(() => queue.heartbeat(me), HEARTBEAT_MS);
  const cleanup = (code) => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(hb);
    if (child && child.pid) killTree(child.pid, 'SIGTERM');
    queue.drop(me);
    if (code !== undefined) process.exitCode = code;
  };
  const onSignal = (sig) => () => {
    cleanup(128 + (sig === 'SIGINT' ? 2 : 15));
    process.exit(process.exitCode);
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));
  if (process.platform !== 'win32') process.on('SIGHUP', onSignal('SIGTERM'));

  // ---- wait for a slot (or for an identical run ahead of us to finish) ----
  const waitStart = Date.now();
  const maxWaitMs = (opts.maxWait || config.maxWaitSec) * 1000;
  let lastPos = -1;
  let lastPrint = 0;
  for (;;) {
    if (key) {
      const hit = cache.read(key);
      if (hit) {
        cleanup();
        return replay(hit, t('cacheHitWaited'), config.cache);
      }
    }
    const r = queue.tryClaim(me, cap);
    if (r.ok) break;
    if (Date.now() - waitStart > maxWaitMs) {
      cleanup();
      log(t('waitTimeout', { elapsed: fmtDur(maxWaitMs) }));
      return 75;
    }
    if (r.following) {
      if (lastPos !== -2 || Date.now() - lastPrint > 30000) {
        log(t('followLine', { pid: r.leader.pid, where: shortCwd(r.leader.cwd), elapsed: fmtDur(Date.now() - waitStart) }));
        lastPos = -2;
        lastPrint = Date.now();
      }
    } else if (r.position !== lastPos || Date.now() - lastPrint > 30000) {
      const who = (r.ahead || [])
        .slice(0, 3)
        .map((x) => `${shortCwd(x.cwd)}: ${x.cmd.slice(0, 40)}`)
        .join(' | ');
      log(
        t('waitLine', {
          pos: r.position,
          running: r.running,
          cap,
          elapsed: fmtDur(Date.now() - waitStart),
          who: who ? t('waitAhead', { who }) : '',
        }),
      );
      lastPos = r.position;
      lastPrint = Date.now();
    }
    await sleep(POLL_MS);
  }
  if (Date.now() - waitStart > 2000) log(t('turnCame', { elapsed: fmtDur(Date.now() - waitStart) }));

  // The tree may have changed while we waited, and an identical run may have finished meanwhile.
  if (cacheable) {
    key = (await stateKey(keyArgs)) || key;
    const hit = key && cache.read(key);
    if (hit) {
      cleanup();
      return replay(hit, Date.now() - waitStart > 2000 ? t('cacheHitWaited') : t('cacheHit'), config.cache);
    }
  }

  // ---- run ----
  const env = { ...process.env, SZQ_ACTIVE: '1' };
  const p = pathWithBins(cwd, top, env, shimDirs(paths));
  env[p.key] = p.value;
  const inv = buildInvocation(finalArgv, env, cwd);
  if (inv.error) {
    cleanup();
    log(t('cmdRejected', { chars: inv.error.chars }));
    return 64;
  }

  const chunks = [];
  const maxBytes = config.cache.maxEntryMB * 1024 * 1024;
  let bytes = 0;
  let overflow = false;
  let timedOut = false;
  const started = Date.now();
  const timeoutMs = (opts.timeout || config.timeoutSec) * 1000;
  const code = await new Promise((resolve) => {
    try {
      child = cp.spawn(inv.file, inv.args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...inv.options,
      });
    } catch (e) {
      log(t('spawnFailed', { msg: e.message }));
      return resolve(127);
    }
    child.on('error', (e) => {
      log(t('spawnFailed', { msg: e.message }));
      resolve(127);
    });
    queue.update(me, { childPid: child.pid });
    const tee = (fd, stream) => (buf) => {
      stream.write(buf);
      bytes += buf.length;
      if (bytes > maxBytes) overflow = true;
      else chunks.push([fd, buf.toString('base64')]);
    };
    child.stdout.on('data', tee(1, process.stdout));
    child.stderr.on('data', tee(2, process.stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      log(t('execTimeout', { elapsed: fmtDur(timeoutMs) }));
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('close', (c, sig) => {
      clearTimeout(timer);
      resolve(timedOut ? 124 : c ?? (sig ? 128 + (os.constants.signals[sig] || 0) : 1));
    });
  });
  child = null;
  if (key && !overflow && !timedOut) cache.write(key, { code, cmd: finalArgv.join(' '), chunks });
  log(t('exited', { code, elapsed: fmtDur(Date.now() - started) }));
  cleanup();
  return code;
}

function passThrough(argv, cwd, top, paths) {
  const env = { ...process.env };
  const p = pathWithBins(cwd, top, env, shimDirs(paths));
  env[p.key] = p.value;
  const inv = buildInvocation(argv, env, cwd);
  if (inv.error) {
    log(t('cmdRejected', { chars: inv.error.chars }));
    return 64;
  }
  const r = cp.spawnSync(inv.file, inv.args, { stdio: 'inherit', cwd, env, windowsHide: true, ...inv.options });
  if (r.error) {
    log(t('spawnFailed', { msg: r.error.message }));
    return 127;
  }
  return r.status ?? 1;
}

module.exports = { run, addChanged, addIncremental, pathWithBins, fmtDur, shortCwd, log, passThrough };

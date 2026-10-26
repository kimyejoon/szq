'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { t } = require('./i18n');
const { Queue } = require('./queue');
const { Cache, fingerprint, gitTop } = require('./cache');
const { Logs } = require('./logs');
const { digest } = require('./digest');
const stats = require('./stats');
const { killTree, buildInvocation, resolveLocalBin, groupRssKiB, procStart, sleepSync, isWin } = require('./platform');
const { resolveConcurrency, resolveMaxConcurrency, isAutoConcurrency, ensureStateDirs } = require('./config');
const { CpuMeter } = require('./cpu');

const HEARTBEAT_MS = 5000;
const POLL_MS = 500; // safety net: waiters are normally woken by file-system events (see makeWaker)
const FOLLOW_POLL_MS = 250; // followers only read a cache file, so they can look more often
const WATCHDOG_MS = 2000;
const MEM_CHECK_MS = Number(process.env.SZQ_MEM_INTERVAL_MS) > 0 ? Number(process.env.SZQ_MEM_INTERVAL_MS) : 5000; // overridable for tests

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

const toolName = (p) => path.basename(p || '').replace(/\.(cmd|exe|ps1|bat)$/i, '');

/** `jest -w 2` means --maxWorkers; `vitest -w` / `tsc -w` mean watch. Only real watch modes are refused. */
function isWatch(argv) {
  const flag = (name) =>
    argv.some((a) => a === name || (a.startsWith(`${name}=`) && !/^(false|0|no)$/i.test(a.slice(name.length + 1))));
  if (flag('--watch') || argv.includes('--watchAll')) return true;
  const idx = argv.findIndex((a) => ['vitest', 'tsc'].includes(toolName(a).toLowerCase()));
  if (idx >= 0 && argv.slice(idx + 1).includes('-w')) return true;
  const v = argv.findIndex((a) => toolName(a).toLowerCase() === 'vitest');
  return v >= 0 && argv[v + 1] === 'watch';
}

function isAgentEnv(env) {
  return Boolean(env.CLAUDECODE || env.SZQ_AGENT);
}

/** Decide whether to print a digest instead of streaming the full output. */
function wantDigest(opts, config, env = process.env, isTTY = process.stdout.isTTY) {
  if (opts.digest === true) return true;
  if (opts.digest === false) return false;
  if (config.output.digest === 'never') return false;
  if (config.output.digest === 'always') return true;
  return !isTTY && isAgentEnv(env);
}

/** Remove shim directories from PATH so a shim never finds itself again when the real tool is looked up. */
function stripShimDirs(env, paths) {
  const drop = [paths.shimDir, process.env.SZQ_SHIM_DIR].filter(Boolean).map((p) => path.resolve(p));
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[key] = (env[key] || '')
    .split(path.delimiter)
    .filter((p) => p && !drop.includes(path.resolve(p)))
    .join(path.delimiter);
  return env;
}

function localBinDirs(cwd, top) {
  const dirs = [];
  let d = cwd;
  for (;;) {
    const bin = path.join(d, 'node_modules', '.bin');
    if (fs.existsSync(bin)) dirs.push(bin);
    if (!top || d === top || path.dirname(d) === d) break;
    d = path.dirname(d);
  }
  return dirs;
}

/** Opt-in: make `tsc` incremental. Only touches a plain `tsc` / `npx tsc` / `pnpm [exec] tsc` invocation. */
function addIncremental(argv, cwd, tsbuildDir) {
  let i = -1;
  if (toolName(argv[0]) === 'tsc') i = 0;
  else if (['pnpm', 'npx'].includes(toolName(argv[0])) && argv[1] === 'tsc') i = 1;
  else if (toolName(argv[0]) === 'pnpm' && argv[1] === 'exec' && argv[2] === 'tsc') i = 2;
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

/** Fewer parallel runs while the machine is busy for reasons outside the queue (never below 1). */
function effectiveCap(cap, adaptive, loadavg = os.loadavg(), cpus = os.cpus().length) {
  if (!adaptive.enabled || isWin || cap <= 1) return { cap, throttled: false, load: loadavg[0] };
  const throttled = loadavg[0] / cpus > adaptive.loadPerCpu;
  return { cap: throttled ? 1 : cap, throttled, load: loadavg[0] };
}

/**
 * Concurrency for the next start in 'auto' mode: the base value, plus as many more runs as the CPU headroom
 * allows. A running run is assumed to use about `util / running` of the machine (an over-estimate when other
 * programs are busy, which only makes it more careful), so with plenty of headroom several runs are admitted at
 * once instead of one per settle interval. At most MAX_STEP runs are added per decision.
 * Pure function of its inputs (tested without touching the real CPU).
 */
const MAX_STEP = 3;
function growCap({ base, max, running, util, newestStartedAt, now, headroom }) {
  if (running.length < base) return base;
  if (running.length >= max) return base;
  if (util === null || util === undefined) return base; // no measurement yet
  const settled = !newestStartedAt || now - newestStartedAt >= headroom.settleMs;
  if (!(util < headroom.cpuBelow) || !settled) return base;
  const perRun = Math.max(util / Math.max(1, running.length), 0.05);
  const extra = Math.min(MAX_STEP, Math.max(1, Math.floor((headroom.cpuBelow - util) / perRun)));
  return Math.min(max, running.length + extra);
}

/** Wake a waiting run as soon as the queue or the cache directory changes (polling stays as a safety net). */
function makeWaker(dirs) {
  const watchers = [];
  let wake = null;
  const poke = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  for (const d of dirs) {
    try {
      const w = fs.watch(d, { persistent: false }, poke);
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      /* no file-system events here: polling it is */
    }
  }
  return {
    wait(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          setTimeout(resolve, 20); // let a rename/unlink burst settle
        };
      });
    },
    close() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

function decodeChunks(chunks) {
  return Buffer.concat(chunks.map(([, b64]) => Buffer.from(b64, 'base64'))).toString('utf8');
}

/** Print a stored result (cache hit or shared run), digested if requested. */
function replay(entry, how, ctx, digestOn) {
  const { config, paths } = ctx;
  if (digestOn) {
    const logs = new Logs(paths, config.logs);
    let logFile = entry.logFile && fs.existsSync(entry.logFile) ? entry.logFile : null;
    if (!logFile) logFile = logs.fromChunks({ cwd: process.cwd(), cmd: entry.cmd }, entry.chunks, { code: entry.code, ms: entry.ms });
    const d = digest(decodeChunks(entry.chunks), { ...config.output, logPath: logFile });
    process.stdout.write(d.text);
  } else {
    for (const [fd, b64] of entry.chunks) (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(b64, 'base64'));
  }
  const failNote = entry.code === 0 ? '' : t('failNote', { minutes: config.cache.failureTtlMinutes });
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
  if (isWatch(argv)) {
    log(t('watchUnsupported'));
    return 64;
  }

  if (opts.changed) argv = addChanged(argv, opts.changed);
  if (config.incremental.tsc) argv = addIncremental(argv, cwd, paths.tsbuildDir);

  const digestOn = wantDigest(opts, config);
  const cmdName = toolName(argv[0]);
  const cacheable = config.cache.enabled && !opts.noCache && !!top;
  const finalArgv = argv;
  const fpArgs = { cwd, top, argv: finalArgv, cacheEnv: config.cache.env, extraFiles: config.cache.extraFiles, statDir: paths.statDir };
  let fp = cacheable ? fingerprint(fpArgs) : null;
  let key = fp && fp.key;
  const cache = new Cache(paths, config.cache);
  cache.prune(); // occasional housekeeping
  if (fp) cache.saveLast(fp.key, fp.components);
  if (key) {
    const hit = cache.read(key);
    if (hit) {
      stats.record(paths.statsFile, { k: 'hit', cmd: cmdName, saved: hit.ms || 0 });
      return replay(hit, t('cacheHit'), ctx, digestOn);
    }
  }

  const queue = new Queue(paths);
  const cap = opts.cap || resolveConcurrency(config);
  const dynamic = !opts.cap && isAutoConcurrency(config) && config.headroom.enabled;
  const maxCap = resolveMaxConcurrency(config, cap);
  const meter = new CpuMeter();
  const capFn = (runningTickets) => {
    const e = effectiveCap(cap, config.adaptive);
    if (e.throttled) return e.cap;
    if (!dynamic) return cap;
    const newest = runningTickets.reduce((m, tk) => Math.max(m, tk.startedAt || 0), 0);
    return growCap({ base: cap, max: maxCap, running: runningTickets, util: meter.sample(), newestStartedAt: newest, now: Date.now(), headroom: config.headroom });
  };
  const waker = makeWaker([paths.queueDir, paths.cacheDir]);
  const priority = opts.priority || (process.stdin.isTTY && process.stdout.isTTY ? 'high' : 'normal');
  const me = queue.create(cwd, finalArgv, key, { priority, exclusive: opts.exclusive });
  const logs = new Logs(paths, config.logs);
  let logWriter = null;
  let child = null;
  let cleaned = false;
  const started0 = Date.now();
  const hb = setInterval(() => queue.heartbeat(me), HEARTBEAT_MS);
  const cleanup = (code) => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(hb);
    waker.close();
    if (child && child.pid) killTree(child.pid, 'SIGTERM');
    if (logWriter) {
      try {
        logWriter.close({ code: null, aborted: true });
      } catch {
        /* log already closed */
      }
    }
    queue.drop(me);
    if (code !== undefined) process.exitCode = code;
  };
  const onSignal = (sig) => () => {
    const pid = child && child.pid;
    cleanup(128 + (sig === 'SIGINT' ? 2 : 15));
    if (pid) {
      sleepSync(400); // grace period for SIGTERM, then make sure nothing is left behind outside the queue
      killTree(pid, 'SIGKILL');
    }
    process.exit(process.exitCode);
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));
  if (!isWin) process.on('SIGHUP', onSignal('SIGTERM'));

  // Everything from here on runs inside try/finally: whatever goes wrong, the ticket, timers, watchers and the
  // child are released - a leaked 'running' ticket would hold a slot (and keep this process alive) forever.
  const execute = async () => {
    // ---- wait for a slot (or for an identical run ahead of us to finish) ----
    const waitStart = Date.now();
    const maxWaitMs = (opts.maxWait || config.maxWaitSec) * 1000;
    let lastPos = -1;
    let lastPrint = 0;
    let waited = false;
    const refreshRequest = () => {
      fp = fingerprint(fpArgs); // failure means uncacheable, never reuse an old fingerprint
      key = fp && fp.key;
      if (fp) cache.saveLast(fp.key, fp.components);
      if (key === me.t.key) return false;
      // A changed request must compete for admission under its new key: another caller may already run it.
      queue.update(me, { key, state: 'waiting', startedAt: undefined });
      return true;
    };
    const share = (hit) => {
      cleanup();
      stats.record(paths.statsFile, { k: 'share', cmd: cmdName, saved: hit.ms || 0, waited: Date.now() - waitStart });
      return replay(hit, t('cacheHitWaited'), ctx, digestOn);
    };
    for (;;) {
      if (Date.now() - waitStart > maxWaitMs) {
        log(t('waitTimeout', { elapsed: fmtDur(maxWaitMs) }));
        return 75;
      }
      if (key) {
        let hit = cache.read(key);
        if (hit) {
          // Do not hash on every poll. Revalidate when a result actually becomes available.
          // Ticket creation itself can take time (process identity lookup), even before the first wait.
          refreshRequest();
          waited = false;
          hit = key && cache.read(key);
          if (hit) return share(hit);
        }
      }
      const eff = effectiveCap(cap, config.adaptive);
      const r = queue.tryClaim(me, capFn);
      if (r.ok) {
        // A leader can publish its result and release its ticket between our lookup and this claim.
        // Always check again, even for an immediate admission. A queued run must also use today's tree.
        let hit = key && cache.read(key);
        if (cacheable && (waited || hit)) {
          const changed = refreshRequest();
          waited = false;
          hit = key && cache.read(key);
          if (hit) return share(hit);
          if (changed) continue;
        }
        if (hit) return share(hit);
        break;
      }
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
            cap: r.cap ?? eff.cap,
            elapsed: fmtDur(Date.now() - waitStart),
            who: who ? t('waitAhead', { who }) : '',
          }) + (eff.throttled ? t('throttled', { load: eff.load.toFixed(1) }) : ''),
        );
        lastPos = r.position;
        lastPrint = Date.now();
      }
      await waker.wait(r.following ? FOLLOW_POLL_MS : POLL_MS);
      waited = true;
    }
    waker.close();
    if (Date.now() - waitStart > 2000) log(t('turnCame', { elapsed: fmtDur(Date.now() - waitStart) }));

    // ---- run ----
    const env = stripShimDirs({ ...process.env, SZQ_ACTIVE: '1' }, paths);
    const local = resolveLocalBin(finalArgv[0], top ? localBinDirs(cwd, top) : [], env, cwd);
    const argvToRun = local ? [local, ...finalArgv.slice(1)] : finalArgv;
    const inv = buildInvocation(argvToRun, env, cwd);
    if (inv.error) {
      cleanup();
      log(t('cmdRejected', { chars: inv.error.chars }));
      return 64;
    }

    logWriter = logs.open({ cwd, cmd: cmdName });
    const chunks = [];
    const maxBytes = config.cache.maxEntryMB * 1024 * 1024;
    let bytes = 0;
    let overflow = false;
    let killedBy = null;
    let lastOutput = Date.now();
    const started = Date.now();
    const timeoutMs = (opts.timeout || config.timeoutSec) * 1000;
    const stallMs = (opts.stall ?? config.stallSec) * 1000;
    const maxMemKiB = (opts.maxMem ?? config.maxMemMB) * 1024;
    if (maxMemKiB && isWin) log(t('memUnsupported'));

    const code = await new Promise((resolve) => {
      const timers = [];
      const finish = (c) => {
        timers.forEach(clearInterval);
        timers.forEach(clearTimeout);
        resolve(c);
      };
      try {
        child = cp.spawn(inv.file, inv.args, {
          cwd,
          env,
          detached: !isWin,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...inv.options,
        });
      } catch (e) {
        log(t('spawnFailed', { msg: e.message }));
        return finish(127);
      }
      child.on('error', (e) => {
        log(t('spawnFailed', { msg: e.message }));
        finish(127);
      });
      const stop = (reason, message) => {
        if (killedBy) return;
        killedBy = reason;
        log(message);
        const pid = child.pid;
        killTree(pid, 'SIGTERM');
        const hard = setTimeout(() => killTree(pid, 'SIGKILL'), 5000);
        hard.unref();
        timers.push(hard); // cleared as soon as the child has exited, so a recycled pid is never signalled
      };
      const tee = (fd, stream) => (buf) => {
        lastOutput = Date.now();
        logWriter.write(buf);
        if (!digestOn) stream.write(buf);
        bytes += buf.length;
        if (bytes > maxBytes) overflow = true;
        else chunks.push([fd, buf.toString('base64')]);
      };
      child.stdout.on('data', tee(1, process.stdout));
      child.stderr.on('data', tee(2, process.stderr));
      timers.push(setTimeout(() => stop('timeout', t('execTimeout', { elapsed: fmtDur(timeoutMs) })), timeoutMs));
      if (stallMs > 0) {
        timers.push(
          setInterval(() => {
            if (Date.now() - lastOutput > stallMs) stop('stall', t('stalled', { elapsed: fmtDur(stallMs) }));
          }, WATCHDOG_MS),
        );
      }
      if (maxMemKiB > 0 && !isWin) {
        timers.push(
          setInterval(() => {
            const rss = groupRssKiB(child.pid);
            if (rss !== null && rss > maxMemKiB) stop('mem', t('memExceeded', { used: Math.round(rss / 1024), limit: Math.round(maxMemKiB / 1024) }));
          }, MEM_CHECK_MS),
        );
      }
      queue.update(me, { childPid: child.pid, childStart: procStart(child.pid) });
      child.on('close', (c, sig) => {
        const mapped = { timeout: 124, stall: 125, mem: 126 }[killedBy];
        finish(mapped ?? c ?? (sig ? 128 + (os.constants.signals[sig] || 0) : 1));
      });
    });
    child = null;
    const ms = Date.now() - started;
    const logFile = logWriter.file;
    logWriter.close({ code, ms });
    logWriter = null;

    // Cache only if nothing changed the working tree while the command ran.
    let cached = false;
    if (key && !overflow && !killedBy) {
      const after = fingerprint(fpArgs);
      if (after && after.key === key) cached = cache.write(key, { code, cmd: cmdName, chunks, ms, logFile });
      else log(t('treeChanged'));
    }
    stats.record(paths.statsFile, { k: 'run', cmd: cmdName, ms, code, cached });

    if (digestOn) {
      let body;
      try {
        body = logs.readBody(logFile);
      } catch {
        body = decodeChunks(chunks); // the log vanished (disk full, removed by hand): digest what is still in memory
      }
      const d = digest(body, { ...config.output, logPath: logFile });
      process.stdout.write(d.text);
    }
    logs.prune(); // after the digest: a small `logs.keep` must not delete the log this run is about to point at
    log(t('exited', { code, elapsed: fmtDur(ms) }));
    cleanup();
    return code;
  };
  try {
    return await execute();
  } finally {
    cleanup();
  }
}

function passThrough(argv, cwd, top, paths) {
  const env = stripShimDirs({ ...process.env }, paths);
  const local = resolveLocalBin(argv[0], top ? localBinDirs(cwd, top) : [], env, cwd);
  const inv = buildInvocation(local ? [local, ...argv.slice(1)] : argv, env, cwd);
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

module.exports = {
  run,
  addChanged,
  addIncremental,
  effectiveCap,
  growCap,
  makeWaker,
  wantDigest,
  isWatch,
  isAgentEnv,
  fmtDur,
  shortCwd,
  log,
  passThrough,
  toolName,
};

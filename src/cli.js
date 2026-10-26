'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const pkg = require('../package.json');
const { t, setLang, detectLang } = require('./i18n');
const cfgMod = require('./config');
// Modules are loaded when a command needs them: the common paths (a cache hit, the guard hook that runs before
// every shell command) should not pay to parse code they never use.
const lazy = (load) => {
  let m;
  return new Proxy(
    {},
    {
      get: (_, k) => (m || (m = load()))[k],
    },
  );
};
const queueMod = lazy(() => require('./queue'));
const cacheMod = lazy(() => require('./cache'));
const logsMod = lazy(() => require('./logs'));
const stats = lazy(() => require('./stats'));
const explainMod = lazy(() => require('./explain'));
const runMod = lazy(() => require('./run'));
const guardMod = lazy(() => require('./guard'));
const adapters = lazy(() => require('./adapters'));
const installer = lazy(() => require('./adapters/installer'));
const shim = lazy(() => require('./shim'));
const rulesMod = lazy(() => require('./rules'));
const fmtDur = (...a) => runMod.fmtDur(...a);
const shortCwd = (...a) => runMod.shortCwd(...a);
const log = (...a) => runMod.log(...a);
const run = (...a) => runMod.run(...a);
const runGuard = (...a) => guardMod.runGuard(...a);
const rulesBlock = (...a) => rulesMod.rulesBlock(...a);
const diffComponents = (...a) => explainMod.diffComponents(...a);
const fingerprint = (...a) => cacheMod.fingerprint(...a);
const gitTop = (...a) => cacheMod.gitTop(...a);
const Queue = new Proxy(function () {}, { construct: (_, args) => new queueMod.Queue(...args) });
const Cache = new Proxy(function () {}, { construct: (_, args) => new cacheMod.Cache(...args) });
const Logs = new Proxy(function () {}, { construct: (_, args) => new logsMod.Logs(...args) });

const helpText = () => `szq ${pkg.version} - a shared queue, result cache and guard hooks for heavy verification commands

Usage
  szq [options] [--] <command...>        run a command through the queue
  szq status [--json]                    show running / waiting runs
  szq explain [--] <command...>          why would this run (not) be served from the cache?
  szq logs [show [N]|path]               full output of recent runs
  szq stats [--days N] [--json]          time saved by the cache and by sharing identical runs
  szq cache clear                        remove cached results
  szq config [show|path|set <key> <json>]
  szq hook <install|uninstall|status> <${adapters.list().map((a) => a.id).join('|')}>
        [--project|--local] [--dry-run] [--absolute-node|--no-absolute-node] [--adapter-module <file>]
  szq shim <install|uninstall|status> [--dir <dir>]
  szq rules [--lang en|ko]               print a rules block for AGENTS.md / CLAUDE.md
  szq doctor                             diagnose installation and state

Run options
  --cap N            parallel runs allowed (default: config "concurrency", "auto" = cpus/4)
  --timeout SEC      kill a run after SEC seconds (default 900)
  --stall SEC        kill a run that prints nothing for SEC seconds (default off)
  --max-mem MB       kill a run whose process tree exceeds MB of memory (POSIX; default off)
  --max-wait SEC     give up waiting after SEC seconds, exit 75 (default 1800)
  --exclusive        run alone: wait for an empty queue and block everyone behind it
  --priority P       high | normal | low (default: high when typed in a terminal, else normal)
  --digest           print head, tail and error lines of long output instead of everything
  --no-digest        always print everything
  --no-cache         neither read nor write the result cache
  --changed[=REF]    narrow vitest/jest to changed files (opt-in; only for those two tools)

Exit codes: the command's own code; 64 usage; 70 internal; 75 waited too long;
            124 timed out; 125 stalled; 126 memory limit; 127 failed to start.
Docs: https://github.com/kimyejoon/szq
`;

const SUBCOMMANDS = new Set(['status', 'cache', 'config', 'guard', 'hook', 'shim', 'rules', 'doctor', 'run-shim', 'help', 'logs', 'stats', 'explain']);

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function out(s) {
  process.stdout.write(`${s}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const loaded = cfgMod.loadConfig();
  setLang(detectLang(process.env, loaded.config.lang));
  const ctx = { config: loaded.config, paths: loaded.paths };
  if (loaded.error) log(`config ${loaded.paths.configFile}: ${loaded.error.message} (using defaults)`);

  const args = argv.slice();
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(helpText());
    return 0;
  }
  if (args[0] === '-v' || args[0] === '--version' || args[0] === 'version') {
    out(pkg.version);
    return 0;
  }

  const sub = args[0];
  if (SUBCOMMANDS.has(sub)) {
    try {
      switch (sub) {
        case 'status':
          return cmdStatus(ctx, args.slice(1));
        case 'cache':
          return cmdCache(ctx, args.slice(1));
        case 'config':
          return cmdConfig(ctx, loaded, args.slice(1));
        case 'guard':
          return cmdGuard(args.slice(1));
        case 'hook':
          return cmdHook(ctx, args.slice(1));
        case 'shim':
          return cmdShim(ctx, args.slice(1));
        case 'rules':
          return cmdRules(ctx, args.slice(1));
        case 'doctor':
          return cmdDoctor(ctx, loaded);
        case 'logs':
          return cmdLogs(ctx, args.slice(1));
        case 'stats':
          return cmdStats(ctx, args.slice(1));
        case 'explain':
          return cmdExplain(ctx, args.slice(1));
        case 'run-shim': {
          // Defence in depth against a shim that resolves to itself.
          const depth = Number(process.env.SZQ_SHIM_DEPTH || 0);
          if (depth >= 2) {
            log(`shim recursion detected: the real "${args[1]}" was not found on PATH outside the shim directory`);
            return 70;
          }
          process.env.SZQ_SHIM_DEPTH = String(depth + 1);
          return runCommand(ctx, args.slice(1), {});
        }
        default:
          break;
      }
    } catch (e) {
      if (e && e.szqUnsafe) {
        log(t('stateUnsafe', { dir: ctx.paths.stateDir, why: e.message }));
        return 70;
      }
      throw e;
    }
  }
  return runWithOptions(ctx, args);
}

async function runWithOptions(ctx, args) {
  const opts = { cap: 0, timeout: 0, maxWait: 0, noCache: false, changed: '', digest: undefined, exclusive: false, priority: '' };
  let i = 0;
  const num = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--no-cache') opts.noCache = true;
    else if (a === '--digest') opts.digest = true;
    else if (a === '--no-digest') opts.digest = false;
    else if (a === '--exclusive') opts.exclusive = true;
    else if (a === '--cap') opts.cap = num(args[++i]);
    else if (a === '--timeout') opts.timeout = num(args[++i]);
    else if (a === '--max-wait') opts.maxWait = num(args[++i]);
    else if (a === '--stall') opts.stall = Math.max(0, Number.parseInt(args[++i], 10) || 0);
    else if (a === '--max-mem') opts.maxMem = Math.max(0, Number.parseInt(args[++i], 10) || 0);
    else if (a === '--priority') opts.priority = ['high', 'normal', 'low'].includes(args[i + 1]) ? args[++i] : (i++, '');
    else if (a === '--changed') opts.changed = true;
    else if (a.startsWith('--changed=')) opts.changed = a.slice('--changed='.length) || true;
    else break;
  }
  return runCommand(ctx, args.slice(i), opts);
}

async function runCommand(ctx, argv, opts) {
  if (argv.length === 0) {
    log(t('noCommand'));
    return 64;
  }
  try {
    return await run({ opts, argv, ctx });
  } catch (e) {
    if (e && e.szqUnsafe) {
      log(t('stateUnsafe', { dir: ctx.paths.stateDir, why: e.message }));
      return 70;
    }
    log(t('internal', { msg: e && e.stack ? e.stack : e }));
    return 70;
  }
}

function cmdStatus(ctx, args) {
  cfgMod.ensureStateDirs(ctx.paths);
  const queue = new Queue(ctx.paths);
  const snap = queue.snapshot();
  const cap = cfgMod.resolveConcurrency(ctx.config);
  const cacheCount = new Cache(ctx.paths, ctx.config.cache).count();
  if (args.includes('--json')) {
    const slim = (tk) => ({ pid: tk.pid, cwd: tk.cwd, cmd: tk.cmd, since: tk.startedAt || tk.createdAt, exclusive: Boolean(tk.exclusive), priority: tk.prio });
    out(
      JSON.stringify({
        concurrency: cap,
        load: os.loadavg(),
        cacheEntries: cacheCount,
        running: snap.running.map(slim),
        waiting: snap.waiting.map(slim),
        joined: snap.followers.map(slim),
        guardDisabled: fs.existsSync(ctx.paths.disableFile),
      }),
    );
    return 0;
  }
  out(
    t('statusHead', {
      running: snap.running.length,
      cap,
      waiting: snap.waiting.length,
      joined: snap.followers.length ? t('statusJoined', { n: snap.followers.length }) : '',
      load: os
        .loadavg()
        .map((n) => n.toFixed(1))
        .join(' '),
    }),
  );
  const line = (tk, label) =>
    out(`${label}  pid ${tk.pid}  ${fmtDur(Date.now() - (tk.startedAt || tk.createdAt))}  ${shortCwd(tk.cwd)}  $ ${tk.cmd}${tk.exclusive ? '  [exclusive]' : ''}`);
  snap.running.forEach((tk) => line(tk, t('statusRunning')));
  snap.waiting.forEach((tk, n) => line(tk, `${t('statusWaiting')}${n + 1}`));
  snap.followers.forEach((tk) => line(tk, t('statusJoinedLabel')));
  out(t('statusCache', { n: cacheCount }));
  if (fs.existsSync(ctx.paths.disableFile)) out(t('statusDisable'));
  return 0;
}

function cmdCache(ctx, args) {
  if (args[0] !== 'clear') {
    out('usage: szq cache clear');
    return 64;
  }
  cfgMod.ensureStateDirs(ctx.paths);
  out(t('cacheCleared', { n: new Cache(ctx.paths, ctx.config.cache).clear() }));
  return 0;
}

function cmdLogs(ctx, args) {
  cfgMod.ensureStateDirs(ctx.paths);
  const logs = new Logs(ctx.paths, ctx.config.logs);
  if (args[0] === 'path') {
    out(ctx.paths.logDir);
    return 0;
  }
  const list = logs.list(30);
  if (args[0] === 'show') {
    const n = args[1] === undefined ? 1 : Number.parseInt(args[1], 10);
    const entry = Number.isInteger(n) && n >= 1 ? list[n - 1] : list.find((l) => l.file === path.resolve(args[1]) || l.name === args[1]);
    if (!entry) {
      out(t('noLogs'));
      return 1;
    }
    process.stdout.write(logs.readBody(entry.file));
    return 0;
  }
  if (!list.length) {
    out(t('noLogs'));
    return 0;
  }
  out(t('logsHead'));
  list.forEach((l, i) => {
    const r = l.result || {};
    const when = l.meta.at ? new Date(l.meta.at).toLocaleString() : '?';
    out(`${String(i + 1).padStart(2)}  ${when}  exit ${r.code === undefined || r.code === null ? '?' : r.code}  ${r.ms ? fmtDur(r.ms) : '-'}  ${l.meta.cmd || ''}  ${shortCwd(l.meta.cwd || '')}\n    ${l.file}`);
  });
  return 0;
}

function cmdStats(ctx, args) {
  const days = Number.parseInt(flagValue(args, '--days'), 10) || 7;
  const s = stats.summarize(ctx.paths.statsFile, days);
  if (args.includes('--json')) {
    out(JSON.stringify(s));
    return 0;
  }
  out(t('statsTitle', { days }));
  if (!s.runs) {
    out(t('statsNone'));
    return 0;
  }
  const dur = (ms) => fmtDur(ms);
  out(`requests: ${s.runs}  |  executed: ${s.executed} (${dur(s.workMs)} of work)  |  served from cache: ${s.hits}  |  shared with an identical run: ${s.shared}`);
  out(`work avoided: ${dur(s.savedMs)}   (time other callers spent waiting for shared results: ${dur(s.waitedMs)})`);
  const rows = Object.entries(s.byCmd)
    .sort((a, b) => b[1].savedMs - a[1].savedMs)
    .slice(0, 5);
  for (const [cmd, c] of rows) out(`  ${cmd.padEnd(12)} executed ${c.executed}, cache hits ${c.hits}, shared ${c.shared}, saved ${dur(c.savedMs)}`);
  return 0;
}

function cmdExplain(ctx, args) {
  const argv = args[0] === '--' ? args.slice(1) : args;
  if (!argv.length) {
    log(t('noCommand'));
    return 64;
  }
  cfgMod.ensureStateDirs(ctx.paths);
  const cwd = fs.realpathSync(process.cwd());
  const top = gitTop(cwd);
  if (!top) {
    out(t('explainNoGit'));
    return 0;
  }
  const fp = fingerprint({ cwd, top, argv, cacheEnv: ctx.config.cache.env, extraFiles: ctx.config.cache.extraFiles, statDir: ctx.paths.statDir });
  if (!fp) {
    out(t('explainTooMany'));
    return 0;
  }
  const cache = new Cache(ctx.paths, ctx.config.cache);
  const last = cache.loadLast(fp.components);
  out(`fingerprint ${fp.key.slice(0, 12)}`);
  if (!last) out(t('explainNever'));
  else if (last.key === fp.key) out(t('explainSame'));
  else {
    out(t('explainDiff'));
    const reasons = diffComponents(last.components, fp.components);
    for (const r of reasons.length ? reasons : ['the command line or another input changed']) out(`  - ${r}`);
  }
  out(cache.read(fp.key) ? t('explainHit') : t('explainNoEntry'));
  return 0;
}

function cmdConfig(ctx, loaded, args) {
  const action = args[0] || 'show';
  if (action === 'path') {
    out(ctx.paths.configFile);
    return 0;
  }
  if (action === 'show') {
    out(JSON.stringify(ctx.config, null, 2));
    return 0;
  }
  if (action === 'set' && args.length >= 3) {
    if (loaded.error) {
      log(`refusing to modify ${ctx.paths.configFile}: it is not valid JSON (${loaded.error.message}). Fix or remove it first.`);
      return 64;
    }
    let value;
    try {
      value = JSON.parse(args.slice(2).join(' '));
    } catch {
      value = args.slice(2).join(' ');
    }
    const raw = JSON.parse(JSON.stringify(loaded.raw && typeof loaded.raw === 'object' && !Array.isArray(loaded.raw) ? loaded.raw : {}));
    try {
      cfgMod.setDotted(raw, args[1], value);
    } catch (e) {
      log(e.message);
      return 64;
    }
    const file = ctx.paths.configFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.szq-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    installer.writeJsonAtomic(file, raw, 0o600);
    out(t('configSet', { key: args[1], value: JSON.stringify(value) }));
    return 0;
  }
  out(t('usageConfig'));
  return 64;
}

function cmdGuard(args) {
  const adapterModule = flagValue(args, '--adapter-module');
  const id = args.find((a) => !a.startsWith('--') && a !== adapterModule);
  const res = runGuard(id, { adapterModule });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.exitCode;
}

function pickAdapter(id, adapterModule) {
  if (adapterModule) return adapters.loadExternal(path.resolve(adapterModule));
  return adapters.get(id);
}

function cmdHook(ctx, args) {
  const action = args[0];
  const id = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const flags = args.slice(id ? 2 : 1);
  const scope = flags.includes('--project') ? 'project' : flags.includes('--local') ? 'local' : 'user';
  const adapterModule = flagValue(flags, '--adapter-module');
  const absoluteNode = flags.includes('--absolute-node') ? true : flags.includes('--no-absolute-node') ? false : undefined;
  const common = { scope, dryRun: flags.includes('--dry-run'), absoluteNode, adapterModule };

  if (action === 'status' && !id) {
    for (const a of adapters.list()) {
      const s = installer.status(a, { scope });
      out(`${a.id.padEnd(12)} ${s.installed ? 'installed' : 'not installed'}  ${a.maturity === 'experimental' ? '(experimental) ' : ''}${s.file}${s.error ? `  ! ${s.error}` : ''}`);
    }
    return 0;
  }
  if (!['install', 'uninstall', 'status'].includes(action) || (!id && !adapterModule)) {
    out(`usage: szq hook <install|uninstall|status> <${adapters.list().map((a) => a.id).join('|')}> [--project|--local] [--dry-run] [--absolute-node]`);
    return 64;
  }
  let adapter;
  try {
    adapter = pickAdapter(id, adapterModule);
  } catch (e) {
    log(e.message);
    return 64;
  }
  if (!adapter) {
    log(`unknown adapter "${id}". Built-in: ${adapters.list().map((a) => a.id).join(', ')}`);
    return 64;
  }
  try {
    if (action === 'status') {
      const s = installer.status(adapter, common);
      out(`${adapter.id}: ${s.installed ? 'installed' : 'not installed'} (${s.file})${s.error ? ` ! ${s.error}` : ''}`);
      return 0;
    }
    if (action === 'install') {
      const r = installer.install(adapter, common);
      if (common.dryRun) {
        out(`# dry run - would write ${r.file}\n${r.preview || ''}`);
        return 0;
      }
      out(r.changed ? `installed: ${r.file}${r.backup ? `\nbackup:    ${r.backup}` : ''}` : `already up to date: ${r.file}`);
      out(`hook:      ${r.command}`);
      for (const n of r.notes || []) out(`note: ${n}`);
      return 0;
    }
    const r = installer.uninstall(adapter, common);
    if (common.dryRun) out(`# dry run - would write ${r.file}\n${r.preview || ''}`);
    else out(r.changed ? `removed from: ${r.file}${r.backup ? `\nbackup:       ${r.backup}` : ''}` : `nothing to remove: ${r.file}`);
    return 0;
  } catch (e) {
    log(e.message);
    return 1;
  }
}

function cmdShim(ctx, args) {
  const action = args[0];
  const dir = path.resolve(flagValue(args, '--dir') || ctx.paths.shimDir);
  if (action === 'install') {
    const { written, skipped } = shim.install(dir, ctx.config.guard.commands);
    out(`created ${written.length} shim(s) in ${dir}`);
    for (const s of skipped) out(`skipped: ${s}`);
    out(`activate:  ${shim.pathHint(dir)}`);
    out('note: shims route every call of these tools through the queue, for humans too.');
    return 0;
  }
  if (action === 'uninstall') {
    out(`removed ${shim.uninstall(dir).length} shim(s) from ${dir}`);
    return 0;
  }
  if (action === 'status') {
    const names = shim.list(dir);
    out(`${dir}: ${names.length ? names.join(', ') : 'no shims'}`);
    const onPath = (process.env.PATH || '').split(path.delimiter).some((p) => path.resolve(p) === dir);
    out(`on PATH: ${onPath ? 'yes' : 'no'}`);
    return 0;
  }
  out('usage: szq shim <install|uninstall|status> [--dir <dir>]');
  return 64;
}

function cmdRules(ctx, args) {
  const lang = flagValue(args, '--lang') || (detectLang(process.env, ctx.config.lang) === 'ko' ? 'ko' : 'en');
  process.stdout.write(rulesBlock(lang === 'ko' ? 'ko' : 'en', ctx.config.guard.commands));
  return 0;
}

function cmdDoctor(ctx, loaded) {
  const row = (k, v) => out(`${k.padEnd(14)} ${v}`);
  row('szq', pkg.version);
  row('node', `${process.version} (${process.platform} ${process.arch})`);
  const git = cp.spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  row('git', git.status === 0 ? git.stdout.trim() : 'NOT FOUND (result caching disabled)');
  row('state dir', ctx.paths.stateDir);
  try {
    cfgMod.ensureStateDirs(ctx.paths);
    row('state perms', 'ok');
  } catch (e) {
    row('state perms', `PROBLEM: ${e.message}`);
  }
  row('config', `${ctx.paths.configFile}${fs.existsSync(ctx.paths.configFile) ? '' : ' (not present, defaults)'}${loaded.error ? ` ! ${loaded.error.message}` : ''}`);
  row('concurrency', `${cfgMod.resolveConcurrency(ctx.config)} (cpus ${os.cpus().length}${ctx.config.adaptive.enabled ? `, backs off above load ${ctx.config.adaptive.loadPerCpu}/cpu` : ''})`);
  row('guarded', `${ctx.config.guard.commands.join(', ')} | scripts: ${ctx.config.guard.scripts.join(', ')}`);
  row('DISABLE file', fs.existsSync(ctx.paths.disableFile) ? 'PRESENT - guard hooks allow direct runs' : 'absent');
  for (const a of adapters.list()) {
    const s = installer.status(a, { scope: 'user' });
    row(`hook ${a.id}`, `${s.installed ? 'installed' : 'not installed'}${a.maturity === 'experimental' ? ' (experimental)' : ''}`);
  }
  const shims = shim.list(ctx.paths.shimDir);
  row('shims', shims.length ? shims.join(', ') : 'none');
  return 0;
}

module.exports = { main, helpText };

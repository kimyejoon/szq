'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const pkg = require('../package.json');
const { t, setLang, detectLang } = require('./i18n');
const cfgMod = require('./config');
const { Queue } = require('./queue');
const { Cache } = require('./cache');
const { run, fmtDur, shortCwd, log } = require('./run');
const { runGuard } = require('./guard');
const adapters = require('./adapters');
const installer = require('./adapters/installer');
const shim = require('./shim');
const { rulesBlock } = require('./rules');

const HELP = `szq ${pkg.version} - a shared queue, result cache and guard hooks for heavy verification commands

Usage
  szq [options] [--] <command...>        run a command through the queue
  szq status                             show running / waiting runs
  szq cache clear                        remove cached results
  szq config [show|path|set <key> <json>]
  szq hook <install|uninstall|status> <claude-code|codex|cursor|gemini>
        [--project|--local] [--dry-run] [--absolute-node] [--adapter-module <file>]
  szq shim <install|uninstall|status> [--dir <dir>]
  szq rules [--lang en|ko]               print a rules block for AGENTS.md / CLAUDE.md
  szq doctor                             diagnose installation and state

Run options
  --cap N            parallel runs allowed (default: config "concurrency", "auto" = cpus/4)
  --timeout SEC      kill a run after SEC seconds (default 900)
  --max-wait SEC     give up waiting after SEC seconds, exit 75 (default 1800)
  --no-cache         neither read nor write the result cache
  --changed[=REF]    narrow vitest/jest to changed files (opt-in; only for those two tools)

Exit codes: the command's own code; 64 usage; 70 internal; 75 waited too long; 124 timed out; 127 failed to start.
Docs: https://github.com/kimyejoon/szq
`;

const SUBCOMMANDS = new Set(['status', 'cache', 'config', 'guard', 'hook', 'shim', 'rules', 'doctor', 'run-shim', 'help']);

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
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
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === '-v' || args[0] === '--version' || args[0] === 'version') {
    out(pkg.version);
    return 0;
  }

  const sub = args[0];
  if (SUBCOMMANDS.has(sub)) {
    switch (sub) {
      case 'status':
        return cmdStatus(ctx);
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
  }
  return runWithOptions(ctx, args);
}

async function runWithOptions(ctx, args) {
  const opts = { cap: 0, timeout: 0, maxWait: 0, noCache: false, changed: '' };
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
    else if (a === '--cap') opts.cap = num(args[++i]);
    else if (a === '--timeout') opts.timeout = num(args[++i]);
    else if (a === '--max-wait') opts.maxWait = num(args[++i]);
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

function cmdStatus(ctx) {
  cfgMod.ensureStateDirs(ctx.paths);
  const queue = new Queue(ctx.paths);
  const snap = queue.snapshot();
  const cap = cfgMod.resolveConcurrency(ctx.config);
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
    out(`${label}  pid ${tk.pid}  ${fmtDur(Date.now() - (tk.startedAt || tk.createdAt))}  ${shortCwd(tk.cwd)}  $ ${tk.cmd}`);
  snap.running.forEach((tk) => line(tk, t('statusRunning')));
  snap.waiting.forEach((tk, n) => line(tk, `${t('statusWaiting')}${n + 1}`));
  snap.followers.forEach((tk) => line(tk, t('statusJoinedLabel')));
  out(t('statusCache', { n: new Cache(ctx.paths, ctx.config.cache).count() }));
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
    let value;
    try {
      value = JSON.parse(args.slice(2).join(' '));
    } catch {
      value = args.slice(2).join(' ');
    }
    const raw = loaded.error ? {} : JSON.parse(JSON.stringify(loaded.raw || {}));
    try {
      cfgMod.setDotted(raw, args[1], value);
    } catch (e) {
      log(e.message);
      return 64;
    }
    fs.mkdirSync(path.dirname(ctx.paths.configFile), { recursive: true });
    fs.writeFileSync(ctx.paths.configFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    out(t('configSet', { key: args[1], value: JSON.stringify(value) }));
    return 0;
  }
  out(t('usageConfig'));
  return 64;
}

function cmdGuard(args) {
  const id = args.find((a) => !a.startsWith('--') && a !== flagValue(args, '--adapter-module'));
  const adapterModule = flagValue(args, '--adapter-module');
  const res = runGuard(id, { adapterModule });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.exitCode;
}

function pickAdapter(id, adapterModule) {
  if (adapterModule) return adapters.loadExternal(adapterModule);
  return adapters.get(id);
}

function cmdHook(ctx, args) {
  const action = args[0];
  const id = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const flags = args.slice(id ? 2 : 1);
  const scope = flags.includes('--project') ? 'project' : flags.includes('--local') ? 'local' : 'user';
  const adapterModule = flagValue(flags, '--adapter-module');
  const common = { scope, dryRun: flags.includes('--dry-run'), absoluteNode: flags.includes('--absolute-node'), adapterModule };

  if (action === 'status' && !id) {
    for (const a of adapters.list()) {
      const s = installer.status(a, { scope });
      out(`${a.id.padEnd(12)} ${s.installed ? 'installed' : 'not installed'}  ${a.maturity === 'experimental' ? '(experimental) ' : ''}${s.file}${s.error ? `  ! ${s.error}` : ''}`);
    }
    return 0;
  }
  if (!['install', 'uninstall', 'status'].includes(action) || (!id && !adapterModule)) {
    out('usage: szq hook <install|uninstall|status> <claude-code|codex|cursor|gemini> [--project|--local] [--dry-run] [--absolute-node]');
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
    const files = shim.install(dir, ctx.config.guard.commands);
    out(`created ${files.length} shim(s) in ${dir}`);
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
  row('concurrency', `${cfgMod.resolveConcurrency(ctx.config)} (cpus ${os.cpus().length})`);
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

module.exports = { main, HELP };

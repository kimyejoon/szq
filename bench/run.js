'use strict';
/*
 * Benchmark: what does a shared queue + result cache change when N agents start the same kind of
 * heavy command at the same moment?
 *
 *   node bench/run.js [--agents 8] [--cpu-ms 2000] [--tsc path/to/tsc.js] [--out bench/RESULTS.md]
 *                     [--only ABCDE] [--szq-config '{"headroom":{"cpuBelow":0.8}}']
 *
 * Scenarios
 *   A  N agents run the SAME command on the SAME code      (baseline: all start at once)
 *   B  N agents run N DIFFERENT commands                      (baseline: all start at once)
 *   C  one agent repeats the same command 5 times, code unchanged
 *   D  (optional, needs --tsc) A with a real `tsc --noEmit` on a generated project
 *   E  output volume: how much text an agent receives from a command that prints 2,500 lines
 *
 * The numbers describe THIS machine at THIS moment; background load is recorded in the output.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SZQ = path.join(ROOT, 'bin', 'szq.js');
const BURN = path.join(__dirname, 'burn.js');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const AGENTS = Number(arg('--agents', 8));
const TARGET_CPU_MS = Number(arg('--cpu-ms', 2000));
const TSC = arg('--tsc', null);
const OUT = arg('--out', path.join(__dirname, 'RESULTS.md'));
const ONLY = arg('--only', 'ABCDE').toUpperCase();
const SZQ_CONFIG = arg('--szq-config', null); // JSON merged into the config used by the szq runs
const want = (letter) => ONLY.includes(letter);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) =>
  cp.spawnSync('git', ['-c', 'user.email=b@example.com', '-c', 'user.name=bench', ...a], { cwd, encoding: 'utf8' });

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'szq-bench-repo-')));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function cpuSnapshot() {
  return os.cpus().map((c) => ({ ...c.times }));
}
function utilisation(a, b) {
  let busy = 0;
  let total = 0;
  a.forEach((x, i) => {
    const y = b[i];
    const idle = y.idle - x.idle;
    const all = Object.keys(y).reduce((s, k) => s + (y[k] - x[k]), 0);
    busy += all - idle;
    total += all;
  });
  return total ? (100 * busy) / total : 0;
}

/** Sample whole-machine CPU utilisation while `fn` runs. */
async function withCpuSampler(fn) {
  const samples = [];
  let prev = cpuSnapshot();
  const timer = setInterval(() => {
    const cur = cpuSnapshot();
    samples.push(utilisation(prev, cur));
    prev = cur;
  }, 200);
  const t0 = Date.now();
  const result = await fn();
  const wall = Date.now() - t0;
  clearInterval(timer);
  const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  return { result, wall, avgCpu: avg, peakCpu: Math.max(0, ...samples) };
}

function spawnAll(specs) {
  return Promise.all(
    specs.map(
      (s) =>
        new Promise((resolve) => {
          const c = cp.spawn(s.cmd, s.args, { cwd: s.cwd, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = '';
          c.stderr.on('data', (b) => (stderr += b));
          c.stdout.resume();
          c.on('close', (code) => resolve({ code, stderr }));
        }),
    ),
  );
}

function spawnAllCapture(specs) {
  return Promise.all(
    specs.map(
      (s) =>
        new Promise((resolve) => {
          const c = cp.spawn(s.cmd, s.args, { cwd: s.cwd, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          c.stdout.on('data', (b) => (stdout += b));
          c.stderr.resume();
          c.on('close', (code) => resolve({ code, stdout }));
        }),
    ),
  );
}

function readMarkers(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function maxConcurrent(markers) {
  const ev = [];
  for (const m of markers) ev.push([m.start, 1], [m.end, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

async function calibrate() {
  const f = path.join(os.tmpdir(), `szq-calib-${process.pid}.txt`);
  let iters = 2e7;
  for (let n = 0; n < 3; n++) {
    fs.rmSync(f, { force: true });
    await spawnAll([{ cmd: process.execPath, args: [BURN, String(iters), f, 'cal'], env: process.env }]);
    const m = readMarkers(f)[0];
    if (m) iters = Math.round((iters * TARGET_CPU_MS) / Math.max(50, m.cpuMs));
  }
  fs.rmSync(f, { force: true });
  return iters;
}

function freshEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'szq-bench-home-'));
  const configFile = path.join(home, 'config.json');
  if (SZQ_CONFIG) fs.writeFileSync(configFile, SZQ_CONFIG);
  const env = { ...process.env, SZQ_HOME: home, SZQ_CONFIG: configFile, SZQ_LANG: 'en' };
  delete env.CLAUDECODE;
  return { home, env };
}

function summarise(label, run, markers, results) {
  const executed = markers.length || results.filter((r) => /\(ran /.test(r.stderr)).length;
  const cpuSum = markers.length ? markers.reduce((s, m) => s + m.cpuMs, 0) / 1000 : null;
  return {
    label,
    wallS: +(run.wall / 1000).toFixed(2),
    executions: executed,
    maxParallel: markers.length ? maxConcurrent(markers) : null,
    cpuSecondsOfWork: cpuSum === null ? null : +cpuSum.toFixed(1),
    avgCpuPct: +run.avgCpu.toFixed(0),
    peakCpuPct: +run.peakCpu.toFixed(0),
    failures: results.filter((r) => r.code !== 0).length,
  };
}

async function scenario(name, build) {
  const base = await build(false);
  const viaSzq = await build(true);
  return { name, rows: [base, viaSzq] };
}

async function main() {
  const idleSample = await withCpuSampler(() => sleep(2000));
  const load = os.loadavg();
  const iters = await calibrate();
  const repo = mkRepo();
  const cores = os.cpus().length;
  const report = {
    date: new Date().toISOString(),
    machine: `${os.cpus()[0].model.trim()} x${cores}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB, ${process.platform} ${os.release()}`,
    node: process.version,
    agents: AGENTS,
    cpuMsPerJob: TARGET_CPU_MS,
    backgroundCpuPct: +idleSample.avgCpu.toFixed(0),
    loadavgAtStart: load.map((n) => +n.toFixed(1)),
    szqConcurrency: Math.max(1, Math.floor(cores / 4)),
    scenarios: [],
  };

  const burnArgs = (marker, id) => [BURN, String(iters), marker, id];

  // ---- A: same command ----
  if (want('A')) report.scenarios.push(
    await scenario('A. same command, same code, all agents at once', async (useSzq) => {
      const { home, env } = freshEnv();
      const marker = path.join(home, 'm.jsonl');
      const specs = Array.from({ length: AGENTS }, () =>
        useSzq
          ? { cmd: process.execPath, args: [SZQ, '--', process.execPath, ...burnArgs(marker, 'same')], cwd: repo, env }
          : { cmd: process.execPath, args: burnArgs(marker, 'same'), cwd: repo, env },
      );
      const run = await withCpuSampler(() => spawnAll(specs));
      return summarise(useSzq ? 'with szq' : 'without szq', run, readMarkers(marker), run.result);
    }),
  );

  // ---- B: different commands ----
  if (want('B')) report.scenarios.push(
    await scenario('B. different commands, all agents at once', async (useSzq) => {
      const { home, env } = freshEnv();
      const marker = path.join(home, 'm.jsonl');
      const specs = Array.from({ length: AGENTS }, (_, i) =>
        useSzq
          ? { cmd: process.execPath, args: [SZQ, '--', process.execPath, ...burnArgs(marker, `d${i}`)], cwd: repo, env }
          : { cmd: process.execPath, args: burnArgs(marker, `d${i}`), cwd: repo, env },
      );
      const run = await withCpuSampler(() => spawnAll(specs));
      return summarise(useSzq ? 'with szq' : 'without szq', run, readMarkers(marker), run.result);
    }),
  );

  // ---- C: repeated run, unchanged code ----
  if (want('C')) {
    const { home, env } = freshEnv();
    const marker = path.join(home, 'm.jsonl');
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      await spawnAll([{ cmd: process.execPath, args: [SZQ, '--', process.execPath, ...burnArgs(marker, 'rep')], cwd: repo, env }]);
      times.push(+((Date.now() - t0) / 1000).toFixed(2));
    }
    report.repeat = { secondsPerCall: times, executions: readMarkers(marker).length };
  }

  // ---- D: real tsc (optional) ----
  if (want('D') && TSC && fs.existsSync(TSC)) {
    const proj = mkRepo();
    cp.spawnSync(process.execPath, [path.join(__dirname, 'gen-ts-project.js'), proj, '400'], { stdio: 'ignore' });
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'ts');
    const tscArgs = [TSC, '--noEmit', '-p', '.'];
    report.scenarios.push(
      await scenario('D. real `tsc --noEmit` (generated project), same code, all agents at once', async (useSzq) => {
        const { env } = freshEnv();
        const specs = Array.from({ length: AGENTS }, () =>
          useSzq
            ? { cmd: process.execPath, args: [SZQ, '--', process.execPath, ...tscArgs], cwd: proj, env }
            : { cmd: process.execPath, args: tscArgs, cwd: proj, env },
        );
        const run = await withCpuSampler(() => spawnAll(specs));
        return summarise(useSzq ? 'with szq' : 'without szq', run, [], run.result);
      }),
    );
  }

  // ---- E: output volume (what an agent has to read) ----
  if (want('E')) {
    const { env } = freshEnv();
    const noisy = `for(let i=0;i<2000;i++)console.log('  ok test '+i);console.log('src/a.ts(1,1): error TS2322: Type string is not assignable to type number.');console.log('Found 1 error.');for(let i=0;i<500;i++)console.log('  ok more '+i)`;
    const sizeOf = async (extra) => {
      const [res] = await spawnAllCapture([{ cmd: process.execPath, args: [SZQ, '--no-cache', ...extra, '--', process.execPath, '-e', noisy], cwd: repo, env }]);
      return { bytes: Buffer.byteLength(res.stdout), lines: res.stdout.split('\n').length - 1, keptError: /error TS2322/.test(res.stdout) };
    };
    const full = await sizeOf(['--no-digest']);
    const dig = await sizeOf(['--digest']);
    report.output = { full, digest: dig, reductionPct: +(100 * (1 - dig.bytes / full.bytes)).toFixed(0), approxTokens: { full: Math.round(full.bytes / 4), digest: Math.round(dig.bytes / 4) } };
  }

  fs.writeFileSync(path.join(path.dirname(OUT), 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(OUT, toMarkdown(report));
  process.stdout.write(toMarkdown(report));
}

function toMarkdown(r) {
  const cell = (v, suffix = '') => (v === null || v === undefined ? 'n/a' : `${v}${suffix}`);
  let md = `# Benchmark results\n\n`;
  md += `- Date: ${r.date}\n- Machine: ${r.machine}\n- Node: ${r.node}\n`;
  md += `- ${r.agents} simultaneous "agents"; each job is ~${r.cpuMsPerJob} ms of single-core CPU work when run alone\n`;
  if (SZQ_CONFIG) md += `- szq config for this run: \`${SZQ_CONFIG}\`\n`;
  md += `- szq concurrency: ${r.szqConcurrency} (cpus/4); background CPU use before the run: ${r.backgroundCpuPct}%; load average at start: ${r.loadavgAtStart.join(' ')}\n\n`;
  md += `> Numbers describe this machine at this moment. Other processes (background load above) add noise; re-run \`npm run bench\` on your own hardware.\n\n`;
  for (const s of r.scenarios) {
    md += `## ${s.name}\n\n| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |\n|---|---|---|---|---|---|---|\n`;
    for (const x of s.rows) {
      md += `| ${x.label} | ${x.wallS} s | ${x.executions} | ${cell(x.maxParallel)} | ${cell(x.cpuSecondsOfWork)} | ${x.avgCpuPct} | ${x.peakCpuPct} |\n`;
    }
    md += '\n';
  }
  if (r.output) {
    const o = r.output;
    md += `## E. output volume (what an agent has to read)\n\nA command that prints ${o.full.lines} lines, one of them an error:\n\n| | lines | bytes | ~tokens (bytes/4) | kept the error line |\n|---|---|---|---|---|\n`;
    md += `| plain output | ${o.full.lines} | ${o.full.bytes} | ${o.approxTokens.full} | ${o.full.keptError} |\n| \`--digest\` | ${o.digest.lines} | ${o.digest.bytes} | ${o.approxTokens.digest} | ${o.digest.keptError} |\n\n${o.reductionPct}% less text.\n\n`;
  }
  if (r.repeat) md += `## C. one agent repeating the same command, code unchanged\n\nSeconds per call: ${r.repeat.secondsPerCall.join(', ')} - the command actually ran ${r.repeat.executions} time(s).\n`;
  return md;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

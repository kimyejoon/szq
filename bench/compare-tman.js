'use strict';
// Download a release binary yourself; this benchmark does not install tools or change global settings.
// Run through your verification queue: szq node bench/compare-tman.js --tman /path/to/tman --out /tmp/comparison.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert/strict');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { mkRepo, tmpDir } = require('../test/helpers');

const value = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const positive = (name, fallback) => {
  const n = Number(value(name, fallback));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};
const tman = value('--tman', null);
if (!tman || !path.isAbsolute(tman) || !fs.existsSync(tman)) throw new Error('--tman needs an absolute path to a release binary');
const rounds = positive('--rounds', 3);
const agents = positive('--agents', 8);
const cap = positive('--cap', 2);
const cpuMs = positive('--cpu-ms', 500);
const tsc = value('--tsc', null);
if (tsc && (!path.isAbsolute(tsc) || !fs.existsSync(tsc))) throw new Error('--tsc needs an absolute path to typescript/bin/tsc');
const out = path.resolve(value('--out', path.join(__dirname, 'tman-results.json')));
const szq = path.resolve(__dirname, '../bin/szq.js');
const burn = path.resolve(__dirname, 'burn.js');
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const markers = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function maxParallel(work) {
  const events = work.flatMap((m) => [[m.start, 1], [m.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0, max = 0;
  for (const [, delta] of events) { live += delta; max = Math.max(max, live); }
  return max;
}

function sourceDigest() {
  const hash = crypto.createHash('sha256');
  const root = path.resolve(__dirname, '..');
  const visit = (relative) => {
    const full = path.join(root, relative);
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    } else hash.update(relative).update('\0').update(fs.readFileSync(full)).update('\0');
  };
  for (const name of ['src', 'bin', 'package.json', 'bench/compare-tman.js', 'bench/burn.js', 'bench/gen-ts-project.js']) visit(name);
  return hash.digest('hex');
}

function invoke(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function environment(home) {
  const env = { ...process.env, TMAN_HOME: path.join(home, 'tman'), SZQ_HOME: path.join(home, 'szq'),
    SZQ_CONFIG: path.join(home, 'szq.json'), SZQ_LANG: 'en' };
  // The outer verification queue must not turn the benchmark's szq calls into nested pass-throughs.
  for (const k of ['SZQ_ACTIVE', 'SZQ_CONCURRENCY', 'CLAUDECODE', 'SZQ_AGENT', 'TMAN_RUN_ID']) delete env[k];
  fs.writeFileSync(env.SZQ_CONFIG, JSON.stringify({ concurrency: cap, adaptive: { enabled: false }, output: { digest: 'never' } }));
  return env;
}

async function main() {
  const version = await invoke(tman, ['--version']);
  assert.equal(version.code, 0, version.stderr);
  const calibration = tmpDir('szq-compare-cal-');
  const marker = path.join(calibration, 'work.jsonl');
  let iterations = 1e7;
  for (let i = 0; i < 2; i++) {
    const r = await invoke(process.execPath, [burn, String(iterations), marker, 'calibrate']);
    assert.equal(r.code, 0, r.stderr);
    const work = markers(marker).at(-1);
    iterations = Math.max(1, Math.round(iterations * cpuMs / Math.max(1, work.cpuMs)));
  }
  const digest = sourceDigest();
  const report = { date: new Date().toISOString(), node: process.version, tman: version.stdout.trim(), sourceDigest: digest,
    tmanBinarySha256: crypto.createHash('sha256').update(fs.readFileSync(tman)).digest('hex'),
    machine: { model: os.cpus()[0].model, cpus: os.cpus().length, platform: process.platform, arch: process.arch },
    rounds, agents, cap, cpuMs, iterations, tscVersion: tsc ? (await invoke(process.execPath, [tsc, '--version'])).stdout.trim() : null,
    method: 'Alternating tool order; fresh repositories/state per sample; equal fixed cap; tman --no-queue --max-parallel; szq adaptive disabled; all callers must exit 0 and receive the expected output.',
    samples: [], summary: [] };
  const cases = value('--only', tsc ? 'cold-empty,same-concurrent,distinct-concurrent,warm-repeat,same-tsc,warm-tsc'
    : 'cold-empty,same-concurrent,distinct-concurrent,warm-repeat').split(',');
  const known = new Set(['cold-empty', 'same-concurrent', 'distinct-concurrent', 'warm-repeat', 'same-tsc', 'warm-tsc']);
  for (const c of cases) if (!known.has(c) || (c.endsWith('-tsc') && !tsc)) throw new Error(`unsupported scenario: ${c}`);
  for (const scenario of cases) {
    const repeated = scenario.startsWith('warm-');
    const typescript = scenario.endsWith('-tsc');
    for (let round = 0; round < rounds; round++) {
      for (const tool of round % 2 ? ['szq', 'tman'] : ['tman', 'szq']) {
        const repo = mkRepo();
        const home = tmpDir('szq-compare-state-');
        const env = environment(home);
        // tman's output logs are not input code; neither tool should invalidate itself by writing logs.
        fs.writeFileSync(path.join(repo, '.gitignore'), '.tman/\n');
        const file = path.join(home, 'work.jsonl');
        const worker = path.join(home, 'tsc-job.js');
        if (typescript) {
          const generated = await invoke(process.execPath, [path.join(__dirname, 'gen-ts-project.js'), repo, '400']);
          assert.equal(generated.code, 0, generated.stderr);
          fs.writeFileSync(worker, `const fs=require('fs'),cp=require('child_process');
            const start=Date.now();
            const r=cp.spawnSync(process.execPath,[${JSON.stringify(tsc)},'--noEmit','-p','.'],{encoding:'utf8'});
            process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
            if(r.status!==0)process.exit(r.status||1);
            fs.appendFileSync(${JSON.stringify(file)},JSON.stringify({id:'same',start,end:Date.now(),cpuMs:null})+'\\n');
            console.log('burn same done');`);
        }
        const command = (id) => scenario === 'cold-empty' ? ['-e', 'console.log("empty-ok")']
          : typescript ? [worker] : [burn, String(iterations), file, id];
        const call = (id) => {
          const args = command(id);
          return tool === 'szq'
            ? invoke(process.execPath, [szq, '--', process.execPath, ...args], { cwd: repo, env })
            : invoke(tman, ['run', '--no-queue', '--max-parallel', String(cap), '--', process.execPath, ...args], { cwd: repo, env });
        };
        const check = (r, id) => {
          assert.equal(r.code, 0, `${tool}/${scenario}: ${r.stderr}`);
          assert.ok(r.stdout.includes(scenario === 'cold-empty' ? 'empty-ok' : `burn ${id} done`), `${tool}/${scenario}: missing result`);
        };
        if (repeated) check(await call('same'), 'same');
        const before = markers(file).length;
        const load = os.loadavg();
        const start = performance.now();
        const latencies = [];
        let responses;
        if (repeated) {
          responses = [];
          for (let i = 0; i < agents; i++) {
            const t0 = performance.now();
            const r = await call('same');
            check(r, 'same');
            latencies.push(performance.now() - t0);
            responses.push(r);
          }
        } else {
          const ids = Array.from({ length: scenario === 'cold-empty' ? 1 : agents }, (_, i) => scenario === 'distinct-concurrent' ? `job${i}` : 'same');
          responses = await Promise.all(ids.map(async (id) => {
            const r = await call(id);
            check(r, id);
            latencies.push(performance.now() - start);
            return r;
          }));
        }
        const wallMs = performance.now() - start;
        assert.equal(sourceDigest(), digest, 'source changed during measurement; discard the run and restart');
        const work = markers(file).slice(before);
        const expected = scenario === 'cold-empty' ? 0 : tool === 'szq' && repeated ? 0
          : tool === 'szq' && scenario.startsWith('same-') ? 1 : agents;
        assert.equal(work.length, expected, `${tool}/${scenario}: unexpected execution count`);
        const peak = maxParallel(work);
        assert.ok(peak <= cap, `${tool}/${scenario}: exceeded cap (${peak} > ${cap})`);
        // A nonzero counter verifies that the nested-queue environment did not bypass szq.
        const shared = responses.filter((r) => /cache hit|reused the result/.test(r.stderr)).length;
        const row = { scenario, round, tool, wallMs, responseMedianMs: median(latencies),
          executions: work.length, maxParallel: peak, cpuMs: typescript ? null : work.reduce((s, m) => s + m.cpuMs, 0), responses: responses.length, shared, load };
        report.samples.push(row);
        process.stdout.write(`${scenario} #${round + 1} ${tool}: ${wallMs.toFixed(1)} ms, executions=${work.length}, responses=${responses.length}\n`);
        fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
      }
    }
    const rows = report.samples.filter((r) => r.scenario === scenario);
    const ms = (tool) => median(rows.filter((r) => r.tool === tool).map((r) => r.wallMs));
    report.summary.push({ scenario, tmanMedianMs: ms('tman'), szqMedianMs: ms('szq'), speedup: ms('tman') / ms('szq') });
  }
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.table(report.summary);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ENTRY = path.resolve(__dirname, '..', 'bin', 'szq.js');

function tmpDir(prefix = 'szq-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = cp.spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A throw-away git repository with one commit. */
function mkRepo() {
  const dir = tmpDir('szq-repo-');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** Isolated state + config for one test. */
function mkEnv(extra = {}) {
  const home = tmpDir('szq-home-');
  const env = { ...process.env };
  for (const k of ['SZQ_ACTIVE', 'SZQ_CONCURRENCY', 'CLAUDECODE', 'SZQ_AGENT']) delete env[k]; // digest-by-default depends on these
  Object.assign(env, { SZQ_HOME: home, SZQ_CONFIG: path.join(home, 'config.json'), SZQ_LANG: 'en' }, extra);
  // The machine running the tests may be busy; adaptive throttling would make scheduling tests flaky.
  // (It has its own pure-function tests.)
  fs.writeFileSync(env.SZQ_CONFIG, JSON.stringify({ adaptive: { enabled: false } }));
  return { home, env };
}

/** Run the szq CLI; resolves with { code, stdout, stderr }. */
function szq(args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [ENTRY, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

/** Start without waiting; returns { child, done: Promise }. */
function szqStart(args, { cwd, env } = {}) {
  const child = cp.spawn(process.execPath, [ENTRY, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => (stdout += b));
  child.stderr.on('data', (b) => (stderr += b));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A node one-liner that appends a marker line to `file` and then waits `ms`. */
function job(file, marker, ms = 0, exitCode = 0) {
  const src =
    `require('fs').appendFileSync(${JSON.stringify(file)},${JSON.stringify(`${marker}:`)}+process.pid+':'+Date.now()+'\\n');` +
    `setTimeout(()=>{console.log(${JSON.stringify(`out-${marker}`)});process.exit(${exitCode})},${ms})`;
  return ['node', '-e', src];
}

function lines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { ENTRY, tmpDir, git, mkRepo, mkEnv, szq, szqStart, sleep, job, lines };

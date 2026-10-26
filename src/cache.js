'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./queue');
const { sleepSync } = require('./platform');

const KEY_VERSION = 'szq-key-2';
const MAX_FILES = 20000;
const MAX_HASHED_BYTES = 5 * 1024 * 1024;
const MAX_SUBMODULE_DEPTH = 2;
const MAX_FILES_IN_LAST = 5000;
// Like git's "racily clean" rule: a stat entry is only trusted if the file had been quiet for this long when we
// hashed it. A same-size rewrite within the timestamp granularity of the file system would otherwise be missed.
const RACY_MS = 2000;

// git runs in repositories we do not control. We only ever ask it to LIST files (`ls-files`), which neither
// applies clean/smudge filters nor runs textconv/external-diff helpers; contents are hashed by szq itself.
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };

function gitText(args, cwd) {
  // One retry when git could not even be started or was killed (EAGAIN/ENOMEM on a saturated machine): without
  // a fingerprint a run cannot be shared or cached, so a transient spawn failure is worth another try.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = cp.spawnSync('git', [...GIT_SAFE, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.status === 0) return r.stdout;
    if (!r.error && r.status !== null) return null; // git ran and said no (not a repository, ...)
    sleepSync(60);
  }
  return null;
}

/**
 * Repository root found by walking up to the nearest `.git` (a directory, or a file for worktrees and
 * submodules) - the same answer as `git rev-parse --show-toplevel` without starting a process (~20-40 ms).
 * Falls back to git itself when GIT_DIR / GIT_WORK_TREE are in play.
 */
function findRepoTop(cwd) {
  let dir = cwd;
  for (;;) {
    try {
      const st = fs.statSync(path.join(dir, '.git'));
      if (st.isDirectory() || st.isFile()) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitTop(cwd) {
  if (!process.env.GIT_DIR && !process.env.GIT_WORK_TREE) return findRepoTop(cwd);
  const out = gitText(['rev-parse', '--show-toplevel'], cwd);
  return out ? out.trim() : null;
}

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const short = (data) => sha(data).slice(0, 32);

// ---------- stat cache: avoid re-reading files that did not change ----------

class StatStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.dirty = false;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.v === 1 && d.files) for (const [k, v] of Object.entries(d.files)) this.map.set(k, v);
    } catch {
      /* no cache yet */
    }
  }

  lookup(rel, st) {
    const e = this.map.get(rel);
    return e && e[0] === st.size && e[1] === st.mtimeMs && e[2] === st.ctimeMs ? e[3] : null;
  }

  put(rel, st, hash, now = Date.now()) {
    if (now - Math.max(st.mtimeMs, st.ctimeMs) < RACY_MS) return; // too fresh to trust a (size, mtime) match later
    this.map.set(rel, [st.size, st.mtimeMs, st.ctimeMs, hash]);
    this.dirty = true;
  }

  save() {
    if (!this.dirty || this.map.size > 100000) return;
    try {
      writeJsonAtomic(this.file, { v: 1, files: Object.fromEntries(this.map) });
    } catch {
      /* best effort */
    }
  }
}

/** Content hash of one path. Symlinks by target, special files (FIFOs, sockets) are never opened. */
function fileHash(full, rel, store) {
  let st;
  try {
    st = fs.lstatSync(full);
  } catch {
    return 'gone';
  }
  try {
    if (st.isSymbolicLink()) return `link:${short(fs.readlinkSync(full))}`;
    if (!st.isFile()) return `special:${st.mode & 0o170000}`;
    if (st.size > MAX_HASHED_BYTES) return `big:${st.size}:${Math.floor(st.mtimeMs)}:${Math.floor(st.ctimeMs)}:${st.ino}`;
    const cached = store.lookup(rel, st);
    if (cached) return cached;
    const h = short(fs.readFileSync(full));
    store.put(rel, st, h);
    return h;
  } catch {
    return 'unreadable';
  }
}

/**
 * Commands such as `vitest --changed=origin/dev` depend on commits, not only on the files: the same tree gives a
 * different answer when HEAD or the ref moves. For those, the resolved commit ids join the key.
 * Returns '' when the command line has no such flag.
 */
function refState(top, argv) {
  const refs = [];
  let any = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--onlyChanged') any = true;
    else if (a === '--changed' || a === '--changedSince') {
      any = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) refs.push(argv[i + 1]);
    } else if (/^--changed(Since)?=/.test(a)) {
      any = true;
      refs.push(a.slice(a.indexOf('=') + 1));
    }
  }
  if (!any) return '';
  const safe = refs.filter((r) => /^[\w./@^~{}:+-]{1,200}$/.test(r) && !r.startsWith('-'));
  const r = cp.spawnSync('git', [...GIT_SAFE, 'rev-parse', '--quiet', 'HEAD', ...safe.map((x) => `${x}^{commit}`)], {
    cwd: top,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
    windowsHide: true,
  });
  return `${(r.stdout || '').trim().replace(/\s+/g, ',')}|unresolved:${refs.length - safe.length}`;
}

const lp = (s) => `${Buffer.byteLength(s)}:${s}`; // length-prefixed: no field can run into the next

/**
 * Hash every tracked file (as it is in the working tree, deleted ones included), every untracked file that
 * is not ignored, and - recursively - initialised submodules. Returns null when git cannot answer.
 */
function hashTree(top, store, prefix, depth) {
  // ONE process for both lists: `-t` tags every line (H/S/M = tracked, ? = untracked), so a file name can never
  // be mistaken for the other kind.
  const listing = gitText(['ls-files', '-t', '-s', '-o', '--exclude-standard', '-z'], top);
  if (listing === null) return null;
  const entries = new Map(); // path -> isGitlink
  const untracked = [];
  for (const line of listing.split('\0')) {
    if (!line) continue;
    if (line.startsWith('? ')) {
      untracked.push(line.slice(2));
      continue;
    }
    const m = /^[A-Z] (\d+) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(line);
    if (m) entries.set(m[2], m[1] === '160000');
  }
  for (const p of untracked) if (!entries.has(p)) entries.set(p, false);
  if (entries.size > MAX_FILES) return { tooMany: true };

  const files = {};
  for (const p of [...entries.keys()].sort()) {
    if (entries.get(p)) {
      const sub = path.join(top, p);
      if (depth >= MAX_SUBMODULE_DEPTH) files[p] = 'sub:too-deep';
      else if (!fs.existsSync(path.join(sub, '.git'))) files[p] = 'sub:uninitialised';
      else {
        const r = hashTree(sub, store, `${prefix}${p}/`, depth + 1);
        files[p] = !r || r.tooMany ? 'sub:unreadable' : `sub:${r.hash}`;
      }
    } else files[p] = fileHash(path.join(top, p), prefix + p, store);
  }
  const h = crypto.createHash('sha256');
  for (const p of Object.keys(files)) h.update(lp(p)).update(lp(files[p]));
  return { hash: h.digest('hex'), files };
}

/**
 * Fingerprint of "this command on this exact working tree".
 * Returns { key, components } or null when it cannot be computed (not a git repo, too many files, ...).
 * Files ignored by git are NOT included (see docs/ARCHITECTURE.md) - except those listed in `extraFiles`.
 */
function fingerprint({ cwd, top, argv, cacheEnv = [], extraFiles = [], env = process.env, statDir }) {
  const gitState = refState(top, argv);
  const store = new StatStore(path.join(statDir, `${short(top)}.json`));
  const tree = hashTree(top, store, '', 0);
  if (!tree || tree.tooMany) {
    store.save();
    return null;
  }
  const extras = {};
  for (const rel of extraFiles) extras[rel] = fileHash(path.join(top, rel), `extra:${rel}`, store);
  store.save();
  // values are stored only as hashes: the key and the `last` records must not retain secrets
  const envPairs = cacheEnv.map((k) => [k, env[k] === undefined ? null : short(String(env[k]))]);
  const components = {
    treeHash: tree.hash,
    files: Object.keys(tree.files).length <= MAX_FILES_IN_LAST ? tree.files : null,
    cwdRel: path.relative(top, cwd),
    argv,
    node: process.version,
    platform: process.platform,
    env: envPairs,
    extras,
    salt: env.SZQ_CACHE_SALT || '',
    gitState,
  };
  const key = sha(JSON.stringify([KEY_VERSION, components.treeHash, components.cwdRel, argv, components.node, components.platform, envPairs, extras, components.salt, gitState]));
  return { key, components };
}

/** Convenience wrapper used by tests and the programmatic API. */
async function stateKey(opts) {
  const statDir = opts.statDir || path.join(require('os').tmpdir(), `szq-stat-${process.pid}`);
  fs.mkdirSync(statDir, { recursive: true });
  const fp = fingerprint({ ...opts, statDir });
  return fp ? fp.key : null;
}

// ---------- result cache ----------

class Cache {
  constructor(paths, cfg) {
    this.dir = paths.cacheDir;
    this.lastDir = paths.lastDir;
    this.cfg = cfg;
  }

  file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  read(key) {
    let c;
    try {
      c = JSON.parse(fs.readFileSync(this.file(key), 'utf8'));
    } catch {
      return null;
    }
    if (!c || c.v !== 1 || !Array.isArray(c.chunks) || typeof c.code !== 'number') return null;
    if (Date.now() - c.at > (c.ttl || this.cfg.successTtlHours * 3600 * 1000)) return null;
    return c;
  }

  /** Successful runs are kept for hours; ordinary failures (exit 1..123) briefly. Timeouts/signals never. */
  write(key, { code, cmd, chunks, ms, logFile }) {
    const ttl =
      code === 0 ? this.cfg.successTtlHours * 3600 * 1000 : code >= 1 && code <= 123 ? this.cfg.failureTtlMinutes * 60 * 1000 : 0;
    if (!ttl) return false;
    try {
      // only the command name is stored, never its arguments (they may contain tokens)
      writeJsonAtomic(this.file(key), { v: 1, at: Date.now(), ttl, code, cmd, ms, logFile: logFile || null, chunks });
      return true;
    } catch {
      return false;
    }
  }

  /** Housekeeping is not needed on every call: run it for roughly one call in sixteen. */
  prune(force = false) {
    if (!force && Math.random() > 1 / 16) return;
    try {
      for (const n of fs.readdirSync(this.dir)) {
        const f = path.join(this.dir, n);
        const st = fs.statSync(f);
        if (Date.now() - st.mtimeMs > this.cfg.successTtlHours * 3600 * 1000) fs.unlinkSync(f);
      }
    } catch {
      /* best effort */
    }
  }

  clear() {
    let n = 0;
    for (const dir of [this.dir, this.lastDir]) {
      try {
        for (const name of fs.readdirSync(dir)) {
          fs.unlinkSync(path.join(dir, name));
          if (dir === this.dir) n++;
        }
      } catch {
        /* nothing to clear */
      }
    }
    return n;
  }

  count() {
    try {
      return fs.readdirSync(this.dir).length;
    } catch {
      return 0;
    }
  }

  // ---- "last run" records: what `szq explain` compares against ----

  lastFile(components) {
    return path.join(this.lastDir, `${short(`${components.cwdRel}\0${components.argv.join('\0')}`)}.json`);
  }

  saveLast(key, components) {
    try {
      // the command line is deliberately not persisted (arguments may contain tokens); it only names the file
      writeJsonAtomic(this.lastFile(components), { v: 1, at: Date.now(), key, components: { ...components, argv: undefined } });
      const names = Math.random() < 1 / 16 ? fs.readdirSync(this.lastDir) : [];
      if (names.length > 300) {
        const old = names
          .map((n) => [n, fs.statSync(path.join(this.lastDir, n)).mtimeMs])
          .sort((a, b) => a[1] - b[1])
          .slice(0, names.length - 300);
        for (const [n] of old) fs.unlinkSync(path.join(this.lastDir, n));
      }
    } catch {
      /* best effort */
    }
  }

  loadLast(components) {
    try {
      const d = JSON.parse(fs.readFileSync(this.lastFile(components), 'utf8'));
      return d && d.v === 1 ? d : null;
    } catch {
      return null;
    }
  }
}

module.exports = { Cache, fingerprint, stateKey, gitTop, findRepoTop, gitText, fileHash, StatStore };

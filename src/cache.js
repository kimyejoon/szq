'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./queue');

const KEY_VERSION = 'szq-key-1';
const MAX_UNTRACKED_FILES = 5000;
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;

// git runs in repositories we do not control: never let repo config run helper programs.
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };

function gitSpawn(args, cwd, stdio) {
  return cp.spawn('git', [...GIT_SAFE, ...args], { cwd, env: { ...process.env, ...GIT_ENV }, stdio, windowsHide: true });
}

function gitText(args, cwd) {
  const r = cp.spawnSync('git', [...GIT_SAFE, ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return r.status === 0 ? r.stdout : null;
}

function gitTop(cwd) {
  const out = gitText(['rev-parse', '--show-toplevel'], cwd);
  return out ? out.trim() : null;
}

/** Stream a git command's stdout into a hash. Resolves false if git failed. */
function gitIntoHash(args, cwd, hash) {
  return new Promise((resolve) => {
    let child;
    try {
      child = gitSpawn(args, cwd, ['ignore', 'pipe', 'ignore']);
    } catch {
      return resolve(false);
    }
    child.stdout.on('data', (b) => hash.update(b));
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Fingerprint of "this command on this exact working tree".
 * HEAD + tracked changes (diff) + untracked file contents + command line + a few environment inputs.
 * Ignored files (node_modules, build output) are NOT part of it - see docs/ARCHITECTURE.md.
 */
async function stateKey({ cwd, top, argv, cacheEnv = [], env = process.env }) {
  const h = crypto.createHash('sha256');
  h.update(KEY_VERSION);
  const head = gitText(['rev-parse', 'HEAD'], top);
  if (head === null) return null;
  h.update(head);
  const diffOk = await gitIntoHash(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'], top, h);
  if (!diffOk) return null;
  const untracked = gitText(['ls-files', '-o', '--exclude-standard', '-z'], top);
  if (untracked === null) return null;
  for (const rel of untracked.split('\0').filter(Boolean).sort().slice(0, MAX_UNTRACKED_FILES)) {
    h.update(`\0${rel}\0`);
    const full = path.join(top, rel);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) h.update(`link:${fs.readlinkSync(full)}`);
      else if (!st.isFile()) h.update(`special:${st.mode}`); // FIFOs, sockets, devices: never read them
      else if (st.size > MAX_UNTRACKED_BYTES) h.update(`big:${st.size}`);
      else h.update(fs.readFileSync(full));
    } catch {
      h.update('gone');
    }
  }
  const envPart = cacheEnv.map((k) => `${k}=${env[k] === undefined ? '' : env[k]}`).join('\0');
  h.update(
    `\0${path.relative(top, cwd)}\0${argv.join('\0')}\0${process.version}\0${process.platform}\0${envPart}\0${env.SZQ_CACHE_SALT || ''}`,
  );
  return h.digest('hex');
}

class Cache {
  constructor(paths, cfg) {
    this.dir = paths.cacheDir;
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
  write(key, { code, cmd, chunks }) {
    const ttl =
      code === 0 ? this.cfg.successTtlHours * 3600 * 1000 : code >= 1 && code <= 123 ? this.cfg.failureTtlMinutes * 60 * 1000 : 0;
    if (!ttl) return false;
    try {
      writeJsonAtomic(this.file(key), { v: 1, at: Date.now(), ttl, code, cmd, chunks });
      return true;
    } catch {
      return false;
    }
  }

  prune() {
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
    try {
      for (const name of fs.readdirSync(this.dir)) {
        fs.unlinkSync(path.join(this.dir, name));
        n++;
      }
    } catch {
      /* nothing to clear */
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
}

module.exports = { Cache, stateKey, gitTop, gitText };

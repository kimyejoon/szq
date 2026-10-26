'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LOG_BYTES = 64 * 1024 * 1024;
const HEAD = '# szq-log ';
const TAIL = '# szq-end ';

function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Full, unmodified output of every run, kept for `output.digest` pointers and `szq logs`.
 * Files are 0600 in the private state directory; only the newest `logs.keep` are retained.
 */
class Logs {
  constructor(paths, cfg) {
    this.dir = paths.logDir;
    this.keep = cfg.keep;
  }

  /** Start a log. Returns a writer { file, write(buf), close({code, ms}) }. */
  open(meta) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${stamp()}-${crypto.randomBytes(2).toString('hex')}.log`);
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeSync(fd, `${HEAD}${JSON.stringify({ at: Date.now(), ...meta })}\n`);
    let bytes = 0;
    let capped = false;
    return {
      file,
      write(buf) {
        if (capped) return;
        if (bytes + buf.length > MAX_LOG_BYTES) {
          fs.writeSync(fd, `\n[szq] log truncated at ${MAX_LOG_BYTES} bytes\n`);
          capped = true;
          return;
        }
        fs.writeSync(fd, buf);
        bytes += buf.length;
      },
      close(result) {
        try {
          fs.writeSync(fd, `\n${TAIL}${JSON.stringify(result)}\n`);
        } finally {
          fs.closeSync(fd);
        }
      },
    };
  }

  /** Recreate a log from cached chunks (used when a cache hit must point at a full log). */
  fromChunks(meta, chunks, result) {
    const w = this.open({ ...meta, replayed: true });
    for (const [, b64] of chunks) w.write(Buffer.from(b64, 'base64'));
    w.close(result);
    return w.file;
  }

  prune() {
    try {
      const names = fs
        .readdirSync(this.dir)
        .filter((n) => n.endsWith('.log'))
        .sort()
        .reverse();
      for (const n of names.slice(this.keep)) fs.unlinkSync(path.join(this.dir, n));
    } catch {
      /* best effort */
    }
  }

  /** Output text of a log without header/trailer. */
  readBody(file) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    if (lines[0] && lines[0].startsWith(HEAD)) lines.shift();
    const end = lines.length - 1 - [...lines].reverse().findIndex((l) => l.startsWith(TAIL));
    const hasTail = lines.some((l) => l.startsWith(TAIL));
    const body = hasTail ? lines.slice(0, end) : lines;
    return body.join('\n').replace(/\n+$/, '\n');
  }

  list(limit = 20) {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.log')).sort().reverse().slice(0, limit);
    } catch {
      return [];
    }
    return names.map((n) => {
      const file = path.join(this.dir, n);
      const info = { file, name: n, meta: {}, result: null };
      try {
        const text = fs.readFileSync(file, 'utf8');
        const first = text.split('\n', 1)[0];
        if (first.startsWith(HEAD)) info.meta = JSON.parse(first.slice(HEAD.length));
        const i = text.lastIndexOf(TAIL);
        if (i >= 0) info.result = JSON.parse(text.slice(i + TAIL.length).trim());
        info.bytes = Buffer.byteLength(text);
      } catch {
        /* unreadable log */
      }
      return info;
    });
  }
}

module.exports = { Logs };

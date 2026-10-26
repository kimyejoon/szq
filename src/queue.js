'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pidAlive, killTree, sleepSync } = require('./platform');

const STALE_MS = 60000;
const CLAIM_STALE_MS = 10000;

/**
 * File based FIFO queue shared by every szq process of the same user.
 *
 * A ticket is a small JSON file in the queue directory. Its name sorts by creation time.
 * The owner keeps its mtime fresh (heartbeat); tickets whose owner died or went silent are reaped.
 * A short-lived mkdir mutex serialises the "may I start?" decision.
 */
class Queue {
  constructor(paths) {
    this.dir = paths.queueDir;
    this.claimDir = paths.claimDir;
  }

  readTickets() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const n of names.sort()) {
      const file = path.join(this.dir, n);
      try {
        const st = fs.statSync(file);
        out.push({ ...JSON.parse(fs.readFileSync(file, 'utf8')), file, mtimeMs: st.mtimeMs });
      } catch {
        /* being written, or already gone */
      }
    }
    return out;
  }

  /** Remove tickets of dead owners and kill the children they orphaned. Returns the live ones. */
  reap(tickets) {
    const live = [];
    for (const t of tickets) {
      const dead = !pidAlive(t.pid) || Date.now() - t.mtimeMs > STALE_MS;
      if (!dead) {
        live.push(t);
        continue;
      }
      if (t.childPid && !pidAlive(t.pid) && pidAlive(t.childPid)) {
        killTree(t.childPid, 'SIGTERM');
        setTimeout(() => killTree(t.childPid, 'SIGKILL'), 3000).unref();
      }
      try {
        fs.unlinkSync(t.file);
      } catch {
        /* already removed */
      }
    }
    return live;
  }

  withClaim(fn) {
    const start = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(this.claimDir, { mode: 0o700 });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(this.claimDir).mtimeMs > CLAIM_STALE_MS) fs.rmdirSync(this.claimDir);
        } catch {
          /* raced with the holder */
        }
        if (Date.now() - start > 15000) return null;
        sleepSync(40);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmdirSync(this.claimDir);
      } catch {
        /* already removed */
      }
    }
  }

  create(cwd, argv, key) {
    const id = `${String(Date.now()).padStart(13, '0')}-${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
    const file = path.join(this.dir, `${id}.json`);
    const t = { id, pid: process.pid, cwd, cmd: argv.join(' ').slice(0, 300), key: key || null, state: 'waiting', createdAt: Date.now() };
    writeJsonAtomic(file, t);
    return { t, file };
  }

  update(me, patch) {
    me.t = { ...me.t, ...patch };
    try {
      writeJsonAtomic(me.file, me.t);
    } catch {
      /* queue directory vanished */
    }
  }

  drop(me) {
    try {
      fs.unlinkSync(me.file);
    } catch {
      /* already removed */
    }
  }

  heartbeat(me) {
    try {
      const now = new Date();
      fs.utimesSync(me.file, now, now);
    } catch {
      /* reaped */
    }
  }

  /**
   * Of all live tickets with the same request key, the oldest is the leader.
   * Everyone else follows: no slot is consumed, the leader's result is shared.
   */
  static leaderOf(t, live) {
    return t.key ? live.find((o) => o.key === t.key && o.id < t.id) || null : null;
  }

  /** Decide whether `me` may start now. */
  tryClaim(me, cap) {
    const res = this.withClaim(() => {
      const tickets = this.reap(this.readTickets());
      const live = tickets.filter((t) => t.state === 'running' || t.state === 'waiting');
      const running = tickets.filter((t) => t.state === 'running');
      const waiting = tickets.filter((t) => t.state === 'waiting' && !Queue.leaderOf(t, live));
      const mine = tickets.find((t) => t.id === me.t.id);
      if (!mine) {
        writeJsonAtomic(me.file, { ...me.t, state: 'waiting' }); // reaped by mistake - register again
        return { ok: false, position: waiting.length + 1, running: running.length };
      }
      const leader = Queue.leaderOf(mine, live);
      if (leader) return { ok: false, following: true, leader, position: 0, running: running.length };
      const idx = waiting.findIndex((t) => t.id === me.t.id);
      if (running.length < cap && idx < cap - running.length) {
        me.t = { ...me.t, state: 'running', startedAt: Date.now() };
        writeJsonAtomic(me.file, me.t);
        return { ok: true };
      }
      return { ok: false, position: idx + 1, running: running.length, ahead: running.concat(waiting.slice(0, idx)) };
    });
    return res || { ok: false, position: 0, running: 0 };
  }

  snapshot() {
    const tickets = this.reap(this.readTickets());
    const live = tickets.filter((t) => t.state === 'running' || t.state === 'waiting');
    return {
      running: tickets.filter((t) => t.state === 'running'),
      followers: tickets.filter((t) => t.state === 'waiting' && Queue.leaderOf(t, live)),
      waiting: tickets.filter((t) => t.state === 'waiting' && !Queue.leaderOf(t, live)),
    };
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { Queue, writeJsonAtomic, STALE_MS };

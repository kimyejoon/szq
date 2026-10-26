'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validPid, pidAlive, killTree, sleepSync, procStart, sameProcess } = require('./platform');

// With a verified owner start time a quiet ticket can be trusted for a long time (a laptop may sleep);
// without one (Windows) the heartbeat is the only liveness signal besides the pid.
const STALE_VERIFIED_MS = 30 * 60 * 1000;
const STALE_UNVERIFIED_MS = 5 * 60 * 1000;
const CLAIM_STALE_MS = 10000;
// A heartbeat younger than this (owners touch their ticket every 5 s) proves liveness together with a live pid, so
// the expensive start-time check (a `ps` process) is only needed for tickets that went quiet.
const FRESH_MS = 15000;

const PRIORITY = { high: 2, normal: 1, low: 0 };

/**
 * File based queue shared by every szq process of the same user.
 *
 * A ticket is a small JSON file in the queue directory. Its name sorts by creation time.
 * The owner keeps its mtime fresh (heartbeat); tickets whose owner is gone are reaped.
 * A short-lived mkdir mutex serialises the "may I start?" decision.
 */
class Queue {
  constructor(paths) {
    this.dir = paths.queueDir;
    this.claimDir = paths.claimDir;
    this.host = os.hostname();
  }

  static validTicket(t) {
    return (
      t &&
      typeof t.id === 'string' &&
      validPid(t.pid) &&
      typeof t.cwd === 'string' &&
      typeof t.cmd === 'string' &&
      (t.state === 'waiting' || t.state === 'running')
    );
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
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Queue.validTicket(t)) out.push({ ...t, file, mtimeMs: st.mtimeMs });
        else if (Date.now() - st.mtimeMs > 60000) fs.unlinkSync(file); // garbage, not a ticket in flight
      } catch {
        /* being written, or already gone */
      }
    }
    return out;
  }

  isDead(t) {
    const age = Date.now() - t.mtimeMs;
    if (t.host && t.host !== this.host) return age > STALE_UNVERIFIED_MS; // other machine (shared home)
    if (!pidAlive(t.pid)) return true;
    if (age < FRESH_MS) return false; // live pid + fresh heartbeat: no need to ask `ps`
    if (t.ownerStart) {
      if (!sameProcess(t.pid, t.ownerStart)) return true; // pid reused by someone else
      return age > STALE_VERIFIED_MS;
    }
    return age > STALE_UNVERIFIED_MS;
  }

  /** Remove tickets of dead owners and stop the children they orphaned. Returns the live tickets. */
  reap(tickets) {
    const live = [];
    for (const t of tickets) {
      if (!this.isDead(t)) {
        live.push(t);
        continue;
      }
      // Only ever signal a child we can positively identify: same host, recorded start time still matches.
      if (t.host === this.host && validPid(t.childPid) && t.childStart && sameProcess(t.childPid, t.childStart)) {
        killTree(t.childPid, 'SIGTERM');
        setTimeout(() => {
          if (sameProcess(t.childPid, t.childStart)) killTree(t.childPid, 'SIGKILL');
        }, 3000).unref();
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
    const token = crypto.randomBytes(8).toString('hex');
    const ownerFile = path.join(this.claimDir, 'owner');
    for (;;) {
      try {
        fs.mkdirSync(this.claimDir, { mode: 0o700 });
        try {
          fs.writeFileSync(ownerFile, token);
        } catch {
          /* a breaker renamed the directory right away; fn will still run, release below checks the token */
        }
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(this.claimDir).mtimeMs > CLAIM_STALE_MS) {
            // rename is atomic: exactly one waiter breaks a stale mutex, the others lose the race harmlessly
            const grave = `${this.claimDir}.stale-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
            fs.renameSync(this.claimDir, grave);
            fs.rmSync(grave, { recursive: true, force: true });
          }
        } catch {
          /* raced with the holder or another breaker */
        }
        if (Date.now() - start > 15000) return null;
        sleepSync(40);
      }
    }
    try {
      return fn();
    } finally {
      // release only a mutex that is still ours: if it was judged stale and re-taken by someone else, leave it
      try {
        if (fs.readFileSync(ownerFile, 'utf8') === token) {
          fs.unlinkSync(ownerFile);
          fs.rmdirSync(this.claimDir);
        }
      } catch {
        /* already removed or taken over */
      }
    }
  }

  create(cwd, argv, key, { priority = 'normal', exclusive = false } = {}) {
    const ownerStart = procStart(process.pid); // slow (spawns `ps`): do it BEFORE the id is drawn
    const id = `${String(Date.now()).padStart(13, '0')}-${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
    const file = path.join(this.dir, `${id}.json`);
    const t = {
      id,
      pid: process.pid,
      host: this.host,
      ownerStart,
      cwd,
      cmd: argv.join(' ').slice(0, 300),
      key: key || null,
      prio: PRIORITY[priority] ?? PRIORITY.normal,
      exclusive: Boolean(exclusive),
      state: 'waiting',
      createdAt: Date.now(),
    };
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
   * Who does `t` follow, if anyone? Among live tickets with the same request key:
   *  1. one that is already RUNNING wins, whatever the arrival order. A ticket file can become visible later than
   *     its id suggests (the id is drawn first, the file written a few milliseconds - under load tens of
   *     milliseconds - after), so a "younger" ticket may legitimately start first; the "older" one must then
   *     follow it instead of starting a duplicate;
   *  2. otherwise the oldest waiting one leads and the rest follow.
   * A follower takes no slot and replays the leader's result.
   */
  static leaderOf(t, live) {
    if (!t.key || t.state === 'running') return null; // a run that has started follows nobody
    const same = live.filter((o) => o.key === t.key && o.id !== t.id);
    return same.find((o) => o.state === 'running') || same.find((o) => o.id < t.id) || null;
  }

  /**
   * Decide whether `me` may start now. `capOrFn` is the effective concurrency for this decision - a number, or a
   * function of the running tickets (evaluated inside the lock, so it sees a consistent view).
   */
  tryClaim(me, capOrFn) {
    const res = this.withClaim(() => {
      const tickets = this.reap(this.readTickets());
      const live = tickets.filter((t) => t.state === 'running' || t.state === 'waiting');
      const running = tickets.filter((t) => t.state === 'running');
      const cap = typeof capOrFn === 'function' ? capOrFn(running) : capOrFn;
      const waiting = tickets.filter((t) => t.state === 'waiting' && !Queue.leaderOf(t, live));
      const mine = tickets.find((t) => t.id === me.t.id);
      if (!mine) {
        writeJsonAtomic(me.file, { ...me.t, state: 'waiting' }); // reaped by mistake - register again
        return { ok: false, position: waiting.length + 1, running: running.length };
      }
      const leader = Queue.leaderOf(mine, live);
      if (leader) return { ok: false, following: true, leader, position: 0, running: running.length };
      const { admitted, order } = admit(waiting, running, cap);
      if (admitted.has(me.t.id)) {
        me.t = { ...me.t, state: 'running', startedAt: Date.now() };
        writeJsonAtomic(me.file, me.t);
        return { ok: true, cap };
      }
      const idx = order.findIndex((t) => t.id === me.t.id);
      return { ok: false, cap, position: idx + 1, running: running.length, ahead: running.concat(order.slice(0, idx)) };
    });
    return res || { ok: false, position: 0, running: 0 };
  }

  snapshot() {
    const tickets = this.reap(this.readTickets());
    const live = tickets.filter((t) => t.state === 'running' || t.state === 'waiting');
    return {
      running: tickets.filter((t) => t.state === 'running'),
      followers: tickets.filter((t) => t.state === 'waiting' && Queue.leaderOf(t, live)),
      waiting: sortWaiting(tickets.filter((t) => t.state === 'waiting' && !Queue.leaderOf(t, live))),
    };
  }
}

function sortWaiting(list) {
  return list.slice().sort((a, b) => (b.prio ?? 1) - (a.prio ?? 1) || (a.id < b.id ? -1 : 1));
}

/**
 * Pure admission rule. `waiting` are the non-following waiting tickets, `running` the running ones.
 * Higher priority first, then arrival order. An exclusive run needs an empty machine and blocks everyone
 * behind it until it has run; nobody starts while an exclusive run is active.
 * @returns {{admitted: Set<string>, order: object[]}}
 */
function admit(waiting, running, cap) {
  const order = sortWaiting(waiting);
  const admitted = new Set();
  const exclusiveActive = running.some((r) => r.exclusive);
  let slots = Math.max(0, cap - running.length);
  let active = running.length;
  if (exclusiveActive) return { admitted, order };
  for (const w of order) {
    if (w.exclusive) {
      if (active === 0) {
        admitted.add(w.id);
        active++;
      }
      break; // everything behind an exclusive run waits for it
    }
    if (slots <= 0) break;
    admitted.add(w.id);
    slots--;
    active++;
  }
  return { admitted, order };
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { Queue, admit, writeJsonAtomic, PRIORITY };

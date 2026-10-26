'use strict';
const fs = require('fs');

const MAX_BYTES = 1024 * 1024;

/** Append one event (JSON line). The file is rotated at 1 MiB; failures never matter to the caller. */
function record(file, event) {
  try {
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...event })}\n`, { mode: 0o600 });
  } catch {
    /* statistics are optional */
  }
}

function readEvents(file) {
  const out = [];
  for (const f of [`${file}.1`, file]) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.t === 'number' && typeof e.k === 'string') out.push(e);
      } catch {
        /* skip a torn line */
      }
    }
  }
  return out;
}

/**
 * kinds: 'run' (executed, ms = duration), 'hit' (served from cache, saved = original duration),
 *        'share' (waited for an identical run, saved = original duration, waited = wait time)
 */
function summarize(file, days = 7, now = Date.now()) {
  const since = now - days * 86400000;
  const s = { days, runs: 0, executed: 0, hits: 0, shared: 0, workMs: 0, savedMs: 0, waitedMs: 0, byCmd: {} };
  for (const e of readEvents(file)) {
    if (e.t < since) continue;
    const c = (s.byCmd[e.cmd || '?'] ||= { executed: 0, hits: 0, shared: 0, savedMs: 0 });
    s.runs++;
    if (e.k === 'run') {
      s.executed++;
      s.workMs += e.ms || 0;
      c.executed++;
    } else if (e.k === 'hit') {
      s.hits++;
      s.savedMs += e.saved || 0;
      c.hits++;
      c.savedMs += e.saved || 0;
    } else if (e.k === 'share') {
      s.shared++;
      s.savedMs += e.saved || 0;
      s.waitedMs += e.waited || 0;
      c.shared++;
      c.savedMs += e.saved || 0;
    }
  }
  return s;
}

module.exports = { record, readEvents, summarize };

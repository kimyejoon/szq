'use strict';
const os = require('os');

function snapshot() {
  return os.cpus().map((c) => ({ ...c.times }));
}

/** Fraction of CPU time spent busy (0..1) between two snapshots. */
function busyFraction(a, b) {
  let busy = 0;
  let total = 0;
  a.forEach((x, i) => {
    const y = b[i];
    if (!y) return;
    const idle = y.idle - x.idle;
    const all = Object.keys(y).reduce((s, k) => s + (y[k] - x[k]), 0);
    busy += all - idle;
    total += all;
  });
  return total > 0 ? busy / total : null;
}

/**
 * Recent whole-machine CPU utilisation. `sample()` returns the fraction since the previous *accepted* sample, or
 * the last value / null while fewer than `minMs` have passed (utilisation over a few milliseconds is noise).
 */
class CpuMeter {
  constructor(now = Date.now) {
    this.now = now;
    this.prev = snapshot();
    this.at = now();
    this.last = null;
  }

  sample(minMs = 250) {
    const t = this.now();
    if (t - this.at < minMs) return this.last;
    const cur = snapshot();
    this.last = busyFraction(this.prev, cur);
    this.prev = cur;
    this.at = t;
    return this.last;
  }
}

module.exports = { CpuMeter, busyFraction, snapshot };

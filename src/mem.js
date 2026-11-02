'use strict';
const fs = require('fs');

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Memory pressure of the whole machine (Linux only; elsewhere both values are null).
 *  - `psi`: share of the last 10 s in which at least one task stalled on memory (/proc/pressure/memory "some avg10", %).
 *    Swapping, reclaim and refaults all show up here, so it rises before the machine becomes unusable.
 *  - `availPct`: MemAvailable as a percentage of MemTotal - how much a new run can take without pushing others out.
 * `root` is injectable so tests can point it at fake files.
 */
function readMemSignal(root = '/proc') {
  const out = { psi: null, availPct: null };
  const pressure = readFile(`${root}/pressure/memory`);
  const m = pressure && /^some\b.*?\bavg10=([\d.]+)/m.exec(pressure);
  if (m) out.psi = Number(m[1]);
  const info = readFile(`${root}/meminfo`);
  if (info) {
    const kb = (name) => {
      const r = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info);
      return r ? Number(r[1]) : null;
    };
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    if (total > 0 && avail !== null) out.availPct = (avail / total) * 100;
  }
  return out;
}

/** Which memory limit (if any) the signal crosses. A threshold of 0 disables that check. */
function memPressured(mem, adaptive) {
  if (!mem) return false;
  if (adaptive.memPressurePct > 0 && mem.psi !== null && mem.psi > adaptive.memPressurePct) return true;
  if (adaptive.memAvailPct > 0 && mem.availPct !== null && mem.availPct < adaptive.memAvailPct) return true;
  return false;
}

function fmtMem(mem) {
  const parts = [];
  if (mem.availPct !== null) parts.push(`${Math.round(mem.availPct)}% avail`);
  if (mem.psi !== null) parts.push(`psi ${mem.psi.toFixed(1)}%`);
  return parts.join(', ');
}

module.exports = { readMemSignal, memPressured, fmtMem };

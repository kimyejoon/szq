'use strict';

const short = (h) => String(h).slice(0, 8);

/**
 * Explain why two fingerprints differ. `prev` is the record of the last run of the same command in the same
 * directory, `cur` the components of the request being made now. Returns human-readable reasons.
 */
function diffComponents(prev, cur) {
  const reasons = [];
  if (prev.node !== cur.node) reasons.push(`Node version changed: ${prev.node} -> ${cur.node}`);
  if (prev.platform !== cur.platform) reasons.push(`platform changed: ${prev.platform} -> ${cur.platform}`);
  if (prev.salt !== cur.salt) reasons.push('SZQ_CACHE_SALT changed');
  if (JSON.stringify(prev.env) !== JSON.stringify(cur.env)) {
    const names = cur.env.map(([k]) => k).filter((k, i) => JSON.stringify((prev.env[i] || [])[1]) !== JSON.stringify(cur.env[i][1]));
    reasons.push(`environment variable(s) in cache.env changed: ${names.join(', ') || '(list changed)'}`);
  }
  const pe = Object.keys(prev.extras || {});
  const ce = Object.keys(cur.extras || {});
  for (const k of new Set([...pe, ...ce])) {
    if ((prev.extras || {})[k] !== (cur.extras || {})[k]) reasons.push(`cache.extraFiles entry changed: ${k}`);
  }
  if (prev.treeHash !== cur.treeHash) {
    if (prev.files && cur.files) {
      const changed = [];
      const added = [];
      const removed = [];
      for (const [p, h] of Object.entries(cur.files)) {
        if (!(p in prev.files)) added.push(p);
        else if (prev.files[p] !== h) changed.push(p);
      }
      for (const p of Object.keys(prev.files)) if (!(p in cur.files)) removed.push(p);
      const fmt = (label, list) => {
        if (!list.length) return;
        const shown = list.slice(0, 8).join(', ');
        reasons.push(`${label} ${list.length} file(s): ${shown}${list.length > 8 ? `, ... (+${list.length - 8} more)` : ''}`);
      };
      fmt('modified', changed);
      fmt('added', added);
      fmt('removed', removed);
    } else {
      reasons.push(`working tree content changed (${short(prev.treeHash)} -> ${short(cur.treeHash)}; file list too large to compare)`);
    }
  }
  return reasons;
}

module.exports = { diffComponents };

'use strict';

/*
 * Decide whether a shell command line starts one of the guarded heavy commands directly.
 *
 * This is a *seatbelt for well-behaved agents*, not a security boundary: a determined caller can
 * always obfuscate a command (`eval`, base64, a script file that runs tsc ...). See SECURITY.md.
 * It is deliberately conservative about false positives - it parses shell structure roughly
 * instead of grepping, so `git commit -m "fix tsc"` or `pnpm add -D vitest` are not blocked.
 */

const RUNNERS = new Set(['pnpm', 'pnpx', 'npm', 'yarn', 'bun', 'npx', 'bunx', 'turbo']);
const WRAPPERS = new Set(['env', 'time', 'command', 'nohup', 'sudo', 'exec', 'nice', 'caffeinate', 'builtin', 'xargs']);
const VALUE_OPTS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace', '-w', '--cwd']);
const NODE_BIN_RE =
  /(typescript[\\/](bin|lib)[\\/]tsc(\.js)?|vitest[\\/]vitest\.mjs|[\\/]\.bin[\\/](tsc|vitest|jest)|jest[\\/]bin[\\/]jest(\.js)?)$/;

function baseName(p) {
  return String(p || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(cmd|exe|ps1|bat)$/i, '');
}

/** Replace quoted text and heredoc bodies so only command structure remains. */
function strip(cmd) {
  const s = cmd.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '\n');
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < s.length) i++;
      else if (c === q) {
        q = '';
        out += 'Q';
      }
    } else if (c === "'" || c === '"') q = c;
    else if (c === '\\' && /[;&|()<>"'\\ ]/.test(s[i + 1] || '')) {
      out += ' ';
      i++;
    } else out += c;
  }
  return out;
}

function segments(cmd) {
  return strip(cmd)
    .split(/;|&&|\|\||\||&|\n|`|\$\(|\(|\)|\{|\}/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function words(seg) {
  const w = seg.split(/\s+/).filter(Boolean);
  let wrapped = false;
  while (w.length && (WRAPPERS.has(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]) || w[0] === '!' || (wrapped && w[0].startsWith('-')))) {
    if (WRAPPERS.has(w[0])) wrapped = true;
    w.shift();
  }
  return w;
}

/**
 * @param {{commands: string[], scripts: string[]}} rules
 * @returns {(command: string) => string|null}  the offending command name, or null
 */
function createClassifier(rules) {
  const direct = new Set(rules.commands.map((c) => c.toLowerCase()));
  const scripts = new Set(rules.scripts.map((s) => s.toLowerCase()));
  const isScript = (x) => {
    const v = x.toLowerCase();
    if (scripts.has(v)) return true;
    const colon = v.indexOf(':'); // test:watch, typecheck:ci ...
    return colon > 0 && scripts.has(v.slice(0, colon));
  };

  return function classify(command) {
    if (typeof command !== 'string' || !command) return null;
    for (const seg of segments(command)) {
      const w = words(seg);
      if (!w.length) continue;
      const a0 = baseName(w[0]).toLowerCase();
      if (a0 === 'szq') continue; // already goes through the queue
      if (direct.has(a0)) return a0;
      if (a0 === 'node' || a0 === 'bun') {
        const target = w.slice(1).find((x) => !x.startsWith('-'));
        if (target && NODE_BIN_RE.test(target)) return target;
        continue;
      }
      if (!RUNNERS.has(a0)) continue;
      const rest = [];
      for (let i = 1; i < w.length; i++) {
        if (VALUE_OPTS.has(w[i])) i++;
        else if (!w[i].startsWith('-')) rest.push(w[i]);
      }
      let sub = rest[0];
      let target = rest[1];
      if (a0 === 'npx' || a0 === 'bunx') [sub, target] = [undefined, rest[0]];
      else if (['exec', 'dlx', 'x'].includes(sub)) sub = undefined;
      else if (sub === 'run' || sub === 'run-script') [sub, target] = [target, undefined];
      else target = undefined;
      if (target && direct.has(baseName(target).toLowerCase())) return baseName(target);
      if (sub && direct.has(sub.toLowerCase()) && a0 !== 'turbo') return sub;
      if (sub && isScript(sub)) return `${a0} ${sub}`;
      if (a0 === 'turbo' && rest.some(isScript)) return `turbo ${rest.find(isScript)}`;
    }
    return null;
  };
}

module.exports = { createClassifier, strip, segments, words, baseName };

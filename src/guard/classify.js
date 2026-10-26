'use strict';

/*
 * Decide whether a shell command line starts one of the guarded heavy commands directly.
 *
 * This is a *seatbelt for well-behaved agents*, not a security boundary: a determined caller can
 * always obfuscate a command (`eval`, base64, a script file that runs tsc). See SECURITY.md.
 * It is deliberately conservative about false positives - it parses shell structure roughly
 * instead of grepping, so `git commit -m "fix tsc"` or `pnpm add -D vitest` are not blocked.
 *
 * It runs before every shell command of an agent, so it is a single linear pass (no backtracking
 * regular expressions over user input) and inspects at most MAX_INPUT characters.
 */

const MAX_INPUT = 64 * 1024;
const RUNNERS = new Set(['pnpm', 'pnpx', 'npm', 'yarn', 'bun', 'npx', 'bunx', 'turbo']);
const WRAPPERS = new Set(['env', 'time', 'command', 'nohup', 'sudo', 'exec', 'nice', 'caffeinate', 'builtin', 'xargs']);
const VALUE_OPTS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace', '--cwd']);
const LIGHT_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h']);
const NODE_BIN_RE =
  /(typescript[\\/](bin|lib)[\\/]tsc(\.js)?|vitest[\\/]vitest\.mjs|[\\/]\.bin[\\/](tsc|vitest|jest)|jest[\\/]bin[\\/]jest(\.js)?)$/;
const HEREDOC_RE = /^<<(-?)\s*(?:'([^'\n]{1,64})'|"([^"\n]{1,64})"|([^\s'"<>;|&()]{1,64}))/;

function baseName(p) {
  return String(p || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(cmd|exe|ps1|bat)$/i, '');
}

/**
 * One pass: replaces quoted text by `Q`, drops heredoc bodies, comments and line continuations.
 * What remains is the command structure only.
 */
function strip(cmd) {
  const s = cmd.length > MAX_INPUT ? cmd.slice(0, MAX_INPUT) : cmd;
  const n = s.length;
  let out = '';
  let q = '';
  const pending = []; // heredocs whose bodies start after the current line
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < n) i += 2;
      else {
        if (c === q) {
          q = '';
          out += 'Q';
        }
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      i++;
    } else if (c === '\\' && s[i + 1] === '\n') {
      out += ' ';
      i += 2;
    } else if (c === '\\' && i + 1 < n && ';&|()<>"\'\\ '.includes(s[i + 1])) {
      out += ' ';
      i += 2;
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      while (i < n && s[i] !== '\n') i++; // comment to end of line
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = HEREDOC_RE.exec(s.slice(i, i + 160));
      if (m) {
        pending.push({ dash: m[1] === '-', delim: m[2] || m[3] || m[4] });
        i += m[0].length;
      } else {
        out += c;
        i++;
      }
    } else if (c === '\n') {
      out += '\n';
      i++;
      for (const h of pending) {
        // skip body lines up to and including the terminator line
        while (i < n) {
          let eol = s.indexOf('\n', i);
          if (eol === -1) eol = n;
          const line = s.slice(i, eol);
          i = Math.min(n, eol + 1);
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      pending.length = 0;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function segments(cmd) {
  return strip(cmd)
    .split(/[;&|\n`(){}]|\$\(/)
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
  const light = (args) => args.some((a) => LIGHT_FLAGS.has(a)); // `tsc --version` is not heavy

  return function classify(command) {
    if (typeof command !== 'string' || !command) return null;
    for (const seg of segments(command)) {
      const w = words(seg);
      if (!w.length) continue;
      const a0 = baseName(w[0]).toLowerCase();
      if (a0 === 'szq') continue; // already goes through the queue
      if (direct.has(a0)) {
        if (light(w.slice(1))) continue;
        return a0;
      }
      if (a0 === 'node' || a0 === 'bun') {
        const target = w.slice(1).find((x) => !x.startsWith('-'));
        if (target && NODE_BIN_RE.test(target) && !light(w.slice(1))) return target;
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
      if (target && direct.has(baseName(target).toLowerCase()) && !light(w.slice(1))) return baseName(target);
      if (sub && direct.has(sub.toLowerCase()) && a0 !== 'turbo' && !light(w.slice(1))) return sub;
      if (sub && isScript(sub)) return `${a0} ${sub}`;
      if (a0 === 'turbo' && rest.some(isScript)) return `turbo ${rest.find(isScript)}`;
    }
    return null;
  };
}

module.exports = { createClassifier, strip, segments, words, baseName, MAX_INPUT };

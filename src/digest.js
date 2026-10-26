'use strict';

/*
 * Shrink a long command output to what an AI agent needs: the head, the tail and every line that
 * looks like an error (with a few continuation lines), plus a pointer to the full log.
 *
 * Agents pay for every output line in context; a failing `tsc` can print thousands of lines. The digest
 * never hides that something was cut: it says how many lines were omitted and where the full output is.
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const ERROR_PATTERNS = [
  /error TS\d+/, // tsc
  /^\s*(FAIL|FAILED|ERROR)\b/, // jest / vitest / many tools
  /^\s*[×✗✘✖]\s/, // vitest / jest failed test markers
  /\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error:|Unhandled|Traceback|panic:|Exception)\b/,
  /\b\d+ (failed|failing)\b/i,
  /\bFound \d+ errors?\b/,
  /\berror\b.*\b(cannot|can't|not found|undefined|unexpected)\b/i,
];

const SUMMARY_PATTERNS = [
  /^\s*(Tests?|Test Files|Test Suites|Snapshots?|Time|Duration)\s*:/i,
  /\bFound \d+ errors?\b/,
  /^\s*\d+ (passing|failing|pending)/,
  /\b(passed|failed)\b.*\b\d+\b/i,
];

const plain = (s) => s.replace(ANSI, '');

/**
 * @param {string} text full output
 * @param {{maxLines?: number, head?: number, tail?: number, maxErrorLines?: number, context?: number, logPath?: string}} [opts]
 * @returns {{text: string, truncated: boolean, total: number, shown: number}}
 */
function digest(text, opts = {}) {
  const maxLines = opts.maxLines ?? 200;
  const head = opts.head ?? 15;
  const tail = opts.tail ?? 40;
  const maxErrorLines = opts.maxErrorLines ?? 60;
  const context = opts.context ?? 3;

  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const total = lines.length;
  if (maxLines <= 0 || total <= maxLines) return { text, truncated: false, total, shown: total };

  const keep = new Array(total).fill(false);
  for (let i = 0; i < Math.min(head, total); i++) keep[i] = true;
  for (let i = Math.max(0, total - tail); i < total; i++) keep[i] = true;

  let errors = 0;
  for (let i = head; i < total - tail && errors < maxErrorLines; i++) {
    const l = plain(lines[i]);
    if (ERROR_PATTERNS.some((re) => re.test(l)) || SUMMARY_PATTERNS.some((re) => re.test(l))) {
      errors++;
      keep[i] = true;
      // indented continuation lines belong to the error above them (tsc, stack traces)
      for (let j = i + 1; j <= i + context && j < total - tail; j++) {
        if (/^\s+\S/.test(plain(lines[j]))) keep[j] = true;
        else break;
      }
    }
  }

  const out = [];
  let omitted = 0;
  const flush = () => {
    if (omitted) out.push(`[szq] ... ${omitted} line${omitted === 1 ? '' : 's'} omitted ...`);
    omitted = 0;
  };
  let shown = 0;
  for (let i = 0; i < total; i++) {
    if (keep[i]) {
      flush();
      out.push(lines[i]);
      shown++;
    } else omitted++;
  }
  flush();
  const where = opts.logPath ? ` Full output: ${opts.logPath}` : '';
  out.push(`[szq] digest: showing ${shown} of ${total} lines (head, tail and error lines).${where}`);
  return { text: `${out.join('\n')}\n`, truncated: true, total, shown };
}

module.exports = { digest, plain, ERROR_PATTERNS };

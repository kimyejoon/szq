'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../src/digest');

const tscOutput = (n) => {
  let t = '';
  for (let i = 0; i < n; i++) t += `src/m${i}.ts(${i},5): error TS2322: Type string is not assignable to type number.\n  The expected type comes from property x\n  declared here\n`;
  return `${t}Found ${n} errors in ${n} files.\n`;
};

test('short output is returned unchanged', () => {
  const d = digest('a\nb\nc\n', { maxLines: 200 });
  assert.equal(d.truncated, false);
  assert.equal(d.text, 'a\nb\nc\n');
});

test('long output keeps head, tail and error lines and says what was omitted', () => {
  const text = tscOutput(2000);
  const d = digest(text, { logPath: '/x/run.log' });
  assert.equal(d.truncated, true);
  assert.ok(d.text.length < text.length / 10, 'at least 10x smaller');
  assert.match(d.text, /error TS2322/);
  assert.match(d.text, /Found 2000 errors/);
  assert.match(d.text, /lines? omitted/);
  assert.match(d.text, /digest: showing \d+ of 6001 lines/);
  assert.match(d.text, /Full output: \/x\/run\.log/);
});

test('error lines hidden in the middle of a long passing run are found', () => {
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`  ✓ test ${i}`);
  lines.splice(500, 0, '  FAIL  src/a.test.ts', '    AssertionError: expected 1 to be 2', '      at foo.ts:1:1');
  lines.push('Tests: 1 failed, 1000 passed');
  const d = digest(`${lines.join('\n')}\n`);
  assert.match(d.text, /FAIL {2}src\/a\.test\.ts/);
  assert.match(d.text, /AssertionError/);
  assert.match(d.text, /Tests: 1 failed/);
  assert.ok(d.shown < 200);
});

test('ANSI colours do not hide errors from the matcher but are kept in the output', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
  lines[200] = '\u001b[31m  FAIL  colored.test.ts\u001b[39m';
  const d = digest(`${lines.join('\n')}\n`);
  assert.ok(d.text.includes('\u001b[31m  FAIL  colored.test.ts'));
});

test('maxLines 0 disables the digest', () => {
  const text = `${'x\n'.repeat(1000)}`;
  assert.equal(digest(text, { maxLines: 0 }).text, text);
});

test('the number of lines shown is bounded even if every line is an error', () => {
  const text = `${'error TS1: boom\n'.repeat(5000)}`;
  const d = digest(text);
  assert.ok(d.shown <= 15 + 40 + 60 + 60 * 3 + 5, `shown ${d.shown}`);
});

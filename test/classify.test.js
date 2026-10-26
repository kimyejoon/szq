'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClassifier } = require('../src/guard/classify');

const classify = createClassifier({ commands: ['tsc', 'vitest', 'jest'], scripts: ['test', 'typecheck'] });

const BLOCK = [
  'tsc --noEmit',
  'pnpm exec tsc --noEmit -p x',
  'cd a && pnpm --filter @scope/backend test',
  'pnpm test',
  'pnpm run typecheck',
  'npm test',
  'npm run test:unit',
  'yarn test',
  'npx vitest run',
  'bunx jest',
  'FOO=1 jest --no-watchman',
  'node ./node_modules/typescript/bin/tsc --noEmit',
  'node ./node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit',
  'turbo test',
  '(cd x; vitest run)',
  'git status; pnpm -C apps/web test:watch',
  'pnpm tsc -p .',
  'echo hi | xargs jest',
  'echo hi | xargs -n1 jest',
  'sudo -E vitest run',
  'env -i FOO=1 tsc',
  'time tsc',
  'C:\\proj\\node_modules\\.bin\\tsc.cmd --noEmit',
  'node C:\\proj\\node_modules\\vitest\\vitest.mjs run',
  'pnpm.cmd test',
];

const PASS = [
  'tsc --version',
  'vitest --help',
  "echo hi # later; tsc",
  'cat <<DOC-END\nnpm test\nDOC-END',
  "cat <<'EOF-1'\njest\nEOF-1\ngit status",
  'git status \\\n  jest',

  '',
  'szq tsc --noEmit',
  '~/.local/bin/szq pnpm test',
  'szq.cmd vitest run',
  'git commit -m "fix tsc and vitest"',
  "git commit -m 'run jest'",
  'grep -rn tsc src',
  'pnpm add -D vitest',
  'pnpm install',
  'pnpm lint',
  'pnpm --filter x build',
  'cat <<EOF\ntsc\nEOF',
  'python3 - <<"PY"\nprint("vitest run")\nPY',
  'echo "jest"',
  'ls scripts/tsc-helper',
  'npm install --save-dev jest',
  'node server.js',
  'cat package.json',
  'echo tsc',
];

for (const c of BLOCK) {
  test(`blocks: ${JSON.stringify(c)}`, () => assert.ok(classify(c), `expected a hit for ${c}`));
}
for (const c of PASS) {
  test(`passes: ${JSON.stringify(c)}`, () => assert.equal(classify(c), null));
}

test('custom command list extends the guard', () => {
  const c = createClassifier({ commands: ['pytest', 'tsc'], scripts: ['check'] });
  assert.ok(c('pytest -q'));
  assert.ok(c('pnpm run check'));
  assert.equal(c('pnpm test'), null);
});

test('non-string input is ignored', () => {
  assert.equal(classify(undefined), null);
  assert.equal(classify(42), null);
});

test('line continuations join lines: a continued command is one command', () => {
  assert.ok(classify('pnpm \\\n  test'));
});

test('commands after a heredoc are still inspected', () => {
  assert.ok(classify('cat <<EOF\nhello\nEOF\ntsc --noEmit'));
});

test('pathological input is classified in linear time', () => {
  for (const evil of ['cat <<' + 'A'.repeat(40000), 'cat <<EOF\n' + '\n'.repeat(40000), '"' + 'a'.repeat(100000), '$('.repeat(20000), ';'.repeat(100000)]) {
    const t0 = Date.now();
    classify(evil);
    assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0}ms for ${evil.slice(0, 20)}`);
  }
});

test('only the first 64 KiB are inspected', () => {
  assert.equal(classify(`echo ${'a'.repeat(70000)}; tsc`), null);
});

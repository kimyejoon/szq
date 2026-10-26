'use strict';
// Generates a TypeScript project that takes a few seconds to type-check (for the optional real-tsc scenario).
// usage: node gen-ts-project.js <dir> [files]
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const files = Number(process.argv[3]) || 400;
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, noEmit: true, skipLibCheck: true }, include: ['src'] }, null, 2),
);
for (let i = 0; i < files; i++) {
  const body = [`export type Box${i}<T> = { value: T; next?: Box${i}<T> };`];
  for (let j = 0; j < 25; j++) {
    body.push(
      `export function f${i}_${j}<A extends Record<string, number>, K extends keyof A>(a: A, k: K): { [P in K]: A[P] } & { id: ${j} } {`,
      `  return { [k]: a[k], id: ${j} } as { [P in K]: A[P] } & { id: ${j} };`,
      '}',
      `export const c${i}_${j} = f${i}_${j}({ a: 1, b: 2, c: 3 }, 'a');`,
    );
  }
  fs.writeFileSync(path.join(dir, 'src', `m${i}.ts`), `${body.join('\n')}\n`);
}
console.log(`generated ${files} files in ${dir}`);

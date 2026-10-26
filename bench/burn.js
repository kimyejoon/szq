'use strict';
// A deterministic CPU-bound job: fixed amount of work, so contention shows up as longer wall time.
// usage: node burn.js <iterations> <marker-file> <id>
const fs = require('fs');

const iterations = Number(process.argv[2]) || 1e8;
const marker = process.argv[3];
const id = process.argv[4] || '';
const start = Date.now();
const cpu0 = process.cpuUsage();
let x = 0;
for (let i = 0; i < iterations; i++) x += Math.sqrt(i) * Math.sin(i);
const cpu = process.cpuUsage(cpu0);
if (marker) {
  fs.appendFileSync(marker, `${JSON.stringify({ id, start, end: Date.now(), cpuMs: (cpu.user + cpu.system) / 1000, x: x > 0 })}\n`);
}
console.log(`burn ${id} done`);

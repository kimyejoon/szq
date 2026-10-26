# Benchmark results

- Date: 2026-10-26T06:06:14.001Z
- Machine: Apple M1 Pro x8, 16 GiB, darwin 25.0.0
- Node: v22.23.1
- 8 simultaneous "agents"; each job is ~2000 ms of single-core CPU work when run alone
- szq concurrency: 2 (cpus/4); background CPU use before the run: 100%; load average at start: 71.8 69.1 43.5

> Numbers describe this machine at this moment. Other processes (background load above) add noise; re-run `npm run bench` on your own hardware.

## A. same command, same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 9.29 s | 8 | 8 | 16.6 | 100 | 100 |
| with szq | 5.67 s | 1 | 1 | 2 | 94 | 100 |

## B. different commands, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 7.26 s | 8 | 8 | 16.9 | 100 | 100 |
| with szq | 12.82 s | 8 | 2 | 15.3 | 93 | 100 |

## D. real `tsc --noEmit` (generated project), same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 18.72 s | 0 | n/a | n/a | 100 | 100 |
| with szq | 5.57 s | 1 | n/a | n/a | 94 | 100 |

## C. one agent repeating the same command, code unchanged

Seconds per call: 2.56, 0.13, 0.15, 0.14, 0.11 - the command actually ran 1 time(s).

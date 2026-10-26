# Benchmark results

- Date: 2026-10-26T06:28:14.841Z
- Machine: Apple M1 Pro x8, 16 GiB, darwin 25.0.0
- Node: v22.23.1
- 8 simultaneous "agents"; each job is ~2000 ms of single-core CPU work when run alone
- szq concurrency: 2 (cpus/4); background CPU use before the run: 24%; load average at start: 9.5 15 23.4

> Numbers describe this machine at this moment. Other processes (background load above) add noise; re-run `npm run bench` on your own hardware.

## A. same command, same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 3 s | 8 | 8 | 18.4 | 100 | 100 |
| with szq | 3.46 s | 1 | 1 | 2 | 56 | 92 |

## B. different commands, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 2.95 s | 8 | 8 | 18.6 | 100 | 100 |
| with szq | 11.22 s | 8 | 2 | 16.4 | 63 | 99 |

## D. real `tsc --noEmit` (generated project), same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 12.96 s | 0 | n/a | n/a | 100 | 100 |
| with szq | 3.69 s | 1 | n/a | n/a | 62 | 97 |

## E. output volume (what an agent has to read)

A command that prints 2502 lines, one of them an error:

| | lines | bytes | ~tokens (bytes/4) | kept the error line |
|---|---|---|---|---|
| plain output | 2502 | 35870 | 8968 | true |
| `--digest` | 63 | 1119 | 280 | true |

97% less text.

## C. one agent repeating the same command, code unchanged

Seconds per call: 2.39, 0.12, 0.12, 0.13, 0.15 - the command actually ran 1 time(s).

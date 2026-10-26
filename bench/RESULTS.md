# Benchmark results

- Date: 2026-10-26T06:52:49.295Z
- Machine: Apple M1 Pro x8, 16 GiB, darwin 25.0.0
- Node: v22.23.1
- 8 simultaneous "agents"; each job is ~2000 ms of single-core CPU work when run alone
- szq concurrency: 2 (cpus/4); background CPU use before the run: 65%; load average at start: 11.5 16.9 25.6

> Numbers describe this machine at this moment. Other processes (background load above) add noise; re-run `npm run bench` on your own hardware.

## A. same command, same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 2.81 s | 8 | 8 | 18 | 100 | 100 |
| with szq | 2.2 s | 1 | 1 | 2 | 56 | 81 |

## B. different commands, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 2.61 s | 8 | 8 | 18.1 | 100 | 100 |
| with szq | 17.27 s | 8 | 1 | 16 | 52 | 71 |

## D. real `tsc --noEmit` (generated project), same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 8.81 s | 0 | n/a | n/a | 100 | 100 |
| with szq | 2.94 s | 1 | n/a | n/a | 66 | 89 |

## E. output volume (what an agent has to read)

A command that prints 2502 lines, one of them an error:

| | lines | bytes | ~tokens (bytes/4) | kept the error line |
|---|---|---|---|---|
| plain output | 2502 | 35870 | 8968 | true |
| `--digest` | 63 | 1119 | 280 | true |

97% less text.

## C. one agent repeating the same command, code unchanged

Seconds per call: 2.14, 0.07, 0.07, 0.07, 0.07 - the command actually ran 1 time(s).

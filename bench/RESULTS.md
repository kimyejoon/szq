# Benchmark results

- Date: 2026-10-26T06:47:28.115Z
- Machine: Apple M1 Pro x8, 16 GiB, darwin 25.0.0
- Node: v22.23.1
- 8 simultaneous "agents"; each job is ~2000 ms of single-core CPU work when run alone
- szq concurrency: 2 (cpus/4); background CPU use before the run: 32%; load average at start: 19.6 31 33.2

> Numbers describe this machine at this moment. Other processes (background load above) add noise; re-run `npm run bench` on your own hardware.

## A. same command, same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 2.96 s | 8 | 8 | 18.3 | 100 | 100 |
| with szq | 2.36 s | 1 | 1 | 2 | 55 | 87 |

## B. different commands, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 2.72 s | 8 | 8 | 17.8 | 100 | 100 |
| with szq | 16.81 s | 8 | 1 | 15.8 | 36 | 72 |

## D. real `tsc --noEmit` (generated project), same code, all agents at once

| | wall time | executions | max parallel | CPU seconds of work | avg CPU % | peak CPU % |
|---|---|---|---|---|---|---|
| without szq | 9.62 s | 0 | n/a | n/a | 100 | 100 |
| with szq | 2.96 s | 1 | n/a | n/a | 60 | 91 |

## E. output volume (what an agent has to read)

A command that prints 2502 lines, one of them an error:

| | lines | bytes | ~tokens (bytes/4) | kept the error line |
|---|---|---|---|---|
| plain output | 2502 | 35870 | 8968 | true |
| `--digest` | 63 | 1119 | 280 | true |

97% less text.

## C. one agent repeating the same command, code unchanged

Seconds per call: 2.08, 0.06, 0.06, 0.06, 0.07 - the command actually ran 1 time(s).

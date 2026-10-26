# Prior art and alternatives

szq was written after hitting a concrete problem - several AI coding agents on one laptop each running
`tsc`/`vitest`/`jest` at the same time - and it is **not the first tool to address that**. Before using
szq, look at these; one of them may fit you better. (Descriptions are based on each project's public
README/documentation as of October 2026; check the projects for current details.)

## tman ([standardbeagle/tman](https://github.com/standardbeagle/tman), MIT)

The closest relative. A native (.NET NativeAOT) supervisor for processes that LLM agents start: machine-wide
named queues that budget cores and memory, `--max-parallel` (default 2), a **name-based dedupe lock** per
directory that refuses a duplicate run, `--replace`, wall-time/stall/memory/CPU limits that kill hung runs,
run logs and failure digests, and agent integrations for Claude Code, Codex, Gemini CLI, opencode
(*rewriting* the command to go through tman) and Cursor, Antigravity, Kimi Code CLI, Copilot CLI
(*gating*). Linux, macOS and Windows binaries.

**Choose tman if** you want process supervision (kill hung runs, memory/CPU limits), a single prebuilt
binary, or broader agent coverage today.
**What szq does differently:** a duplicate run is not refused - it *waits and receives the same result*;
results are cached by the content of the git working tree, so a repeated call on unchanged code returns
instantly; the hooks *deny with an explanation* so the agent learns to prefix `szq` itself; it is a
dependency-free Node package you can read in an afternoon. szq has **no** memory/CPU limits, no stall
detection and no kill-on-hang beyond a plain timeout. As far as tman's README describes, it does not cache
results or look at git state - verify that yourself before relying on this comparison.

## tdd-cli ([geuben/tdd-cli](https://github.com/geuben/tdd-cli))

A TDD workflow tool for pytest/vitest that coordinates concurrent suite runs through **leases in a
machine-wide directory** and fills a `{workers}` placeholder in the test command so each run gets a share
of the cores instead of oversubscribing them. **Choose it if** you want parallel runs to share the cores
(each running faster, together) rather than queue behind each other, and your commands are tests.
szq serialises (up to a cap) and shares results; it does not divide cores between runs.

## task-spooler (`tsp`) and pueue

General-purpose job queues. `tsp` is a small Unix batch system (`-S` sets the number of slots);
[pueue](https://github.com/Nukesor/pueue) is a daemon with groups, per-group parallelism, dependencies and
scheduling. **Choose them if** you need a general background job queue. They are not aware of agents, git
state or hooks.

## Concurrency flags of the tools themselves

`vitest --maxWorkers`, `jest --maxWorkers`/`--runInBand`, `tsc --incremental`/`--build` limit or speed up a
*single run*. They do not coordinate separate processes started by different agents. szq can be combined
with them (`szq vitest run --maxWorkers=2`).

## Build-system task caches (Turborepo, Nx, Bazel, ...)

Monorepo build systems cache task outputs by hashing declared inputs. If your project already uses one,
prefer its caching for builds/tests. szq is not a build system: it has no task graph, it keys on the whole
git working tree, and it works for any command in any repository (at the price of coarser invalidation).

## `flock`/`lockf` wrappers

`flock -x lockfile tsc` already serialises runs on Linux with zero new software. It gives no result sharing,
no agent hooks, no queue visibility, and is not available by default on macOS or Windows.

## Where szq is a good fit

- Several agents (or humans) share one machine and keep re-running the same checks on the same code.
- You want agents to be *told* to use the queue, not silently rewritten.
- You want something tiny you can audit: about 2,000 lines of dependency-free JavaScript.

## Where it is not

- You need resource limits or kill-on-hang supervision (see tman).
- Your runs are independent and you would rather split cores than queue (see tdd-cli).
- Your project depends on files git ignores (generated code, build output) that change between runs and you
  cannot add them to `cache.env` - disable caching (`cache.enabled: false`) and keep only the queue.

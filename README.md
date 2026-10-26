# szq

### Stop running the same check eight times.

**One shared queue. One execution for identical work. Less CPU contention and less noise for AI coding agents.**

[![CI](https://github.com/kimyejoon/szq/actions/workflows/ci.yml/badge.svg)](https://github.com/kimyejoon/szq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933)

**English** · [한국어](README.ko.md) · [Quick start](#quick-start) · [Benchmarks](#benchmarks) · [Contributing](#contributing)

---

Running Claude Code, Codex, and Cursor side by side is great—until every agent runs the same `tsc`, `vitest`, or `jest` command at once. Your fans spin up, your development server struggles, and thousands of log lines consume the agents' context windows.

**szq** is a lightweight, zero-dependency Node.js CLI that coordinates expensive checks **across sessions on the same machine**. No daemon to configure, no changes to your test runner, and no need to give up working in parallel.

```text
WITHOUT szq                           WITH szq

Agent A ── tsc ─┐                    Agent A ── tsc ─┐
Agent B ── tsc ─┼── 3 executions      Agent B ── tsc ─┼── 1 execution
Agent C ── tsc ─┘                    Agent C ── tsc ─┘   └─ shared result

Every run dumps a full log.           Agents get concise digests;
                                       full logs stay available.
```

## Why szq?

| Problem | What szq does |
|---|---|
| Too many heavyweight checks at once | **Machine-wide adaptive queue** regulates concurrency and backs off when the machine is busy. Human-initiated commands receive priority. |
| Multiple agents request identical checks | **In-flight deduplication** executes matching requests once and shares the output and exit code. |
| Tests run repeatedly on unchanged code | **Git working-tree-aware cache** reuses eligible results; `szq explain` shows why a cache lookup missed. |
| Huge command output fills agent context | **`--digest`** keeps the head, tail, and error lines inline while preserving the complete log. |
| Agents keep bypassing your preferred command | **Guard hooks** deny direct calls with guidance to retry through szq—no silent command rewriting. |

### Measured, not imagined

On the project's **Apple M1 Pro benchmark**, with eight callers and a two-job concurrency cap, szq compared with tman 0.7.10 as follows:

| Workload | tman | szq | Observed speedup |
|---|---:|---:|---:|
| 8 identical TypeScript checks requested concurrently | 22.32 s | 4.46 s | **5.01×** |
| 8 repeated TypeScript checks after warm-up | 30.23 s | 0.59 s | **51.11×** |
| 8 distinct ~2 CPU-second jobs | 13.09 s | 9.20 s | **1.42×** |

In a separate output benchmark, digesting **2,502 lines** reduced estimated context from **~8,968 to ~280 tokens (~97%)** while retaining the error.

These are *specific measured workloads, not general speed guarantees*. Cached runs and concurrent duplicate requests benefit most; queueing independent work can make total completion time **slower**. Read the [full benchmarks](#benchmarks) and [reproducible methodology](bench/TMAN.md).

## Quick start

**Requirements:** Node.js 18+; Git for content-based caching (queueing works without it). No runtime dependencies.

```bash
# Install from source (available now)
git clone https://github.com/kimyejoon/szq.git
cd szq
npm link

# Check your installation
szq doctor

# Run expensive checks through the shared queue
szq tsc --noEmit
szq vitest run path/to/file.test.ts
szq pnpm --filter api test

# See what's running and what you've saved
szq status
szq stats
```

> **npm installation:** `npm install -g szq` is intended for use **after the first npm publication**. The repository README does not confirm the package is published yet.

### Integrate with your coding agent

Install a hook for the agents you use:

```bash
szq hook install claude-code
szq hook install codex       # Then approve/trust the hook with /hooks in Codex
szq hook install cursor      # Also supports windsurf, copilot, gemini (experimental)
szq doctor
```

When an agent attempts to run `tsc` directly, the hook blocks the call **with an explanation** and instructs it to retry via `szq --digest tsc --noEmit`. Hooks can be removed using `szq hook uninstall <agent>`. Installation is idempotent and backs up existing configuration.

You can also integrate agents without supported hooks using `szq shim install` or copy rules from `szq rules`. See [Agent support](#agent-support).

## See it in action

Here's an **illustrative** session showing queue status, digest output, a cache hit, and an explained cache miss:

```text
# illustrative session
$ szq --digest vitest run src/billing
[szq] waiting #2 (2/2 running), 14s elapsed - ahead: ~/work/app-b: vitest run src/auth
[szq] your turn (waited 31s).
 FAIL  src/billing/invoice.test.ts > rounds totals
   AssertionError: expected 10.01 to be 10
 ...
[szq] digest: showing 58 of 1843 lines (head, tail and error lines). Full output: ~/.local/state/szq/logs/20261026-140211-3ac5.log
[szq] exit code 1 (ran 9s)

$ szq --digest vitest run src/billing          # nothing changed: instant, same output, same exit code
[szq] cache hit (14:02:11, exit code 1 - failed results are reused for 10 min ...)

$ szq explain -- vitest run src/billing
different from the last run because:
  - modified 1 file(s): src/billing/invoice.ts
```

> **Project status — v0.1.0.** macOS is tested locally; Linux and Windows are covered by CI. The author has **not validated Windows on physical Windows hardware**. Gemini CLI hooks are experimental. See [Platform support](#platform-support).

---

## How it works

1. **Queue:** A shared FIFO queue starts at roughly one job per four CPU cores and expands when there's headroom. It can limit effective concurrency to one under heavy external load.
2. **Share:** For identical commands in the same repository directory and working-tree state, concurrently requesting agents share one execution.
3. **Cache:** Subsequent eligible requests can reuse results when the relevant inputs are unchanged. Success results default to 24 hours of retention, failures to 10 minutes.
4. **Digest:** Agent-facing logs retain the diagnostically useful lines in the response while keeping full output retrievable through `szq logs`.

**Important:** This is a machine-local optimization, not a remote build cache or a security sandbox. Git-ignored and external inputs need explicit consideration for cache correctness; see the next section.

## What counts as "the same request"?

Same **command line**, same **directory** inside the repository, and the same **working-tree content**: every tracked
file as it is on disk (deleted ones included), every untracked file that is not ignored, initialised submodules,
plus the Node version and any environment variables you list in `cache.env`. szq reads the files itself - it never
asks git to compare contents, so repository-defined filters and diff helpers cannot run.

It does **not** include files git ignores (`node_modules`, generated `dist/`...), anything outside the repository, or
other environment. If your command depends on those, pass `--no-cache` (the queue still applies), list the file under
`cache.extraFiles` (e.g. `node_modules/.modules.yaml`), or switch caching off. Successful results are kept for 24 h,
failures for 10 min; timeouts, crashes and runs during which the tree changed are never cached.
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

| | |
|---|---|
| `szq [opts] [--] <command...>` | run through the queue (options below) |
| `szq status [--json]` | running, waiting and joined runs; cache size |
| `szq explain [--] <command...>` | would this be served from the cache? if not, which files changed since the last run? |
| `szq logs [show [N]\|path]` | the full, unmodified output of recent runs |
| `szq stats [--days N] [--json]` | runs executed, cache hits, shared runs, and the work avoided |
| `szq cache clear` | drop cached results |
| `szq hook install\|uninstall\|status <agent>` | manage the agent hook (`--project`, `--local`, `--dry-run`, `--absolute-node`) |
| `szq shim install\|uninstall\|status` | PATH launchers named `tsc`, `vitest`, `jest` that route through szq - works with any agent |
| `szq rules [--lang en\|ko]` | rules block to paste into `AGENTS.md` / `CLAUDE.md` for agents without hooks |
| `szq config [show\|path\|set <key> <json>]` | inspect / change settings |
| `szq doctor` | diagnose installation |

Run options: `--cap N`, `--timeout SEC`, `--stall SEC` (kill a run that prints nothing), `--max-mem MB` (POSIX),
`--max-wait SEC`, `--exclusive` (run alone), `--priority high|normal|low`, `--digest` / `--no-digest`, `--no-cache`,
`--changed[=REF]` (vitest/jest only).

Exit codes: the command's own; `64` usage, `70` internal, `75` waited too long, `124` timed out, `125` stalled,
`126` memory limit, `127` failed to start. Commands that wait for input or run in watch mode are not supported
(stdin is closed; real watch flags are refused).

`--digest` is on by default when stdout is not a terminal **and** an agent environment is detected (`CLAUDECODE` or
`SZQ_AGENT`); plain pipes (`szq tsc | grep error`) are never rewritten. In digest mode stdout and stderr are merged
into one stream. The full output is always kept (`szq logs`).

## Agent support

| Agent | How | Status |
|---|---|---|
| Claude Code | `PreToolUse` hook (deny with reason) | verified against docs |
| OpenAI Codex CLI | `PreToolUse` hook (deny with reason) | verified against docs |
| Cursor | `beforeShellExecution` hook (deny) | verified against docs |
| Windsurf (Devin Desktop) | `pre_run_command` hook (exit 2) | verified against docs |
| GitHub Copilot CLI | `preToolUse` hook (deny, always exits 0) | verified against docs |
| Gemini CLI | `BeforeTool` hook (exit 2) | experimental |
| anything else | `szq shim install`, or `szq rules` into the agent's instructions | works |
| your own | write an [adapter](docs/ADAPTERS.md) (`--adapter-module`) | - |

"Verified against docs" = implemented to the published hook protocol and unit-tested against it; see
[docs/ADAPTERS.md](docs/ADAPTERS.md). The guard is a **seatbelt for a lazy-but-cooperative agent, not a security
boundary** - a determined caller can always evade it (`eval`, a script that calls `tsc`). It fails open: if
anything goes wrong it allows the command.

## Configuration

`szq config path` shows the file (`~/.config/szq/config.json`, `%APPDATA%\szq\config.json` on Windows).

```json
{
  "concurrency": "auto",
  "maxConcurrency": "auto",
  "headroom": { "enabled": true, "cpuBelow": 0.55, "settleMs": 800 },
  "timeoutSec": 900,
  "maxWaitSec": 1800,
  "stallSec": 0,
  "maxMemMB": 0,
  "adaptive": { "enabled": true, "loadPerCpu": 1.5 },
  "output": { "digest": "auto", "maxLines": 200, "head": 15, "tail": 40 },
  "logs": { "keep": 50 },
  "cache": { "enabled": true, "successTtlHours": 24, "failureTtlMinutes": 10, "maxEntryMB": 4, "env": [], "extraFiles": [] },
  "incremental": { "tsc": false },
  "guard": { "commands": ["tsc", "vitest", "jest"], "scripts": ["test", "typecheck"] },
  "lang": "auto"
}
```

`concurrency: "auto"` starts with CPUs / 4 and admits more runs (up to `maxConcurrency`, default 75% of the CPUs) while
recent CPU utilisation is below `headroom.cpuBelow`; a number pins it. `guard.commands` / `guard.scripts` decide what
the hook blocks (add `pytest`, `eslint`, `check`...). `adaptive` lowers
the effective concurrency to 1 while the 1-minute load average exceeds `loadPerCpu` x CPUs (not available on
Windows). Environment: `SZQ_CONCURRENCY`, `SZQ_HOME` (state directory), `SZQ_CONFIG`, `SZQ_LANG` (`en`|`ko`),
`SZQ_CACHE_SALT`, `SZQ_AGENT=1` (treat this shell as an agent). Human kill switch: create an empty file named
`DISABLE` in the state directory and the hooks allow everything.

## Platform support

| | |
|---|---|
| macOS | tested: the author's daily platform and the full test suite |
| Linux | covered by CI (`ubuntu-latest`) |
| Windows | implemented: `PATHEXT` lookup, `.cmd`/`.bat` shims such as `npm`/`pnpm`/`tsc.cmd` through `cmd.exe`, process-tree kill with `taskkill /T`. Covered by CI on `windows-latest`, **not verified on real Windows hardware by the author**. Arguments containing `"` or `%` are rejected for `.cmd` shims (cmd.exe would re-interpret them) - call the `.exe` directly or avoid those characters. No memory limit, no load back-off, and orphaned children of a crashed szq are not reaped (Windows reuses pids too aggressively to kill by recorded pid safely). |

## Benchmarks

Direct comparison against the **tman 0.7.10 release binary**, with equal concurrency and validated results for every
caller: [bench/TMAN.md](bench/TMAN.md). Reproduce with `npm run bench:tman -- --tman /absolute/path/to/tman`.

On the measured M1 Pro, with eight callers and both tools capped at two concurrent jobs (three-run medians):

| Scenario | tman | szq | speedup |
|---|---:|---:|---:|
| Eight different ~2 CPU-second jobs | 13.09 s | 9.20 s | 1.42× |
| Eight concurrent identical TypeScript checks | 22.32 s | 4.46 s | 5.01× |
| Eight sequential TypeScript checks after warm-up | 30.23 s | 0.59 s | 51.11× |

All callers received the expected successful result. These are fixed-concurrency results for tman 0.7.10 on macOS;
the linked report records flags, ranges, background load and raw samples, including the cost excluded by warm-up.

Methodology, profile and before/after numbers: [docs/PERFORMANCE.md](docs/PERFORMANCE.md); raw tables:
[bench/RESULTS.md](bench/RESULTS.md); reproduce with `npm run bench`. Measured on an Apple M1 Pro (8 cores) that other
work kept busy, 8 simultaneous "agents":

| Scenario | without szq | with szq |
|---|---|---|
| 8 agents run the **same** command on the same code | 8 executions, 18 CPU-s, 100% CPU, 2.7-3.0 s | **1 execution, 2 CPU-s**, 43-56% CPU, **2.2 s** |
| 8 agents run a real `tsc --noEmit` (generated project) on the same code | 8.3-9.6 s | **2.9-3.2 s** |
| 8 agents run 8 **different** commands | all at once, 2.7 s | queued: **8.5 s** on a lightly loaded machine, 17 s when other work keeps it busy - **slower** |
| repeat the same command on unchanged code | every call runs | first call runs, the rest take **~0.07 s** |
| output an agent has to read (2,502 lines, one error) | ~8,968 tokens | `--digest`: ~280 tokens, error kept |

The queue is a **trade of throughput for responsiveness**: distinct commands finish later than in a stampede on an idle
machine, but the machine stays usable and duplicated work disappears. It only starts as many runs as the CPU can take
and drops to one when the machine is busy; raise `concurrency` if you prefer speed. The numbers describe one laptop at
one moment; run the benchmark on yours.

## Compared with tman and friends

szq is not the first tool here; [tman](https://github.com/standardbeagle/tman) in particular overlaps a lot and is
more mature in process supervision. Comparison based on each project's public README (October 2026):

| | szq | [tman](https://github.com/standardbeagle/tman) |
|---|---|---|
| Machine-wide queue with a cap | yes (starts at CPUs/4, grows with CPU headroom) | named queues budget cores/memory; per-command slots default to 2 |
| Handling of an identical request | **waits and shares the result**; results cached by working-tree content | refuses the duplicate by name (per directory); no result reuse described |
| Why was it a cache miss? | `szq explain` | not described |
| Output for agents | `--digest` (head/tail/errors inline + full log path) | run logs and failure digests as files |
| Hung / runaway runs | timeout; stall and memory limit (opt-in, POSIX) | wall time, stall (default 30 min), CPU/memory culling, kernel-enforced limits on Linux/Windows |
| Back off when the machine is busy for other reasons | yes (load-average back-off) | yes, outside load is counted in named-queue admission (0.7.10) |
| Human-first priority, `--exclusive` | yes, yes | exclusive runs described |
| Savings report | `szq stats` | not described |
| Agent integration | deny-with-guidance: Claude Code, Codex, Cursor, Windsurf, Copilot CLI (+ Gemini experimental), PATH shims, rules block | rewrite or gate hooks for Claude Code, Codex, Gemini CLI, opencode, Cursor, Antigravity, Kimi Code CLI, Copilot CLI; shims for others |
| Implementation | Node >= 18, no dependencies, ~3,300 lines | C# / .NET NativeAOT single binary |
| Platforms | macOS/Linux tested, Windows beta | Linux, macOS, Windows binaries |

Choose tman for supervision (hard resource limits, hang detection) and broader agent coverage today. Choose szq when
the problem is **duplicated work and context cost**: the same checks requested by many agents, and long outputs.
They can coexist. Other related tools ([tdd-cli](https://github.com/geuben/tdd-cli), `tsp`/`pueue`, `flock`,
Turborepo/Nx caches): [docs/ALTERNATIVES.md](docs/ALTERNATIVES.md).

## Security

State is private to your user (mode `0700`, ownership checked, symlinks refused). szq never lets git run
repository-defined helpers (it only lists files and hashes them itself), uses no shell on POSIX, kills only process
groups it can positively identify, and its hook is fail-open. Cached output is stored in plain text - **do not run
commands that print secrets through the cache** (use `--no-cache`). The code went through two independent
adversarial reviews before release; findings and fixes are in [CHANGELOG.md](CHANGELOG.md). Full model and how to report
vulnerabilities: [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome - especially adapters for more agents. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Kim Yejoon

# szq

**A shared queue, a git-aware result cache and guard hooks for the heavy commands your AI coding agents keep running.**

[![CI](https://github.com/kimyejoon/szq/actions/workflows/ci.yml/badge.svg)](https://github.com/kimyejoon/szq/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English · [한국어](README.ko.md)

---

Run five Claude Code / Codex / Cursor sessions on one laptop and each of them will, many times an hour,
start `tsc --noEmit`, `vitest` or `jest` - often the *same* check on the *same* code, at the *same* moment.
The machine melts (a load average of 50+ on an 8-core laptop is easy to reach), your dev server times out,
most of that CPU time is duplicated work, and every run dumps thousands of lines into the agent's context.

`szq` fixes this at the command level:

1. **One queue per machine.** Heavy commands run through a FIFO queue with a concurrency cap
   (default: CPUs / 4) that backs off further when the machine is already busy for other reasons.
   Waiting agents see their position; a human typing in a terminal goes first.
2. **Identical runs run once.** Requests are fingerprinted by *command + the content of your git working tree*.
   If N agents ask for the same thing, one runs it and the others receive the same output and exit code.
   A repeated call on unchanged code returns instantly from the cache - and `szq explain` tells you why a call missed.
3. **Agents are told, not tricked.** A hook for your agent blocks a direct `tsc`/`vitest`/`jest` and tells the model to
   re-run it as `szq --digest ...`. No silent rewriting: the agent learns the rule.
4. **Agents read less.** `--digest` replaces thousands of output lines by the head, the tail and the error lines,
   and prints where the full log is. Same information that matters, ~97% less context in our benchmark.

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

> **Status: 0.1.0.** Works on macOS and Linux. Windows is implemented and tested in CI but the author has not
> used it on real Windows hardware (see [Platform support](#platform-support)). Gemini CLI support is experimental.

## Install

```sh
npm install -g szq            # after the first npm release
# or from source:
git clone https://github.com/kimyejoon/szq.git && cd szq && npm link
```

Requires Node.js >= 18 and `git` (without git szq still queues, it just cannot cache). No dependencies.

## Quick start

```sh
# 1. put the guard in front of your agent (installs are idempotent and keep a backup)
szq hook install claude-code
szq hook install codex          # then run `/hooks` inside Codex once to trust it
szq hook install cursor         # also: windsurf, copilot, gemini (experimental)

# 2. check everything
szq doctor

# 3. use it yourself, too
szq tsc --noEmit
szq vitest run path/to/file.test.ts
szq pnpm --filter api test
szq status                      # who is running / waiting
szq stats                       # how much work the cache and sharing saved you
```

From now on, when an agent tries `tsc --noEmit` directly it gets:

> `[szq] Running 'tsc' directly is blocked on this machine. ... Re-run the same command prefixed with szq --digest, e.g. szq --digest tsc --noEmit ...`

and retries with `szq --digest`. Remove the hook any time with `szq hook uninstall <agent>`.

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

`guard.commands` / `guard.scripts` decide what the hook blocks (add `pytest`, `eslint`, `check`...). `adaptive` lowers
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

Full tables and methodology: [bench/RESULTS.md](bench/RESULTS.md); reproduce with `npm run bench`. Measured on an Apple
M1 Pro (8 cores) that was lightly loaded by other work (24% CPU before the run), 8 simultaneous "agents":

| Scenario | without szq | with szq |
|---|---|---|
| 8 agents run the **same** command on the same code | 8 executions, 18.4 CPU-s, 100% CPU | **1 execution, 2 CPU-s**, 56% CPU; wall time about the same (3.0 s vs 3.5 s) |
| 8 agents run a real `tsc --noEmit` (generated project) on the same code | 13.0 s | **3.7 s** |
| 8 agents run 8 **different** commands | all at once, 3.0 s | queued 2 at a time, **11.2 s - slower** |
| repeat the same command on unchanged code | every call runs | first call runs, the rest take ~0.1 s |
| output an agent has to read (2,502 lines, one error) | 8,968 tokens (approx.) | `--digest`: 280 tokens (approx.), error kept |

The queue is a **trade of throughput for responsiveness**: on an idle machine, distinct commands finish later than in
a stampede (raise `concurrency` if your machine has headroom), but the machine stays usable and duplicated work
disappears. The numbers describe one laptop at one moment; run the benchmark on yours.

## Compared with tman and friends

szq is not the first tool here; [tman](https://github.com/standardbeagle/tman) in particular overlaps a lot and is
more mature in process supervision. Comparison based on each project's public README (October 2026):

| | szq | [tman](https://github.com/standardbeagle/tman) |
|---|---|---|
| Machine-wide queue with a cap | yes (default CPUs/4) | yes (default 2 per queue; admission by expected core/memory cost) |
| Handling of an identical request | **waits and shares the result**; results cached by working-tree content | refuses the duplicate by name (per directory); no result reuse described |
| Why was it a cache miss? | `szq explain` | not described |
| Output for agents | `--digest` (head/tail/errors inline + full log path) | run logs and failure digests as files |
| Hung / runaway runs | timeout; stall and memory limit (opt-in, POSIX) | wall time, stall (default 30 min), CPU/memory culling, kernel-enforced limits on Linux/Windows |
| Back off when the machine is busy for other reasons | yes (load-aware) | not described |
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
commands that print secrets through the cache** (use `--no-cache`). The design went through an independent
adversarial review before release; findings and fixes are in [CHANGELOG.md](CHANGELOG.md). Full model and how to report
vulnerabilities: [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome - especially adapters for more agents. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Kim Yejoon

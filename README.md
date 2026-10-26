# szq

**A shared queue, a git-aware result cache and guard hooks for the heavy commands your AI coding agents keep running.**

[![CI](https://github.com/kimyejoon/szq/actions/workflows/ci.yml/badge.svg)](https://github.com/kimyejoon/szq/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English · [한국어](README.ko.md)

---

Run five Claude Code / Codex / Cursor sessions on one laptop and each of them will, many times an hour,
start `tsc --noEmit`, `vitest` or `jest` - often the *same* check on the *same* code, at the *same* moment.
The machine melts (load average 50+ on an 8-core laptop is easy to reach), your dev server times out, and
most of that CPU time is duplicated work.

`szq` fixes this at the command level:

1. **One queue per machine.** Heavy commands run through a FIFO queue with a concurrency cap
   (default: CPUs / 4). Waiting agents see their position.
2. **Identical runs run once.** Requests are fingerprinted by *command + git working tree*
   (HEAD, tracked changes, untracked files). If N agents ask for the same thing, one runs it and the others
   receive the same output and exit code. A repeated call on unchanged code returns instantly from the cache.
3. **Agents are told, not tricked.** A hook for your agent blocks a direct `tsc`/`vitest`/`jest` and tells the
   model to re-run it as `szq tsc ...`. No silent rewriting - the agent learns the rule.

```text
# illustrative session
$ szq vitest run src/billing
[szq] waiting #2 (2/2 running), 14s elapsed - ahead: ~/work/app-b: vitest run src/auth
[szq] your turn (waited 31s).
 ✓ src/billing/invoice.test.ts (12 tests)
[szq] exit code 0 (ran 9s)

$ szq vitest run src/billing          # nothing changed
 ✓ src/billing/invoice.test.ts (12 tests)
[szq] cache hit (14:02:11, exit code 0)
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
# 1. put the guard in front of your agent (pick yours; installs are idempotent and keep a backup)
szq hook install claude-code
szq hook install codex          # then run `/hooks` inside Codex once to trust it
szq hook install cursor

# 2. check everything
szq doctor

# 3. use it yourself, too
szq tsc --noEmit
szq vitest run path/to/file.test.ts
szq pnpm --filter api test
szq status                      # who is running / waiting
```

From now on, when an agent tries `tsc --noEmit` directly it gets:

> `[szq] Running 'tsc' directly is blocked on this machine. ... Re-run the same command prefixed with szq, e.g. szq tsc --noEmit ...`

and retries with `szq`. Remove it any time with `szq hook uninstall <agent>`.

## What counts as "the same request"?

Same **command line**, same **directory** inside the repository, and the same **git working tree**:
`HEAD` + `git diff HEAD` + the contents of untracked (non-ignored) files, plus the Node version and any
environment variables you list in `cache.env`.

It does **not** include files git ignores (`node_modules`, generated `dist/`...), anything outside the repository,
or other environment. If your command depends on those, pass `--no-cache` (the queue still applies) or switch
caching off. Successful results are kept for 24 h, failures for 10 min; timeouts and crashes are never cached.
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

| | |
|---|---|
| `szq [opts] [--] <command...>` | run through the queue. `--cap N`, `--timeout SEC`, `--max-wait SEC`, `--no-cache`, `--changed[=REF]` (vitest/jest only) |
| `szq status` | running, waiting and joined runs; cache size |
| `szq cache clear` | drop cached results |
| `szq hook install\|uninstall\|status <agent>` | manage the agent hook (`--project`, `--local`, `--dry-run`, `--absolute-node`) |
| `szq shim install\|uninstall\|status` | PATH launchers named `tsc`, `vitest`, `jest` that route through szq - works with any agent |
| `szq rules [--lang en\|ko]` | rules block to paste into `AGENTS.md` / `CLAUDE.md` for agents without hooks |
| `szq config [show\|path\|set <key> <json>]` | inspect / change settings |
| `szq doctor` | diagnose installation |

Exit codes: the command's own; `64` usage, `70` internal, `75` waited too long, `124` timed out, `127` failed to start.
Commands that wait for input or run in watch mode are not supported (stdin is closed; `--watch` is refused).

## Agent support

| Agent | How | Status |
|---|---|---|
| Claude Code | `PreToolUse` hook (deny with reason) | verified against docs |
| OpenAI Codex CLI | `PreToolUse` hook (deny with reason) | verified against docs |
| Cursor | `beforeShellExecution` hook (deny) | verified against docs |
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
  "cache": { "enabled": true, "successTtlHours": 24, "failureTtlMinutes": 10, "maxEntryMB": 4, "env": [] },
  "incremental": { "tsc": false },
  "guard": { "commands": ["tsc", "vitest", "jest"], "scripts": ["test", "typecheck"] },
  "lang": "auto"
}
```

`guard.commands` / `guard.scripts` decide what the hook blocks (add `pytest`, `eslint`, `check`...). Environment:
`SZQ_CONCURRENCY`, `SZQ_HOME` (state directory), `SZQ_CONFIG`, `SZQ_LANG` (`en`|`ko`), `SZQ_CACHE_SALT`.
Human kill switch: create an empty file named `DISABLE` in the state directory and the hooks allow everything.

## Platform support

| | |
|---|---|
| macOS | tested: the author's daily platform and the full test suite |
| Linux | covered by CI (`ubuntu-latest`) |
| Windows | implemented: `PATHEXT` lookup, `.cmd`/`.bat` shims such as `npm`/`pnpm`/`tsc.cmd` through `cmd.exe`, process-tree kill with `taskkill /T`. Covered by CI on `windows-latest`, **not verified on real Windows hardware by the author**. Arguments containing `"` or `%` are rejected for `.cmd` shims (cmd.exe would re-interpret them) - call the `.exe` directly or avoid those characters. Claude Code on Windows without Git Bash runs hooks in PowerShell; szq's hook command (`node "<path>" guard ...`) works in both. |

## Benchmarks

See [bench/RESULTS.md](bench/RESULTS.md) for the raw tables and `npm run bench` to reproduce on your machine.
The short version, by design: *same command from N agents* executes once instead of N times; *different
commands* finish **later** in wall-clock time than an all-at-once stampede on an idle machine but keep the
machine responsive (the queue trades throughput for latency of everything else); *repeat calls* on unchanged
code cost ~0.1 s.

## Alternatives

szq is not the first tool here. [tman](https://github.com/standardbeagle/tman) offers process supervision
(kill hung runs, memory/CPU limits), queues and many agent integrations;
[tdd-cli](https://github.com/geuben/tdd-cli) shares cores between concurrent test runs;
`tsp`/`pueue` are general job queues. What szq adds is **result sharing keyed by the git working tree** and
**deny-with-guidance hooks**, in a dependency-free Node package. Honest comparison:
[docs/ALTERNATIVES.md](docs/ALTERNATIVES.md).

## Security

State is private to your user (mode `0700`, ownership checked), git runs with repository-controlled helpers
disabled, no shell is used on POSIX, and the hook is fail-open. Cached output is stored in plain text -
**do not run commands that print secrets through the cache** (use `--no-cache`). Full model and how to
report vulnerabilities: [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome - especially adapters for more agents. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Kim Yejoon

# Architecture

szq is three small mechanisms that share one state directory.

```
agent / human ──► szq <cmd> ──► cache lookup ──► queue (tickets) ──► spawn <cmd> ──► cache write
                                   ▲                                         │
agent hook ──► szq guard ──────────┘ (only decides allow/deny; never runs <cmd>)
```

## State directory

| Platform | Location |
|---|---|
| Linux | `$XDG_STATE_HOME/szq` or `~/.local/state/szq` |
| macOS | `~/.local/state/szq` |
| Windows | `%LOCALAPPDATA%\szq` |
| any | `$SZQ_HOME` overrides the location (used by the tests) |

```
queue/<ticket>.json      one file per live run (waiting or running)
claim.lock/              short-lived mkdir mutex around the "may I start?" decision
cache/<sha256>.json      cached results
tsbuildinfo/             incremental tsc state (opt-in feature)
shims/                   default location of PATH shims
DISABLE                  if present, guard hooks allow everything (human kill switch)
```

The directory is created with mode `0700`. On POSIX szq **refuses to use** a state directory that is not
owned by the current user or is writable by group/others. Cache and ticket files are written `0600`.
The config file lives in `$XDG_CONFIG_HOME/szq/config.json` (`%APPDATA%\szq\config.json` on Windows,
`$SZQ_CONFIG` overrides).

## Queue

A *ticket* is a JSON file named `<13-digit ms timestamp>-<pid>-<random>.json`, so lexical order is
arrival order. It records `pid`, `cwd`, the command line, the request `key` (below) and `state`
(`waiting` | `running`).

- **Heartbeat.** The owner touches its ticket every 5 s. A ticket is *dead* when its pid is gone **or**
  its mtime is older than 60 s (covers frozen processes and pid reuse).
- **Reaping.** Every claim attempt removes dead tickets. If the owner died but its child is still alive,
  the child's process group (POSIX) or tree (`taskkill /T`, Windows) is terminated, so a `kill -9`ed `szq`
  does not leave an orphan burning CPU while holding no slot.
- **Claim.** `mkdir claim.lock` is the mutex (atomic on every filesystem we care about). Inside it szq
  re-reads the tickets, and starts only if `running < cap` and it is among the first `cap - running`
  waiting tickets. A stale mutex (> 10 s) is broken.
- **Wait loop.** Polls once per second. Each poll also re-checks the cache (an identical run may have
  finished) and prints the queue position when it changes or every 30 s.

## Result sharing ("same request")

The *request key* is `sha256` over:

1. szq key version
2. `git rev-parse HEAD`
3. `git diff HEAD --binary --no-ext-diff --no-textconv` (streamed into the hash)
4. every **untracked, non-ignored** file: relative path + contents (symlinks by target, special files
   such as FIFOs are never opened, files > 5 MiB by size only, at most 5000 files)
5. working directory relative to the repository root, the full argument vector
6. Node version and platform
7. values of the environment variables listed in `cache.env` (and `SZQ_CACHE_SALT`)

Among live tickets with the same key the **oldest is the leader**; the rest *follow*: they take no slot,
print "an identical run is ahead", and replay the leader's result when it appears in the cache. If the
leader disappears without producing a cacheable result (killed, timed out, output too large) the next
follower becomes leader and runs the command. Distinct keys are scheduled FIFO as usual.

**What is *not* in the key** (and therefore a stale-result risk): files ignored by git (`node_modules`,
build output such as a generated `dist/`), files outside the repository, the environment (except the listed
variables), the time, the network. Use `--no-cache` when a command depends on those. Outside a git
repository there is no key and nothing is cached or shared.

## Cache entries

```json
{ "v": 1, "at": 1767000000000, "ttl": 86400000, "code": 0, "cmd": "tsc --noEmit",
  "chunks": [[1, "<base64 stdout>"], [2, "<base64 stderr>"]] }
```

Exit code 0 is kept for `cache.successTtlHours` (24), exit codes 1-123 for `cache.failureTtlMinutes` (10).
Timeouts (124), signals (>= 128) and failures to start (127) are never cached; output larger than
`cache.maxEntryMB` (4) is not cached. Output is stored **verbatim** - see [SECURITY.md](../SECURITY.md)
about secrets in command output.

## Running the command

- No shell on POSIX: the argument vector is passed to `spawn` unchanged. On Windows `.exe` is spawned
  directly and `.cmd`/`.bat` shims (npm, pnpm, `tsc.cmd`) go through `cmd.exe` - arguments containing `"`
  or `%` are rejected there because `cmd.exe` would re-interpret them.
- `node_modules/.bin` directories from the working directory up to the repository root are put on `PATH`
  (what `pnpm exec` does), so `szq tsc` finds the project's compiler.
- The child gets `SZQ_ACTIVE=1`. A nested `szq` call inside a running job then runs the command directly
  instead of queueing behind itself.
- stdin is closed; stdout/stderr are piped, teed to the terminal and buffered for the cache. Watch modes
  are refused (`--watch`, `-w`).
- Timeout kills the process group / tree (SIGTERM, then SIGKILL after 5 s) and exits `124`.

## Guard

`szq guard <adapter>` reads one JSON event from stdin, asks the adapter for `{command}`, classifies it
(`src/guard/classify.js`), and answers in the agent's dialect. Any exception, unknown adapter, or
unparsable input answers "allow" (fail-open). The classifier looks at command *structure* (it strips quoted
strings and heredoc bodies, splits on `; && || | & ( ) {}` and backticks, skips wrappers such as `env`,
`sudo`, `time`, `xargs`) so that `git commit -m "fix tsc"` and `pnpm add -D vitest` pass while `pnpm --filter
x test`, `npx vitest run` and `node node_modules/typescript/bin/tsc` are caught.

## Shims

`szq shim install` writes launchers named like the guarded commands into a directory you put at the front
of `PATH`. A launcher sets `SZQ_SHIM_DIR` to its own directory and calls `szq run-shim <name> args...`; szq
removes that directory from `PATH` when it looks up the real tool, and aborts if it ever detects a shim
resolving to itself.

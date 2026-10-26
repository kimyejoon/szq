# Architecture

szq is a few small mechanisms that share one state directory.

```
agent / human ──► szq <cmd> ──► fingerprint ──► cache lookup ──► queue (tickets) ──► spawn <cmd> ──► cache write
                                                    ▲                                    │
agent hook ──► szq guard ───────────────────────────┘ (only decides allow/deny)          └─► log, stats, digest
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
last/<hash>.json         the fingerprint of the last run of each (directory, command) - used by `szq explain`
statcache/<hash>.json    (size, mtime, ctime) -> content hash, so unchanged files are not re-read
logs/<time>-<rand>.log   full output of the newest `logs.keep` runs
stats.jsonl              one JSON line per request (rotated at 1 MiB)
tsbuildinfo/             incremental tsc state (opt-in feature)
shims/                   default location of PATH shims
DISABLE                  if present, guard hooks allow everything (human kill switch)
```

The directory is created with mode `0700`. On POSIX szq **refuses to use** a state directory that is not owned by the
current user or is writable by group/others. All files are written `0600`. The config file lives in
`$XDG_CONFIG_HOME/szq/config.json` (`%APPDATA%\szq\config.json` on Windows, `$SZQ_CONFIG` overrides).

## Request fingerprint

A request is `sha256(JSON([version, treeHash, cwdRel, argv, node, platform, env, extras, salt]))`. JSON encoding makes
every field boundary unambiguous; `treeHash` is built from length-prefixed `(path, content-hash)` pairs, so no file
name or content can be crafted to run into the next entry.

`treeHash` covers

1. every **tracked** file (`git ls-files -s -z`) as it is on disk - modified, deleted (`gone`) and unmodified alike,
2. every **untracked, non-ignored** file (`git ls-files -o --exclude-standard -z`),
3. initialised **submodules**, recursively (depth 2),
4. at most 20,000 files; beyond that the directory is not cached.

Files are hashed by szq itself: regular files by content (`sha256`), symlinks by target, FIFOs/sockets/devices are never
opened, files over 5 MiB by `size + mtime`. szq asks git only to *list* files. It never asks git to compare or diff
content, because comparing runs a repository's clean/smudge filters and diff helpers (`filter.*.clean`,
`diff.*.textconv`) - code a hostile repository could define. A `(size, mtime, ctime) -> hash` cache keeps repeated
fingerprints fast on large trees.

Also in the key: the working directory relative to the repository root, the full argument vector, the Node version and
platform, the values of the variables listed in `cache.env`, the content of `cache.extraFiles`, `SZQ_CACHE_SALT`.

**Not in the key** (stale-result risk): files git ignores (`node_modules`, build output such as a generated `dist/`,
`.env`), files outside the repository, the rest of the environment, the clock, the network. Use `--no-cache`,
`cache.extraFiles`, or `cache.env`. Outside a git repository there is no key and nothing is cached or shared.

**Changes during a run.** The fingerprint is computed again after the command finishes; if the tree changed, the result
is *not* cached. A change that is made and reverted while the command runs cannot be detected.

`szq explain` recomputes the fingerprint and compares its per-file map with the one stored for the last run of the same
(directory, command) to name modified/added/removed files, changed environment, and so on.

## Queue

A *ticket* is a JSON file named `<13-digit ms timestamp>-<pid>-<random>.json`, so lexical order is arrival order. It
records `pid`, `host`, the owner's start time, `cwd`, the command line, the request `key`, `prio`, `exclusive` and
`state` (`waiting` | `running`), later `childPid` and `childStart`.

- **Liveness.** A ticket is dead when its owner's pid is gone, or the pid now belongs to a different process (start time
  mismatch), or - last resort - its heartbeat (touched every 5 s) is older than 30 min (5 min where start times are
  unavailable). A laptop that sleeps does not lose its tickets. Tickets from another host (shared home directory) are
  treated as unverifiable.
- **Reaping and orphans.** Dead tickets are removed on every claim attempt. If the owner died but its child is still
  running, the child's **process group** is terminated - but only when the host matches **and** the child's recorded
  start time still matches the live process, re-checked before the follow-up SIGKILL. Pid 0/1/negative/non-integer
  values are never signalled, and szq never falls back to signalling a bare pid. On Windows orphans are not killed.
- **Mutex.** `mkdir claim.lock` is atomic. A stale mutex (> 10 s) is broken by renaming it away - exactly one waiter wins.
- **Admission** (`src/queue.js: admit`): waiting tickets are ordered by priority (`high` for a human at a terminal,
  `normal` for everything else, or `--priority`) and then arrival. A ticket starts if `running < cap` and it is among
  the admitted ones. An `--exclusive` ticket needs an empty machine and blocks everyone behind it; nobody starts while an
  exclusive run is active.
- **Effective cap.** `cap` is `--cap`, `$SZQ_CONCURRENCY`, `concurrency` or CPUs/4. While the 1-minute load average
  exceeds `adaptive.loadPerCpu` x CPUs the cap for new starts is 1 (never 0, so a busy machine cannot starve the queue).
- **Waiting.** Polls once per second (followers every 250 ms), re-checking the cache each time, printing the queue
  position when it changes or every 30 s.

## Identical requests ("followers")

Among live tickets with the same key the **oldest is the leader**; the rest *follow*: they take no slot, print "an
identical run is ahead", and replay the leader's result when it appears in the cache. If the leader disappears without
a cacheable result (killed, timed out, stalled, tree changed, output too large) the next follower becomes leader and
runs the command.

## Cache entries

```json
{ "v": 1, "at": 1767000000000, "ttl": 86400000, "code": 0, "cmd": "tsc", "ms": 41000, "logFile": "...",
  "chunks": [[1, "<base64 stdout>"], [2, "<base64 stderr>"]] }
```

Exit code 0 is kept for `cache.successTtlHours` (24), exit codes 1-123 for `cache.failureTtlMinutes` (10). Timeouts
(124), stalls (125), memory kills (126), signals (>= 128) and failures to start (127) are never cached; output larger than
`cache.maxEntryMB` (4) is not cached. Only the command *name* is stored, never its arguments. Output is stored
**verbatim** - see [SECURITY.md](../SECURITY.md) about secrets in command output.

## Running the command

- No shell on POSIX: the argument vector is passed to `spawn` unchanged. On Windows `.exe` is spawned directly and
  `.cmd`/`.bat` shims (npm, pnpm, `tsc.cmd`) go through `cmd.exe` - arguments containing `"`, `%` or a newline are
  rejected there because `cmd.exe` would re-interpret them.
- A bare command name is looked up in the project's `node_modules/.bin` directories (cwd up to the repository root)
  first - `szq tsc` finds the project's compiler. **Only the command word is resolved this way; `PATH` is not modified**,
  so `node`, `git` or `make` cannot be shadowed by a binary planted in a repository.
- The child gets `SZQ_ACTIVE=1`; a nested `szq` call inside a running job then runs its command directly instead of
  queueing behind itself.
- stdin is closed; stdout/stderr are piped, teed to the terminal (unless digesting), written to the log file (up to
  64 MiB) and buffered for the cache. Real watch modes are refused (`--watch`, `vitest -w`, `tsc -w`; `jest -w` is
  `--maxWorkers` and is allowed).
- Supervision: `--timeout` (default 900 s), `--stall` (no output), `--max-mem` (POSIX: resident memory of the process
  group, sampled with `ps`). Each kills the process group / tree (SIGTERM, then SIGKILL after 5 s) and sets exit code
  124 / 125 / 126.

## Output digest

When digesting, output is not streamed: the log file is read after the run and reduced by `src/digest.js` - the first
`head` lines, the last `tail` lines, and every line matching error patterns in between (`error TS####`, `FAIL`,
`AssertionError`, summary lines such as `Tests: 1 failed`, ...) with up to three indented continuation lines, capped.
It says how many lines were omitted and where the full log is. Short outputs pass through unchanged. Digest mode merges
stdout and stderr into one stream (arrival order).

## Guard

`szq guard <adapter>` reads one JSON event from stdin, asks the adapter for `{command}`, classifies it
(`src/guard/classify.js`), and answers in the agent's dialect. Any exception, unknown adapter or unparsable input answers
"allow" (fail-open) - in the adapter's own dialect once the adapter is known, because some agents treat an empty answer
as a block. The classifier is a single linear pass over at most 64 KiB: it strips quoted strings, heredoc bodies, comments
and line continuations, splits on `; && || | & ( ) { }` and backticks, skips wrappers such as `env`, `sudo`, `time`,
`xargs`, and looks at the command word and - for package runners - the script name. `git commit -m "fix tsc"`,
`pnpm add -D vitest` and `tsc --version` pass; `pnpm --filter x test`, `npx vitest run` and
`node node_modules/typescript/bin/tsc` are caught.

## Shims

`szq shim install` writes launchers named like the guarded commands into a directory you put at the front of `PATH`. A
launcher sets `SZQ_SHIM_DIR` to its own directory and calls `szq run-shim <name> args...`; szq removes that directory
from `PATH` for the child, and aborts if it ever detects a shim resolving to itself. Install refuses to overwrite files
that are not shims, and uninstall removes only regular files that carry the shim marker.

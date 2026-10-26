# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

First public version.

### Added
- FIFO queue shared by all processes of a user, with a configurable concurrency cap (`auto` = CPUs / 4), queue
  position output, per-run timeout and maximum wait. **Adaptive**: the cap drops to 1 while the machine is busy for
  reasons outside the queue. **Human-first**: runs typed in a terminal go before agent runs (`--priority`).
  `--exclusive` runs alone.
- Result sharing: identical commands on an identical git working tree run once; concurrent duplicates wait for and
  replay the leader's result. Successful results are cached for 24 h, failed results for 10 min. `szq explain` names the
  files that changed since the last run; `szq stats` reports the work avoided.
- `--digest`: long output is reduced to head, tail and error lines with a pointer to the full log (`szq logs`);
  automatic for agents writing to a pipe (`CLAUDECODE`, `SZQ_AGENT`).
- Supervision: `--stall` and `--max-mem` (POSIX) in addition to `--timeout`; exit codes 124/125/126.
- Self-healing queue: dead owners are detected by pid and start time, their tickets are removed and orphaned child
  processes are terminated; a follower takes over when the leader dies.
- Guard hooks (`szq guard`) and installer (`szq hook install|uninstall|status`) with adapters for Claude Code, OpenAI
  Codex CLI, Cursor, Windsurf and GitHub Copilot CLI, plus an experimental Gemini CLI adapter. The installer is
  idempotent, keeps timestamped backups and refuses to touch files it cannot parse.
- Adapter interface for third-party agents (`--adapter-module`), PATH shims (`szq shim`), rules block generator
  (`szq rules`).
- Windows support (PATHEXT resolution, `.cmd` shims through `cmd.exe` with argument rejection, `taskkill /T`), covered by
  CI on `windows-latest`.
- English and Korean CLI messages and documentation; benchmarks (`npm run bench`).

### Fixed
- Under heavy load identical concurrent requests could occasionally execute twice: leader election trusted the ticket
  id order, but a ticket file can become visible later than its id suggests. A running ticket with the same key now wins
  whatever the arrival order. Regression and stress tests added.

### Performance
- A cache hit takes ~0.07 s instead of ~0.13 s: the repository root is found without starting git, one `git ls-files`
  replaces two, the post-wait fingerprint is skipped after an immediate start, housekeeping is occasional, modules load
  lazily. Waiters are woken by file-system events instead of a 1 s poll. Idle-aware concurrency admits more runs while
  the CPU has headroom. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Security
Two independent adversarial reviews before the first release. **Second review** (ten findings, all fixed with
regression tests): a failure after the slot was taken left a ticket (and the process) alive forever - everything after
the claim now runs under `try/finally`, logs of running runs are never pruned and a vanished log falls back to the
in-memory output; a quadratic-time regex in the digest (a 240 KB line took 43 s) replaced by linear checks on bounded
lines; the cache key ignored HEAD/refs for `--changed`/`--changedSince`; `ps` was started once per ticket per queue
decision (now only for quiet tickets) and the claim mutex carries an owner token; the SIGKILL follow-up could read a
nulled child; the digest lost the real tail of output beyond the 64 MiB log cap; `node`/`git`/package managers could be
shadowed from `node_modules/.bin`; `--project` installs followed symlinks out of the project; the stat cache trusted
entries younger than the timestamp granularity (racily clean) and big files lacked ctime/inode; "last run" records kept
the command line and environment values; `cmd.exe` is now started with `/v:off` and `%` in resolved paths is rejected.

**First review** - found the following, all fixed with regression tests:

- **Medium** - a relative `--adapter-module` was resolved against the agent's working directory, so a repository could
  have its own code executed by the hook. Paths are now pinned to an absolute, symlink-free path at install time and
  relative paths are refused at load time.
- **Medium** - orphan cleanup could signal an unrelated process: it fell back to signalling the bare pid when the group
  was gone (pid reuse), did not validate pids (`1`, `-1`), and trusted tickets from other hosts. Signals now go only to
  process groups, only for valid pids, only when host and recorded start time match.
- **Medium** - computing the cache key ran `git diff`, which applies repository-defined clean filters. Contents are now
  hashed by szq itself; git only lists files.
- **Medium** - changes inside submodules were invisible to the cache key. Submodules are fingerprinted recursively.
- **Medium** - a result was stored under the key computed *before* the run even if the tree changed meanwhile. The key is
  recomputed afterwards and the result is not cached on a mismatch.
- **Low** - hook never answered "allow" in the adapter's own dialect on internal errors (Cursor treats an empty answer as
  a block); GUI agents default to an absolute `node` path.
- **Low** - quadratic-time heredoc parsing in the guard (seconds for a 40 KB input); replaced by a linear scanner with an
  input cap. False positives fixed (`jest -w 2`, hyphenated heredoc delimiters, comments, line continuations,
  `--version`/`--help`).
- **Low** - the installer replaced a symlinked config file by a regular file; `config set` overwrote a broken config
  without backup; hook/shim commands were not safely quoted for paths with `$()`/backticks; the cache key could be
  forged through file-name/content boundary ambiguity; shims could overwrite foreign files and `uninstall` could delete
  any file containing the marker text; `node_modules/.bin` was prepended to `PATH` for every command; stale-mutex
  breaking and sleeping laptops could exceed the concurrency cap; malformed tickets could crash waiting runs.

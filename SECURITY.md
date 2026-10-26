# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting
(*Security → Report a vulnerability* on https://github.com/kimyejoon/szq) and include the version
(`szq --version`), your platform, and the smallest input that reproduces the problem. You will get an
acknowledgement within a few days; this is a small volunteer project, so please be patient and give a
reasonable time to fix before disclosing.

Supported versions: the latest released minor version.

## What szq is, security-wise

szq runs **commands you (or your agent) give it, with your privileges**, and stores their output on disk.
It is not a sandbox, it does not authenticate anything and it does not isolate runs from each other.
Its security goal is narrower: *running szq must not make anything worse than running the command
directly would have*, and it must not let one local user or one repository interfere with another.

### Threat model and mitigations

| Threat | Mitigation |
|---|---|
| Another local user reads or poisons the cache / hijacks the queue | State directory is `0700`; on POSIX szq refuses a directory it does not own or that is group/world-writable; cache and ticket files are `0600`; nothing is placed in a shared `/tmp` path by default. |
| A hostile repository makes `szq` run code just by computing the cache key | git is invoked with `core.fsmonitor=false`, `--no-ext-diff --no-textconv`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`; untracked files are read only if they are regular files (symlinks are hashed by target, FIFOs/devices are never opened; size and count caps apply). Tests cover textconv/external-diff helpers, FIFOs and symlinks. |
| Argument injection through szq | No shell on POSIX - the argument vector goes to `spawn` unchanged. On Windows `.exe` is spawned directly; `.cmd`/`.bat` shims go through `cmd.exe` and any argument containing `"` or `%` is **rejected**; other metacharacters are quoted. |
| A prompt-injected agent abuses szq flags/config | `szq config set` rejects `__proto__`/`constructor`/`prototype` keys; config values are type-checked and allow-listed (`guard.commands` entries must match `[\w.@:+-]{1,64}`); adapters load only from an explicit `--adapter-module` path, never from the environment or a search path. |
| Hook installer corrupts or hijacks agent settings | Refuses files that are not valid JSON objects; atomic write; timestamped backup; only entries it generated are edited or removed. |
| Hook breaks the agent | The guard is fail-open (any error, unknown adapter, or unparsable input = allow), does no I/O except reading its config and one stdin event, and has no network access. |
| Killing an unrelated process | Orphan reaping kills only a process group/tree recorded in a ticket whose owner is dead, and ticket ownership is established by file creation inside the private state directory. |
| Stale or wrong cached results | Documented key (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)); failures are cached only briefly; `--no-cache` and `cache.env` exist for inputs git cannot see. |

### Known limitations (by design - please read)

- **Cached output is stored in plain text** in the state directory (owner-only permissions). Commands that
  print secrets (environment dumps, `--verbose` test output containing tokens) should not go through the
  cache: use `--no-cache` or `cache.enabled: false`. Clear it with `szq cache clear`.
- **Ignored files are not part of the cache key.** A change to `node_modules`, a generated `dist/`, `.env`
  files or anything git ignores does not invalidate a cached result.
- **Replaying output replays terminal escape sequences** exactly as the command printed them.
- **The guard is a seatbelt, not a boundary.** It parses shell syntax heuristically; `eval`, base64, a script
  that runs `tsc`, or a nested shell can evade it. Do not rely on it to prevent an adversary from running
  something.
- **Hooks run arbitrary code with your privileges** - that is how every agent hook works. `szq hook install`
  only writes the command `node "<path>/bin/szq.js" guard <adapter>`; make sure that path is a location only
  you can write to (do not install from a world-writable directory).
- **Windows** support has not been verified on real hardware by the author.
- Anyone who can write to your state directory or your home directory can already do far more than szq lets
  them; szq does not defend against a compromised user account.

## Disclosure of fixes

Security fixes are described in `CHANGELOG.md` under a *Security* heading once a fixed version is available.

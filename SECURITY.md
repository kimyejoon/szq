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

### Review history

Before the first release the code went through two independent, adversarial reviews (read-only, with experiments in
temporary directories). The first found 16 issues (five medium, none high); the second verified those fixes (five held,
two only partly) and found ten more (four medium, e.g. a slot leak after an internal error, a quadratic-time pattern in
the digest, a cache key that ignored HEAD for `--changed`). All of them were reproduced and fixed before release, each
with a regression test. See [CHANGELOG.md](CHANGELOG.md). That is a strong signal, not a
guarantee: please report what we missed.

### Threat model and mitigations

| Threat | Mitigation |
|---|---|
| Another local user reads or poisons the cache / hijacks the queue | State directory is `0700`; on POSIX szq refuses a directory it does not own, that is a symlink, or that is group/world-writable; cache, ticket, log and statistics files are `0600`; nothing lives in a shared `/tmp` path by default. |
| A hostile repository runs code just by `szq` computing the cache key | szq asks git only to **list** files (`ls-files`) and hashes contents itself. It never asks git to compare/diff content, so `filter.*.clean/smudge`, `diff.*.textconv` and `diff.external` defined in the repository's config cannot run. `core.fsmonitor` is disabled, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`. Symlinks are hashed by target, FIFOs/sockets/devices are never opened, size and file-count caps apply. Tests cover filters, textconv, external diff, FIFOs, symlinks and submodules. |
| Argument injection through szq | No shell on POSIX - the argument vector goes to `spawn` unchanged. On Windows `.exe` is spawned directly; `.cmd`/`.bat` shims go through `cmd.exe` and any argument containing `"`, `%` or a newline is **rejected**; other metacharacters are quoted. |
| A planted binary shadows a trusted one | Only the *command word* is looked up in the project's `node_modules/.bin` (that is what running a project's own tools means), never for interpreters, shells, `git` and package managers (`node`, `bash`, `git`, `npm`, `pnpm`, ...); `PATH` is not modified, so tools the command starts itself are unaffected. |
| A prompt-injected agent abuses szq flags/config | `szq config set` rejects `__proto__`/`constructor`/`prototype` keys before touching anything and refuses to modify an invalid config file; config values are type-checked and allow-listed; `guard.commands` entries must match `[\w.@:+-]{1,64}`; adapters load only from an explicit **absolute** `--adapter-module` path (relative paths are rejected - a repository could plant the file), never from the environment or a search path. |
| Hook installer corrupts or hijacks agent settings | Refuses files that are not valid JSON objects; atomic write that follows symlinked config files (dotfile managers) instead of replacing them - but for `--project`/`--local` only symlinks that stay inside the project are followed (a repository cannot redirect an install or uninstall to a file outside it); timestamped backup; only entries it generated are edited or removed. Hook commands are single-quoted on POSIX; on Windows paths containing shell metacharacters are refused. |
| Hook breaks the agent | The guard is fail-open (any error, unknown adapter or unparsable input = allow, in the adapter's own dialect once it is known), does no I/O except reading its config and one stdin event, has no network access, and classifies in linear time over at most 64 KiB. Copilot's commands always end in `exit 0` because it treats other exit codes as a deny. |
| Killing an unrelated process | Orphan reaping signals only the **process group** of a child recorded in a dead owner's ticket, only if the host matches and the child's recorded start time still matches the live process (re-checked before SIGKILL). Pids 0, 1, negative and non-integers are never signalled and szq never falls back to signalling a bare pid. Windows never reaps by recorded pid. |
| Queue tampering / garbage tickets | Tickets are validated (types, pid range); malformed ones are ignored and cleaned up; a stale mutex is broken by an atomic rename. |
| Stale or wrong cached results | Documented key ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) with unambiguous field encoding, content-based and covering submodules; results are not cached when the tree changed during the run; failures are cached only briefly; `--no-cache`, `cache.env` and `cache.extraFiles` exist for inputs git cannot see. |

### Known limitations (by design - please read)

- **Cached output and logs are stored in plain text** in the state directory (owner-only permissions), including any
  terminal escape sequences, and replayed verbatim. Commands that print secrets (environment dumps, verbose test output
  containing tokens) should not go through the cache or the log: use `--no-cache`, `cache.enabled: false` and
  `logs.keep: 1`, and clear with `szq cache clear`. Only the command *name* is stored in cache entries and the "last run" records keep neither the command line nor
  environment values (hashes only), but a ticket in the queue directory holds the full command line while it runs.
- **Ignored files are not part of the cache key.** A change to `node_modules`, a generated `dist/`, `.env` files or
  anything git ignores does not invalidate a cached result (see `cache.extraFiles`). Two clones with the same tracked
  content share results.
- **A file changed and reverted while a command runs** cannot be detected; the result may reflect the transient state.
  (A change that persists is detected and the result is not cached.)
- **File timestamps.** Unchanged-file detection uses size + mtime + ctime and ignores entries younger than 2 s, like
  git; on a file system with very coarse or manipulated timestamps a same-size rewrite could in theory be missed.
- **Running a project's tools executes project code.** `szq tsc` in an untrusted repository runs that repository's
  `node_modules/.bin/tsc`, exactly as `npx tsc` or `pnpm exec tsc` would. szq does not make that safer or less safe.
- **The guard is a seatbelt, not a boundary.** It parses shell syntax heuristically; `eval`, base64, a script that runs
  `tsc`, or a nested shell can evade it. Do not rely on it to stop an adversary from running something.
- **Hooks run arbitrary code with your privileges** - that is how every agent hook works. `szq hook install` writes the
  command `node '<path>/bin/szq.js' guard <adapter>`; make sure that path is somewhere only you can write (do not
  install from a world-writable directory).
- **Windows** support has not been verified on real hardware by the author; orphan reaping and memory limits are not
  available there.
- Anyone who can write to your state directory or your home directory can already do far more than szq lets them; szq
  does not defend against a compromised user account.

## Disclosure of fixes

Security fixes are described in `CHANGELOG.md` under a *Security* heading once a fixed version is available.

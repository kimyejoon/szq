# Performance

For a direct comparison against the tman 0.7.10 release binary, including real TypeScript checks and all raw samples,
see [bench/TMAN.md](../bench/TMAN.md). The measurements below are the earlier szq-versus-unsupervised baseline.

What szq costs per call, what was optimised and how it was measured. All numbers: Apple M1 Pro (8 cores, 16 GiB),
Node 22, macOS, **on a laptop that other work kept busy** (background CPU 21-65%, load average 7-25 during the
runs). They show orders of magnitude and the effect of changes, not what your machine will do. Reproduce with
`npm run bench` (see [bench/RESULTS.md](../bench/RESULTS.md) for the last raw run).

## What a call costs

Profile of a cache hit before the optimisations (a small and a 2,400-file repository, warm stat cache):

| Step | Cost |
|---|---|
| Node start-up | ~40 ms |
| `git rev-parse --show-toplevel` | one process, ~20-45 ms |
| `git ls-files -s` + `git ls-files -o` | two processes, ~45 ms each |
| Hashing files (stat-cache hits) | 1-5 ms |
| State directory, cache read, queue, stats | < 1 ms each |

So **a call was dominated by starting `git` three times**; everything szq does itself is noise by comparison.

## What was optimised

| Change | Effect |
|---|---|
| Repository root found by walking up to `.git` (no process) | -1 git process |
| One `git ls-files -t -s -o --exclude-standard -z` instead of two (`-t` tags each line, so file names cannot pose as the other kind) | -1 git process |
| No second fingerprint for an immediate execution with no intervening cache result; queued results are revalidated | -1 fingerprint for the uncontended execution path |
| Waiters are woken by file-system events (`fs.watch` on the queue and cache directories) instead of waiting out a 1 s poll; followers poll every 250 ms | up to 1 s less latency when a slot frees |
| Idle-aware concurrency: in `auto` mode one or more runs beyond the base are admitted while recent CPU utilisation is below `headroom.cpuBelow` | distinct commands finish sooner on a machine with headroom |
| Liveness of other runs: a live pid with a fresh heartbeat needs no `ps`; start-time checks only for quiet tickets | no more `ps` storm with many waiters |
| Lazy loading: a command loads only the modules it needs | -4 ms per guard-hook call |
| Housekeeping (cache pruning, old "last run" records) on ~1 call in 16 | less I/O on the hot path |

## Results

Eight simultaneous "agents", each job ~2 s of single-core CPU; `tsc` runs on a generated 400-file project.

| | before | after |
|---|---|---|
| cache hit (repeat call, unchanged code) | 0.12-0.15 s | **0.06-0.07 s** |
| 8 agents, same command: wall time | 3.5 s | **2.2 s** (stampede without szq: 2.7-3.0 s) |
| 8 agents, same command: executions / CPU work | 1 / 2 CPU-s (vs 8 / 18 CPU-s) | same |
| 8 agents, real `tsc --noEmit`: wall time | 3.7 s | **2.9-3.2 s** (without szq: 8.3-9.6 s) |
| 8 agents, 8 different commands: wall time, light background load | 11.2 s (2 at a time) | **8.5-8.7 s** (3 at a time) |
| 8 agents, 8 different commands: wall time, heavy background load | - | 16.8-17.3 s (throttled to 1 at a time) |
| guard hook (runs before every shell command) | ~41 ms | ~37 ms (Node start-up is ~30 ms of it) |

### Reading the "different commands" rows

A stampede finishes 8 distinct jobs fastest on an idle machine (2.7 s) - and makes everything else on the machine
crawl. szq trades that throughput for responsiveness: it starts a few runs, **grows the number only while there is CPU
headroom**, and drops to one run at a time when the machine is busy for other reasons (load average above
`adaptive.loadPerCpu` x CPUs). On this laptop, other sessions kept the CPU busy, so the headroom rule rarely had room
to grow and the heavy-load run was throttled to 1. On a quiet machine more runs overlap; with `concurrency` pinned you
get exactly that many. If you prefer speed over politeness, raise `concurrency` and `headroom.cpuBelow`.

### Known remaining cost

- Fingerprinting a repository for the first time (cold stat cache) reads every file once: ~2 s for 2,400 files here.
  Afterwards only changed files are re-read.
- A cache hit still needs one `git ls-files` (about 20-45 ms); that is the floor without walking the tree and
  re-implementing `.gitignore` ourselves.
- One measurement showed `tsc` executing twice instead of once for eight identical requests. Cause (found by logging
  the claim decisions under load): a ticket's id was drawn before its file was written, and under load that gap grew to
  tens of milliseconds, so a "younger" ticket could start before the "older" one even became visible - and the older one,
  seeing nobody ahead of it, started a duplicate. Fixed: an already running ticket with the same key now wins whatever
  the arrival order, and the id is drawn right before the write. A stress test (8 identical requests x 5 rounds) and
  50 loaded repetitions show no duplicate afterwards (before the fix: 1-3 duplicates per 10 rounds under the same load).

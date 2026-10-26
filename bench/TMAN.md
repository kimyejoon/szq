# Direct comparison with tman 0.7.10

This compares the time until **every caller has received the correct successful result**. It is a comparison of
fixed-concurrency execution and result reuse on one macOS machine, not a claim about every platform or supervision
feature. Raw samples, tool versions, the source hash and the binary hash are in [tman-results.json](tman-results.json).

## Method

- Official [tman 0.7.10 macOS arm64 release](https://github.com/standardbeagle/tman/releases/tag/v0.7.10).
  Downloaded archive SHA-256: `211729eb17da537dcde132fa0c30681477eb78a1e9da2eb54626dbad014a46ad`;
  extracted binary SHA-256: `9cf0c3aab68c232b91fe5dd9b87caac22e1f86d4470cb2d7af16be8a60ca5514`.
- Apple M1 Pro, 8 cores, macOS arm64; Node 20.11.0; TypeScript 5.9.3.
- Eight callers; concurrency **2 for both tools**. szq uses `concurrency: 2`, `adaptive.enabled: false` and
  `output.digest: never`; tman uses `run --no-queue --max-parallel 2`. Thus measured-cost named-queue admission and
  szq's adaptive/headroom policies are outside this comparison. No CPU or memory limits are enabled.
- Three samples per tool/scenario; tool order alternates each round. Each sample gets a fresh git repository and
  isolated state/config directories. `.tman/` logs are ignored as outputs. Global settings are not modified.
- Distinct CPU jobs perform the same fixed number of iterations, calibrated once to about **2 CPU seconds** per job.
  TypeScript checks use the same generated 400-file project with `--noEmit`, with no incremental rewriting.
- The warm scenario first runs once outside the timer, then times eight sequential calls on unchanged code. The
  initial execution cost is excluded for **both** tools. Concurrent TypeScript samples start with empty caches.
- Every invocation must exit 0 and contain its expected output; execution markers must match the expected count,
  and measured child overlap must stay within the cap. A rejected duplicate is not counted as a completed result.
  `--name` is not used with tman: its name lock refuses a duplicate rather than returning the result to that caller.
- The benchmark aborts if szq source changes during measurement. It clears the outer `SZQ_ACTIVE` marker only in its
  isolated children, so invoking the harness through a verification queue does not bypass the tool under test.
- Other work remained active on the laptop. Per-sample load averages and all timings are retained; the results
  describe this machine, these versions and these inputs. Longer unique jobs approach the same CPU-work lower bound.

## Results

Three-run medians; ranges in parentheses are the minimum–maximum observed wall times.

| Scenario | tman wall time | szq wall time | tman / szq | executions (tman / szq) |
|---|---:|---:|---:|---:|
| 8 distinct CPU jobs (~2 CPU-s each) | 13.087 s (13.069–14.060) | 9.204 s (8.987–9.681) | **1.42×** | 8 / 8 |
| 8 concurrent identical TypeScript checks | 22.322 s (21.136–40.943) | 4.457 s (4.071–4.686) | **5.01×** | 8 / 1 |
| 8 sequential TypeScript checks, warm result cache | 30.226 s (30.214–32.238) | 0.591 s (0.590–0.638) | **51.11×** | 8 / 0 |

Measured 2026-10-26T11:17:48.204Z; all 144 timed invocations returned their expected successful result. The six warm-up invocations also passed.

Source SHA-256: `6f3c0cf48fb2df601869fd50f9c2a33e85f48758d4bf31cb68d168eff89da3ff`.

Observed 1-minute system load at sample starts ranged from 8.1 to 36.5. The wide tman TypeScript range shows the background-load noise; the raw samples retain it.

## Interpreting the result

The biggest advantage comes from avoiding repeated work: all eight concurrent callers receive one TypeScript run's
result, and warm repeated calls need no compiler execution. Distinct jobs still perform all eight jobs' CPU work;
with a two-job cap, 16 CPU seconds have an approximately 8-second wall-time lower bound before overhead/contention.

Short-job latency also depends on supervision cadence. This tman release uses a 1-second monitor tick in
[Runner.cs](https://github.com/standardbeagle/tman/blob/v0.7.10/Runner.cs) and a 1-second slot retry in
[Admission.cs](https://github.com/standardbeagle/tman/blob/v0.7.10/Admission.cs). szq observes child exit directly and
wakes queue waiters on filesystem events. This is a version-specific observation, not a prediction about future tman.

## Reproduce

Use an existing tman release binary and TypeScript compiler. No build is required:

```sh
szq node bench/compare-tman.js \
  --tman /absolute/path/to/tman \
  --tsc /absolute/path/to/typescript/bin/tsc \
  --rounds 3 --agents 8 --cap 2 --cpu-ms 2000 \
  --only distinct-concurrent,same-tsc,warm-tsc \
  --out /tmp/szq-tman-results.json
```

Omit `--only` to also measure empty-command startup, identical CPU jobs and warm CPU-job repeats. The benchmark
prints each sample and a final median table. A failed validation aborts instead of publishing a speedup for that
scenario. The JSON is written incrementally, so a partial run has fewer samples and an incomplete summary.

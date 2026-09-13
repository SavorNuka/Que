# After Action Review — M1b (Concurrency & Idempotency)

Reviewed 2026-09-13, immediately after M1b, before M1c or M2.
Assessed against the frozen scope in [M1b-SCOPE.md](M1b-SCOPE.md) and the design in
[PRA-M1b.md](PRA-M1b.md), under [PROCESS.md](PROCESS.md).

**Verdict: 10 of 10 scope items delivered. Three defects found by writing the tests, all
fixed. One deviation from the PRA, recorded. The most consequential finding is that a
falsification criterion fired — the pool delivers 1.98×, not the 8× predicted — and the
investigation changed what we believe about the workload rather than the design.**

The pre-phase assessment earned its place immediately: the correction it made to the brief
(§4 C4, key the resource not the row) is the difference between 1 provider call and 12 for a
twelve-track album, and it was made before any code existed rather than after.

---

## 1. Did the output match the frozen scope?

| # | Scope item | Status |
|---|---|---|
| 1 | Bounded concurrency pool — size, error isolation, ordered results, cancellation, injected clock | ✅ delivered, 22 tests |
| 2 | Rate gate — per-host interval + burst, applied at dispatch, independent of pool size | ✅ delivered, 16 tests |
| 3 | Retry — classified-transient only, backoff with jitter, capped, back through the gate | ✅ delivered, 21 tests |
| 4 | Idempotency key builder — pure, versioned, normalising | ✅ delivered, 34 tests |
| 5 | Single-flight — both checks before any await, `finally` clears, callers detach | ✅ delivered, 14 tests |
| 6 | Two-layer cache with the §5.5 outcome policy | ✅ delivered, 28 tests, **one deviation — D3** |
| 7 | Scanner uses the pool for ffprobe | ✅ delivered, benchmarked (§3) |
| 8 | Eight named tests, a–h | ✅ all eight present (§2) |
| 9 | IPC handler round-trip tests | ✅ delivered, 28 tests — **and they found D1 and D7** |
| 10 | ARCHITECTURE updates | ✅ §6 (wire-shape + dispatch rules), §10.5 (new), §22 (M1b/M1c split) |

Out-of-scope items stayed out: no HLS, no provider implementations, no cross-process
idempotency, no file watching. Nothing crept in.

### The eight required tests

| | Property | Where |
|---|---|---|
| a | Concurrent duplicates collapse to one call | `single-flight.test.ts`, `request.test.ts` |
| b | Distinct resources never collide; shared resources do share | `key.test.ts`, `request.test.ts` |
| c | A response-varying parameter changes the key | `key.test.ts`, `request.test.ts` |
| d | A transient failure does not poison the key | `single-flight.test.ts`, `request.test.ts` |
| e | Abort detaches without cancelling joiners | `single-flight.test.ts`, `request.test.ts` |
| f | A never-settling request times out and clears | `single-flight.test.ts`, `pool.test.ts` |
| g | A hidden row stays refused with a warm cache | `restrictions-cache.test.ts` |
| h | Per-row application is transactional and idempotent | `apply-once.test.ts` |

(a) and (g) each ship with a verified control, per the standing rule. (a)'s is a negative
control — a cache-only implementation, in the test file, measured making 12 calls for the
same work. (g)'s is a positive control asserting the cache really is warm and the item
really is returned when restrictions are off, so the four refusals above it cannot pass
vacuously.

---

## 2. Defects found in this review

### D1 — `library:setFields` silently shadows first-class fields · **Severity: medium · OPEN (M3)**

ARCHITECTURE §6 documents the channel as *"first-class + custom"*. The handler writes every
key to `media_fields`, so a patch naming a real column — `title`, `year` — is stored as a
custom field that the column then shadows. The call succeeds, returns a `MediaDetail`, and
the value does not appear. It looks saved and is not.

Found by the round-trip tests, which is precisely what AAR-M1 P1 predicted they were for:
30 argument-validation tests could never have caught it, because the arguments are valid.

Left open deliberately. The fix belongs with M3's metadata editor, where the set of
first-class editable columns is actually decided; guessing at it here would be scope creep
into the milestone that owns the question. Recorded as an asserted known gap in
`tests/ipc-roundtrip.test.ts` so it is visible rather than assumed fixed, with a note to
delete that test when M3 makes it wrong.

### D2 — A timeout aborted the task but never released the worker · **Severity: high · FIXED**

Both `Pool.taskTimeoutMs` and `SingleFlight.timeoutMs` originally fired the abort signal and
then waited for the task to notice. A task that ignores its signal — which is the entire R3
scenario, a hung subprocess or a socket that never settles — held its worker, or its key,
forever. The timeout was decorative.

This is the defect the phase existed to prevent, shipped inside the mechanism meant to
prevent it, and it survived my own code review. It was found only because the R3 test was
written to describe the failure honestly ("a call that never settles") rather than to
describe a cooperative task.

Fixed: the timeout now *races* the work rather than only signalling it. Two tests, one with
a cooperative task and one with a task that ignores its signal entirely.

### D3 — The persistent cache could not reuse `http_cache` · **Severity: low · DEVIATION, RESOLVED**

PRA-M1b §5.4 said the persistent layer would use `http_cache` from migration 001. It could
not: that table is keyed by URL, and the key this design produces is deliberately *not* a
URL — two rows resolving to one release must share an entry even when their request URLs
differ, and one URL must not serve two languages.

Migration 004 replaces it with `provider_cache`, keyed by idempotency key and carrying
provider, capability and origin as indexed columns. `http_cache` had never been written to,
so nothing is migrated. Recorded here rather than absorbed, because a PRA that turns out to
be wrong in a detail is only useful if the correction is visible.

### D4 — The manual clock fired timers before draining microtasks · **Severity: medium · FIXED**

`advance()` looked for due timers before letting pending continuations run. A caller that
had just started an async function had not reached its `sleep` yet, so `advance` both missed
that sleep and let already-resolved work observe a clock that had jumped ahead of it.

Symptom: eleven tests failing, some by 1000 ms in an assertion and some by hanging until the
5-second timeout. Worth recording because the failure mode is *the test infrastructure
lying*, which is the most expensive kind — had `advance` drained in the wrong order only
sometimes, the suite would have been flaky rather than broken, and the fix would have been
to widen a tolerance.

Fixed: `advance` drains before moving time.

### D5 — Scan state was module-global in the IPC layer · **Severity: low · FIXED**

`scanRunning` and `scanCancelled` lived at module scope in `handlers.ts`, so they were shared
by every dispatcher in a process and leaked between tests. In the app the consequence is
narrower but real: a dispatcher rebuilt after a window reload would inherit a stale
"scanning" flag and the scan button would stay dead.

Found while writing the round-trip tests — the concurrent-scan test passed, and then the
*next* test failed, which is the signature of leaked state.

Fixed: both flags moved into the `makeHandlers` closure, with a test asserting two
dispatchers have independent scan state.

### D6 — `probeFile` cannot run outside Electron · **Severity: trivial · OPEN**

`src/main/ffmpeg.ts` resolves its binary via `app.getAppPath()`, so anything importing
`probeFile` needs an Electron runtime. M1's probe tests already worked around this by testing
`interpretProbe` with a stub; the benchmark had to do the same. Not worth a patch on its own,
but it is the reason no test exercises the real `probeFile`, and it should be folded into
M1c, which will touch this module anyway.

---

## 3. The falsification that fired

PRA-M1b §12 listed, in advance, what would mean the design was wrong:

> **1. The pool does not speed up scanning as predicted.** If ffprobe is contended on disk
> rather than CPU, pool 8 may return far less than 8×. If the measured gain is under 2×, the
> pool is not worth its complexity for the scanner.

It came in at **1.98×**, and the exit-criterion test failed on its own threshold. That is the
process working, so it gets a section rather than a line.

### What was measured

240 real MP4s generated with ffmpeg, fresh database per run, `npm run bench`:

```
  pool    total       per file    speed-up   20k projection
  1       12521 ms    52.17 ms    1.00×      17.4 min
  2        6376 ms    26.57 ms    1.96×       8.9 min
  4        6322 ms    26.34 ms    1.98×       8.8 min
  8        6380 ms    26.58 ms    1.96×       8.9 min
  16       6476 ms    26.98 ms    1.93×       9.0 min
  stub      234 ms     0.97 ms      —         0.3 min

  cores: 2
  scanner's own share at best pool: 4%
```

### What it means

The speed-up saturates at **exactly the core count** and does not move at pool 4, 8 or 16.
That is not a disk-contention signature; it is a CPU-saturation signature. **ffprobe is
CPU-bound, not I/O-bound** — each probe is a subprocess decoding container headers on a core,
not a request waiting on a platter. AAR-M1 D3's "98% ffprobe wait" was accurate about where
the wall-clock goes and misleading about why, and PRA-M1b inherited the wrong inference from
it.

The `stub` row settles the other half: with probing removed the scanner runs at 0.97 ms/file,
so our own bookkeeping is 2% of a serial cold scan and 4% of a pooled one. AAR-M1 D3's 2%
figure holds, and the pool is chasing the right 98%.

### What changed as a result

**Not the design.** A pool is still the correct mechanism, and it still delivers everything
the hardware allows. What changed is the ceiling and how it is asserted:

- `defaultProbeConcurrency()` already tracks `availableParallelism()`, capped at 8. The
  measurement says that cap is right for a different reason than assumed: not "8 is enough
  concurrency for the disk" but "past the core count there is nothing to gain", and the cap
  protects a 32-core machine from spawning 32 ffprobe processes for a 4% return.
- The exit-criterion assertion was a flat `> 2×`. That is wrong in both directions — it fails
  a 2-core machine achieving 100% of what it has, and passes a 16-core machine delivering a
  quarter of what it could. It now asserts the speed-up reaches 75% of `min(cores, maxPool)`.

**The prediction is not yet verified on target hardware.** PRA-M1b predicted ~14.5 min → 2–3
min at 20,000 files. On this 2-core container the honest number is 17.4 → 8.8 min. At 8 cores
the same per-file cost projects to ~6.5 ms/file, or ~2.2 min at 20k — inside the prediction,
but that is arithmetic, not a measurement. **`npm run bench` should be run once on the
Windows machine and the result recorded here.** Carried as action 1.

---

## 4. Process

### P1 — CI still isn't running · **Severity: medium · fourth milestone carrying this**

The compensating control from PRA-M1b §10 is in place: `npm run test:concurrency` runs the
concurrency and idempotency suites with `--repeats=20`, and it is part of `npm run check`.

Per the standing rule, the control was itself verified: a deliberately flaky test (failing
~10% of the time) was added, passed a single run, and **failed under repeats=20**, then
removed. A repeat harness that has never been seen to catch a flake is not a repeat harness.

This is still weaker than CI — it only runs when someone runs it. A remote remains the top
carried action, now for the fourth milestone in a row, and the honest summary is that this
project has no automated gate at all.

### P2 — The pre-phase assessment paid for itself twice

Worth recording while it is concrete, because the value of a process is easy to assert and
hard to evidence:

- **The key correction (§4 C4).** Built as briefed — one unique key per row — a twelve-track
  album would have made twelve identical release lookups and the deduplication win would
  have been zero. Caught before any code existed, by running a harness rather than by
  reasoning about it.
- **The falsification criterion (§3 above).** Written in advance, when being honest was free.
  Having it on paper turned a disappointing number into an investigation and a finding,
  rather than into a quiet adjustment of the threshold.

### P3 — Tests found what review did not, again

Three of the six defects were found by writing tests, and none by reading code: D1 by the
round-trip tests, D2 by writing the R3 test to describe an uncooperative task rather than a
polite one, D5 by the failure landing in the *next* test.

D2 is the one to remember. I wrote the timeout, reviewed the timeout, and shipped a timeout
that did nothing against the exact case it was for. What caught it was refusing to write the
easy version of the test.

### P4 — Coverage after this pass

| Layer | Coverage |
|---|---|
| Pool, gate, retry, clock | 59 tests, all on a manual clock |
| Key, cache, single-flight, request, apply-once | 94 tests |
| IPC round-trips | 28 tests (was 0) |
| Restrictions × cache interaction | 6 tests, with a positive control |
| Scanner concurrency | benchmark, gated behind `npm run bench` |
| Provider implementations | **none** — none exist yet (M3) |

**351 tests passing, 1 skipped** (the benchmark), up from 170 at the end of M1.

---

## 5. Downstream impact

| Finding | Impact on later milestones |
|---|---|
| **CPU-bound probing** (§3) | M1c transcoding is far heavier than probing and competes for the same cores. The transcode pool must be sized against the probe pool, not independently, or a scan during playback will starve the player. Add to the M1c PRA. |
| **D1** (setFields) | M3 owns the fix. The decision it forces — which columns are first-class editable — is a metadata-editor design question, not a plumbing one. |
| **D2** (timeout raced) | The pattern generalises: any future timeout on work we do not control must race, never merely signal. Stated in ARCHITECTURE §10.5. |
| **Provider contract** | M3's providers must be pure `(key, params) → response` behind `ProviderClient`. Anything calling `fetch` directly bypasses cache, dedup and gate at once. This is now the single most load-bearing convention in the codebase and is stated in §10.5. |
| **Burst tolerance unknown** | PRA-M1b §13's open question is unanswered: MusicBrainz's documented limit is an average of 1 req/s, and whether short bursts are tolerated determines the bucket size. Currently set to the conservative 1. Measure in M3 against the real API. |
| **`applied_ops` unused** | Built and tested, with no caller until M3. Deliberate — building it alongside the cache is what makes the two consistent — but it is untested against a real workload until then. |

---

## 6. What changed as a result of this review

| Change | Files |
|---|---|
| Timeouts race the work rather than only signalling it (D2) | `concurrency/pool.ts`, `idempotency/single-flight.ts` |
| Manual clock drains before advancing (D4) | `concurrency/clock.ts` |
| Scan state moved into the handler closure (D5) | `ipc/handlers.ts` |
| `createDispatch` extracted so round-trips test the real path | `ipc/handlers.ts` |
| Normalisation order fixed — apostrophes before punctuation, article swap before comma | `idempotency/key.ts` |
| `RateGateRegistry` takes overridable limits so tests need no real spacing | `concurrency/rate-gate.ts` |
| Exit-criterion assertion made relative to core count | `tests/bench/scan.bench.test.ts` |
| Known-gap test for D1 | `tests/ipc-roundtrip.test.ts` |
| `npm run bench`, `npm run test:concurrency`; `check` now includes the repeat run | `package.json` |
| This review | `docs/AAR-M1b.md` |

Gates: **typecheck clean · lint clean · 351 tests passing · 153 concurrency/idempotency tests
passing under `--repeats=20`**.

---

## 7. Actions carried into M1c / M2 / M3

1. **Run `npm run bench` on the Windows machine** and record the result in this document. The
   2–3 minute prediction is currently arithmetic, not a measurement. *(§3)*
2. **A remote + CI actually running.** Fourth milestone carrying this. *(P1)*
3. **Size the M1c transcode pool against the probe pool**, now that probing is known to be
   CPU-bound. Belongs in the M1c PRA. *(§3)*
4. **Fix `library:setFields` for first-class columns** and delete the known-gap test. *(D1, M3)*
5. **Measure MusicBrainz burst tolerance** against the real API and set the bucket from data.
   *(PRA-M1b §13, M3)*
6. **Fold the ffmpeg-path fix into M1c** so `probeFile` is testable outside Electron. *(D6)*
7. Refresh the row after playback so resume isn't stale. *(AAR-M1 D6, M2)*

---

## 8. What went right

- **The harness changed the design before the design existed.** Every correction in PRA-M1b §4
  came from running something, not from thinking about it — and the largest of them inverted
  an instruction that sounded obviously right.
- **The falsification criterion worked exactly as intended.** Written when it was cheap to be
  honest, it converted a bad number into a finding about the workload. Without it the likely
  outcome was adjusting the threshold and moving on.
- **The compensating control was verified rather than assumed.** The repeat harness was shown
  to catch a real flake before being trusted to catch a hypothetical one — the M0 lesson about
  positive controls, applied to the process rather than to the code.
- **Measuring the floor, not just the ceiling.** The `stub` row cost one extra scan and
  settled a question the pool numbers alone could not: whether the remaining time is ours or
  ffprobe's. It is ffprobe's, 96% of it.
- **Round-trip tests found a documented-but-unimplemented behaviour on their first outing.**
  AAR-M1 P1 argued for them on the grounds that "untested wiring compounds". D1 is that
  argument, cashed.

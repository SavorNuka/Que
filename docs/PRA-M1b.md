# Pre-phase Risk & Integration Assessment — M1b (Concurrency & Idempotency)

Written 2026-09-13, after `7b0378b` and the AAR-M1 remediation, before any M1b code exists.
First assessment under [PROCESS.md](PROCESS.md). Assessed plan-wide, not only for M1b.

**Headline finding — the brief needs one correction before it is built.**
The directive says each row must get its own unique idempotency key. Keyed on the *database row*,
that is measurably the wrong design: twelve tracks from one album would make twelve identical
network calls and the deduplication win disappears entirely. Keyed on the *resource being
fetched*, grounded in origin identity, twelve tracks make one call and all twelve rows get the
right answer. The harness shows both failure modes as numbers in §3. Everything else in the
brief — the cache, the in-flight map, clearing the race between them — is correct and is what
§5 builds.

**Second finding.** M1b as planned carries two unrelated workstreams. §7 recommends splitting
HLS out to M1c.

---

## 1. Inputs

| Source | Items carried in |
|---|---|
| [AAR-M1](AAR-M1.md) | **D3** no concurrency anywhere (open, owned by this phase) · **P1** IPC round-trip tests unmet · **P2** CI still not running · **D6** stale resume (M2) · **D1** wire-shape rule to be stated in ARCHITECTURE |
| [AAR-M0](AAR-M0.md) | **P2** CI armed but not triggered · **P3** gates · the negative-control rule |
| [ARCHITECTURE.md](ARCHITECTURE.md) | §7 provider chains · §8 `http_cache` · §13 metadata retrieval · §22 milestones M1b–M11 · §23 restrictions |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) | A2 (HTTP/Range over custom protocol) · §G corrections |
| User directive, this session | Concurrent design · per-row idempotency keys grounded with the origin key · cache checked before execution · in-flight tracking so a second caller waits rather than racing |

**Architecture sections this phase modifies:** §7 (a rate gate becomes part of the provider
contract), §8 (`http_cache` gains a key schema and TTL policy), §22 (M1b/M1c split).
**Sections it must not disturb:** §23 — restriction enforcement stays in the query layer.

---

## 2. What changed since the plan was written

The plan assumed a provider layer that fetches when asked. Three things now say otherwise.

1. **Scanning is I/O-bound and serial.** Measured in AAR-M1: 43.5 ms/file of ffprobe, 98 % of a
   cold scan, ~14.5 min at 20,000 files. Our own code is the other 2 %.
2. **The cheapest metadata provider is the most rate-limited.** MusicBrainz allows an average of
   one request per second per IP. Key-free defaults were chosen deliberately (§7); the cost of
   that choice lands here.
3. **There is no server we control.** This is the largest correction to the brief — see §4, C1.

---

## 3. Measured facts

Produced by a dependency-free harness ([`sanity-tests/idempotency.mjs`](sanity-tests/idempotency.mjs), added by this assessment)
that models a provider with latency and a call counter, then runs the candidate designs against
the same workload. Re-runnable; numbers below are from 2026-09-13.

**M-1 · Concurrent duplicates — twelve simultaneous requests for one resource**

| Design | Provider calls | All callers correct? |
|---|---|---|
| No protection | 12 | yes |
| Cache only (check-then-act) | **12** | yes |
| Cache + in-flight map | **1** | yes |

A cache alone does nothing under concurrency. All twelve callers check, all twelve miss, all
twelve execute, and the last write wins. This is precisely the race the directive describes, and
it is not a theoretical one: it is the normal shape of a library scan.

**M-2 · The key-reuse trap — twelve different rows**

| Keying | Calls | Distinct results | Rows correct |
|---|---|---|---|
| One key for the batch | 1 | 1 | **1 / 12** |
| Key per resource, origin-bound | 12 | 12 | **12 / 12** |

Eleven of twelve rows silently receive another row's data. Exactly the failure the directive
warns about, reproduced.

**M-3 · Parameter collision — English then Spanish subtitles for one film**

| Key | Calls | What the Spanish request returned |
|---|---|---|
| Omits language | 1 | **the English response** |
| Includes language | 2 | correct |

Origin identity alone is not enough. See §4, C4.

**M-4 · Failure must not poison the key**

A transient 503 followed by a retry: first attempt fails, retry succeeds, 2 provider calls total.
This only holds because the in-flight entry is cleared in `finally`, not in `then`. Clearing on
success only would leave a rejected promise cached under that key for the life of the process —
one blip and that film is permanently unmatchable until restart.

**M-5 · What deduplication buys against a finite rate budget**

Library of 5,000 tracks / 400 albums / 120 artists, at MusicBrainz's 1 req/s:

| | Calls | Time at the limit |
|---|---|---|
| No deduplication | 15,000 | 250 min |
| Deduplicated | 5,520 | 92 min |
| **Saved** | **9,480** | **158 min** |

**M-6 · Does concurrency help? Only for the right workload**

| Workload | Pool 1 | Pool 8 |
|---|---|---|
| Local work (ffprobe-like) | 487 ms | **61 ms** |
| Rate-limited (MusicBrainz-like) | 595 ms | **602 ms** |

This is the central integration insight of the phase. **Concurrency and deduplication solve
different problems and are not interchangeable.** A worker pool is an 8× win on ffprobe and
worth nothing against a rate limiter — worse than nothing, because eight workers turn a polite
serial queue into a burst and invite a temporary block. Local work gets the pool; network work
gets deduplication plus a rate gate, and the pool only shapes how many *distinct* requests are
prepared in parallel, never how fast they leave.

---

## 4. Corrections to the brief

The directive is written in the vocabulary of a payments API. Most of it transfers; five points
do not, and building them literally would produce the wrong thing.

**C1 — There is no server we control, so the guarantee is ours to keep.**
The directive says "the server should return the cached response". None of Que's providers —
MusicBrainz, Cinemeta, OpenSubtitles v3, Cover Art Archive, lyrics.ovh, iTunes — accept an
`Idempotency-Key` header or offer any idempotency contract. Nothing upstream will deduplicate on
our behalf. Idempotency is therefore enforced *entirely client-side, inside Que's provider
layer*: for this purpose **Que is the server**. Two consequences the brief does not imply:
the guarantee holds only within one process unless we persist it (§5.4), and its correctness is
ours to test rather than a vendor's to uphold.

**C2 — The cost is a finite rate budget and wall-clock, not duplicate charges.**
Nothing is billed. The thing we can actually exhaust is 1 req/s and the user's patience: 158
minutes on a 5,000-track library (M-5). Worth stating because it changes the priority order — an
optimisation that halves calls is worth more here than one that halves latency per call.

**C3 — Duplicate *data entries* are prevented by the database, not by idempotency keys.**
The directive links the two. They are separate defences and both are required. `media.path` is
unique; metadata application is upserted by row. If the idempotency layer were removed entirely,
we would make redundant network calls but would still not get duplicate rows. Conflating them
risks quietly skipping a constraint because "the key handles it".

**C4 — The key is per *resource*, not per database row.**
This is the correction that matters most. "Each row gets its own unique key" is right about
collisions (M-2) and wrong about sharing (M-1). Twelve tracks on one album are twelve rows that
legitimately want *the same* release lookup; keying on `media.id` gives twelve identical calls
and discards the entire deduplication win. The key must identify **the request**, grounded in
origin identity plus every parameter that varies the response (M-3):

```
v1:<provider>:<capability>:<origin-kind>:<origin-id>:<params-hash>
```

Rows that resolve to the same resource share a key by design; rows that resolve to different
resources can never collide. Both harness failure modes are the two ways to get this wrong, and
one formulation avoids both.

**C5 — A failure-caching policy is required and is not implied by "cache the response".**
Success, "definitively not found", and "failed to ask" are three different outcomes with three
different lifetimes. Caching a 503 is a bug; not caching a 404 means re-asking about an obscure
B-side on every scan forever. §5.5 sets the policy.

---

## 5. Design

Four separable pieces. Each is independently testable, which is the point.

### 5.1 Key builder — pure, versioned, tested

A pure function, no I/O, no clock. Versioned prefix so a future schema change invalidates old
cache entries loudly rather than matching them silently (R2).

`origin-id` is the most stable identifier known for the resource: an MBID, IMDb or TMDB id where
one exists, otherwise a normalised digest of the natural key (film: title + year; recording:
artist + album + disc + track + title). Normalisation — case, whitespace, diacritics, leading
articles — is part of the pure function and gets its own tests, because a normalisation change is
a cache invalidation.

`params-hash` covers every argument that varies the response: language, format, region, result
limit, provider-specific flags. The rule is mechanical — if it goes in the request, it goes in
the hash.

### 5.2 Single-flight — the mechanism the directive describes

```
get(key, fetch):
  1. cache hit            → return the cached value immediately, no execution
  2. in-flight hit        → return the existing promise; the second caller waits for the first
  3. otherwise            → start it, register the promise, cache on success,
                            and delete the in-flight entry in `finally` (M-4)
```

Steps 1 and 2 both run before any `await`, so there is no window between the check and the
registration. That ordering *is* the fix; anything that awaits between them reintroduces M-1.

**Cancellation (R7).** The in-flight promise is owned by the layer, never by its first caller.
A caller that aborts — a cancelled scan, a closed window — detaches from the promise; it does not
cancel it for the other eleven joiners. The underlying request is abandoned only when every
joiner has left. This is subtle enough to be worth a dedicated test, because the natural
implementation (pass the caller's `AbortSignal` straight through) gets it wrong in a way that
only shows under cancellation.

### 5.3 Bounded pool and rate gate — one utility, two consumers

Per AAR-M1 §4, built once here and inherited by M3.

- **Pool** — bounded concurrency, error isolation (one rejection does not sink the batch),
  ordered results, cancellable. Consumers: the scanner's ffprobe calls now; provider request
  preparation in M3.
- **Rate gate** — per-host minimum interval plus a small token bucket, applied *inside* the pool
  at the point of dispatch. Per M-6, pool size and request rate are independent controls and must
  not be conflated: ffprobe gets pool 8 / no gate; MusicBrainz gets 1 req/s regardless of pool
  size.
- **Retry** — exponential backoff with jitter, capped attempts, only for classified-transient
  errors, and retries pass back through the same gate so a failure storm cannot become a burst
  (R8).
- **Clock injection** — the pool, gate and backoff take a clock and a sleep function. Timing-
  dependent code that cannot be tested deterministically will not be tested (R9).

### 5.4 Two cache layers, two lifetimes

| Layer | Lifetime | Scope | Purpose |
|---|---|---|---|
| In-memory map | process | main process | deduplication within a session; the only layer that can serve step 1 with zero I/O |
| `http_cache` table (migration 001) | persistent | on disk | survives restart, so a second scan does not re-spend the rate budget |

The in-flight map is necessarily in-memory and per-process — a promise is not serialisable. That
is acceptable while providers live only in the main process, and it is a constraint to record
rather than a limitation to fix (R6).

### 5.5 Cache policy by outcome

| Outcome | Cached? | TTL | Rationale |
|---|---|---|---|
| Success | yes | none (invalidated explicitly) | the answer does not change; a re-match is a user action |
| Definitive negative (404 / no match) | yes | 30 days | avoids re-asking forever; bounded so a later-added record is eventually found |
| Rate-limited (429) | **no** | — | retry through the gate |
| Transient (5xx, timeout, socket) | **no** | — | M-4: never poison a key with a failure to ask |
| Malformed response | no, but logged | — | a parse failure is our bug or their change; it should be visible, not absorbed |

### 5.6 Per-row application is transactional per row

The directive's "per row" idea extends past the fetch. When a batch of metadata is applied, each
row's write is its own transaction, keyed by the same origin key, and re-applying it is a no-op.
A cancelled or crashed batch then leaves N complete rows and the rest untouched — never N
half-written ones. This is what makes re-running a metadata pass safe, which is what makes it
resumable.

---

## 6. Plan-wide integration

| Milestone | What M1b gives it | What it constrains | Cost of deferring |
|---|---|---|---|
| **M1b scanner** | ffprobe on a pool: 20k-file cold scan from ~14.5 min to ~2–3 min (M-6) | scan cancellation must detach cleanly (R7) | the measured D3 cost persists |
| **M2 library view** | nothing directly | none | none — M2 could run first, but see §8 |
| **M3 metadata** | **the reason this phase exists.** 158 min saved per 5k-track library (M-5); correct answers per row (M-2) | providers must be pure `(key, params) → response` behind the layer, with no fetching of their own | M3 grows a second half-solution and the two drift — the explicit AAR-M1 §4 warning |
| **M4 artwork (TMDB / CAA)** | same layer; image fetches dedupe hard — one cover per album, not per track | artwork keys use the release origin id, never the track's | duplicate image traffic and a second cache |
| **M5 subtitles / lyrics** | M-3 is this milestone's failure mode exactly — language is a key parameter | subtitle keys must include language, format and release hash | wrong-language subtitles served from cache, and it would look like a provider bug |
| **M6–M8 ratings, playlists, skins** | none | none | none |
| **M9 LAN server** | requests from several devices for one resource collapse to one upstream call | providers stay in the main process, or the in-flight map moves with them (R6) | N devices × N calls |
| **M10–M11 packaging, polish** | a deterministic, clock-injected layer is testable in CI | — | — |

**Interaction with §23 (hiding / age limits).** Provider responses supply the ratings that
restrictions act on. The invariant that must survive this phase: **restrictions are enforced in
the query layer against the database, never against a cached provider response.** A stale or
wrong cache entry may make a row's metadata wrong; it must not be able to make a hidden row
visible. This holds today and is cheap to keep — it gets an explicit test in the frozen scope.

---

## 7. Recommendation: split M1b

As planned, M1b holds two unrelated workstreams: the concurrency/idempotency layer and the HLS
transcode pipeline. They share no code, no risk, and no reviewer attention.

| | Concurrency & idempotency | HLS transcode |
|---|---|---|
| Blocks | M3, M4, M5, M9 | playback of MKV/HEVC titles only |
| Risk if wrong | silent wrong data across the library | one file will not play, visibly |
| Verification | deterministic tests, clock-injected | real media, real ffmpeg, manual |

**Split them: M1b = concurrency & idempotency, M1c = HLS.** M1b is on the critical path for four
later milestones; M1c blocks nothing until a user has an unplayable file, and the 415 response
from AAR-M1 D-* already tells them why. Bundling a fast deterministic phase with a slow empirical
one means the AAR for M1b waits on HLS, and every finding gets reviewed with half the attention.

---

## 8. Sequencing: why M1b before M2

M2 does not need this layer, so ordering is a choice. Do M1b first:

- The scanner is a **cheap, fast, local** consumer. It exercises pool, cancellation and error
  isolation against work that costs 43.5 ms and no rate budget. Validating the utility there
  before M3 bets the metadata phase on it is the whole argument for building it once.
- M2's handler surface roughly doubles (filters, facets, saved filters). Adding that surface on
  top of a layer that is about to change underneath it is the more expensive order.

---

## 9. Risk register

| ID | Risk | Sev | Detection | Mitigation |
|---|---|---|---|---|
| **R1** | Scanner and providers grow separate pools that drift | high | code review; one module, two importers | single `src/main/concurrency/` utility, built here, imported by both |
| **R2** | Key schema changes later and silently matches stale `http_cache` rows | high | version prefix mismatch is visible; key-builder tests pin the format | `v1:` prefix; bump invalidates; pure function with golden tests |
| **R3** | In-flight entry never settles (hung socket) and poisons the key for the process | high | a timeout test with a never-resolving fetch | every request carries a timeout + `AbortSignal`; `finally` clears unconditionally |
| **R4** | A confidently wrong 200 is cached indefinitely | medium | user-visible wrong metadata | cache rows record provider + `fetched_at`; an explicit "re-match" deletes by key prefix |
| **R5** | Cached data becomes a path around §23 restrictions | high | dedicated test: hidden row + warm cache → still refused | restrictions evaluated in the query layer only; test added to frozen scope |
| **R6** | Providers later move to a utility process; the in-flight map does not follow | medium | design review at M9 | recorded constraint: providers stay in main; revisit at M9 |
| **R7** | A cancelling caller cancels the shared request for its joiners | medium | dedicated cancellation-detach test | the layer owns the promise; callers detach; abort only when all joiners leave |
| **R8** | Retries become a burst and trip a rate limit or an IP block | medium | gate instrumentation counts dispatches/second | backoff with jitter, capped attempts, retries re-enter the same gate |
| **R9** | Timing-dependent code proves untestable and ships untested | medium | it would show up as "no tests for the pool" in the AAR | clock and sleep injected from the start; harness pattern already proven |
| **R10** | A cancelled metadata batch leaves half-written rows | medium | interrupt test mid-batch | per-row transaction, idempotent re-apply (§5.6) |
| **R11** | Concurrency bugs are flaky; "the author ran the tests once" is weak evidence | **high** | — | see §10: run concurrency tests under `--repeat` until CI exists |

---

## 10. Entry criteria

| Criterion | Status |
|---|---|
| AAR-M1 complete, remediation on disk | ✅ |
| `http_cache` table exists (migration 001) | ✅ |
| Providers behind a chain abstraction (§7) | ✅ |
| Harness demonstrating the semantics | ✅ (§3) |
| **CI actually running** | ❌ **unmet — third milestone carrying this** |
| AAR-M1 remediation committed | ❌ **uncommitted; the device shell is blocked** |

Two unmet. Neither blocks, both need a compensating control:

- **CI (AAR-M0 P2, AAR-M1 P2).** This is the first phase where it genuinely bites. Concurrency
  defects are non-deterministic; a suite that passed once has not been shown to pass. Compensating
  control: every concurrency and single-flight test runs under `vitest --repeat=20` in the phase
  gate, and the gate is recorded in the AAR with its repeat count. This is weaker than CI and is
  explicitly a stopgap — a remote remains the top carried action.
- **Uncommitted remediation.** M1b must not start on top of an uncommitted tree; a failure would
  be unbisectable. First action of the phase, by hand: `git add -A && git commit`.

---

## 11. Frozen scope — M1b

Copied verbatim to `docs/M1b-SCOPE.md`. Not edited during the phase.

1. **Bounded concurrency pool** — configurable size, error isolation, ordered results,
   cancellation, injected clock. Shared utility.
2. **Rate gate** — per-host minimum interval + token bucket, applied at dispatch, independent of
   pool size.
3. **Retry** — classified-transient only, exponential backoff with jitter, capped, routed back
   through the gate.
4. **Idempotency key builder** — pure, versioned, normalising; covers origin identity and every
   response-varying parameter.
5. **Single-flight layer** — cache check and in-flight check both before any await; `finally`
   clears; callers detach on abort without cancelling joiners.
6. **Two-layer cache** — in-memory + `http_cache`, with the §5.5 outcome policy and TTLs.
7. **Scanner uses the pool for ffprobe**, with cancellation preserved.
8. **Tests**, each with a verified negative control where it guards something:
   a. concurrent duplicates collapse to one call (M-1)
   b. distinct resources never collide; shared resources do share (M-2)
   c. a response-varying parameter changes the key (M-3)
   d. a transient failure does not poison the key (M-4)
   e. an abort detaches the caller without cancelling joiners (R7)
   f. a never-settling request times out and clears (R3)
   g. a hidden row stays refused with a warm cache (R5)
   h. per-row application is transactional and idempotent on re-run (R10)
9. **IPC handler round-trip tests** — the unmet half of M1 scope item 8 (AAR-M1 P1).
10. **ARCHITECTURE updates** — §7 rate gate in the provider contract, §8 key schema and TTL
    policy, §22 M1b/M1c split, and the one-definition-per-wire-shape rule (AAR-M1 D1).

**Explicitly out of scope:** HLS transcoding (→ M1c) · any actual provider implementation (→ M3)
· distributed or cross-process idempotency (→ revisit at M9) · file watching.

### Exit criteria

- Typecheck clean, lint clean, all tests passing, concurrency tests passing under `--repeat=20`.
- A measured before/after on a real cold scan, reported in AAR-M1b. The prediction on record is
  ~14.5 min → ~2–3 min at 20,000 files; if it is not met, that goes in the AAR as a miss.
- The harness re-runs and its table is reproduced in the AAR.

---

## 12. Falsification

Written now, while it is still cheap to be honest. Any of these means stop and reassess rather
than push through:

1. **The pool does not speed up scanning as predicted.** If ffprobe is contended on disk rather
   than CPU, pool 8 may return far less than 8×. If the measured gain is under 2×, the pool is not
   worth its complexity for the scanner and its only justification becomes M3 — which changes what
   should be built here.
2. **Cancellation cannot be made clean.** If detach-without-cancel proves unworkable against
   Node's fetch/AbortSignal semantics, the honest fallback is to make provider calls
   non-cancellable and let them complete into the cache. That is a worse but coherent design, and
   it must be a decision rather than a bug.
3. **`http_cache` write volume dominates.** If persisting every response costs more than the calls
   it saves on a warm scan, the persistent layer becomes write-behind or is dropped to
   memory-only.
4. **Normalisation proves unstable.** If the natural-key digest changes across releases of our own
   normalisation code often enough to invalidate the cache repeatedly, the fallback key is wrong
   and we need a stored surrogate id per row instead.

---

## 13. Open questions for the AAR

Not blockers; record answers when known.

- What is the real MusicBrainz burst tolerance? The documented average is 1 req/s; whether short
  bursts are tolerated determines the token bucket's size, and it is worth measuring rather than
  guessing.
- Does the 30-day negative TTL match how often new records actually appear for obscure releases?
- Should a user-visible "re-match this item" action land in M1b (where the cache is built) or M3
  (where it becomes useful)? Current answer: build the invalidation primitive here, surface the
  action in M3.

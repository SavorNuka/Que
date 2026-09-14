# After Action Review — M1c (HLS Transcode)

Reviewed 2026-09-13, immediately after M1c, before M2.
Assessed against the frozen scope in [M1c-SCOPE.md](M1c-SCOPE.md) and the design in
[PRA-M1c.md](PRA-M1c.md), under [PROCESS.md](PROCESS.md).

**Verdict: 12 of 12 scope items delivered, two of them differently than designed (both
deviations recorded, both approved before being built). Four defects found, all fixed. The
falsification section is the headline: real playback failed on its first two attempts, for
reasons that had nothing to do with HLS, hls.js or ffmpeg and everything to do with Que's own
URL plumbing — found only by actually launching the app and playing a file, exactly the gap the
handoff to this session existed to close.**

The pre-phase assessment earned its place before any code existed too: §4 C1's correction (a
file can need a container remux *and* an audio transcode at once, and the single `remux_reason`
enum can only ever report one) would otherwise have shipped the MKV+H.264+AC-3 case — named in
ARCHITECTURE as the common real one — half-fixed.

---

## 1. Did the output match the frozen scope?

| # | Scope item | Status |
|---|---|---|
| 1 | Per-stream transcode planner, independent of `remux_reason` | ✅ delivered, `plan.ts`, 14 tests incl. real synthesized AC-3/HEVC fixtures |
| 2 | Progressive HLS generation, one pipeline for remux and transcode | ✅ delivered via `-hls_playlist_type event`; verified against real ffmpeg output and a real end-to-end play |
| 3 | Seek beyond the generated frontier | ✅ delivered **differently — deviation D6**: a fresh job at the target offset, not a discontinuity-splice into one running playlist |
| 4 | Shared concurrency budget, probe pool vs. transcode | ✅ delivered, `budget.ts` + new `Pool.resize()`, 9 + 4 + 5 tests |
| 5 | Segment cache — fingerprint invalidation, size-capped LRU | ✅ delivered, `cache.ts`, 16 tests |
| 6 | Process lifecycle — idle timeout, quit-kill | ✅ delivered, `manager.ts`, covered in its 15 tests |
| 7 | Single-flight, reused from M1b | ✅ delivered **differently — deviation D5**: a plain `Map` is correct and sufficient; single-flight would guard a race that cannot occur here |
| 8 | HTTP surface, same auth + restriction guard as `/stream/<id>` | ✅ delivered, 11 tests, **and found D1 + D2** |
| 9 | `ffmpeg.ts` testable outside Electron | ✅ delivered — closes AAR-M1b D6 / OPEN-ACTIONS #3 — **and surfaced D3** |
| 10 | Renderer fallback, hls.js | ✅ delivered, verified by real playback; no automated renderer test (jsdom has no MediaSource) |
| 11 | Eight named tests, a–h | ✅ six delivered as specified; **d delivered against the new seek design, not a discontinuity tag; h not independently adversarial-tested** — see below |
| 12 | ARCHITECTURE / living-doc updates | ✅ §8, §10.5, §22, README |

Out-of-scope items stayed out: no LAN-specific hardening beyond the shared guard, no cache-size
Settings UI, no subtitle handling in the transcode, no adaptive bitrate, no predictive
pre-transcoding. Nothing crept in.

### The eight required tests

| | Property | Where | Note |
|---|---|---|---|
| a | Container+audio-codec fixture produces both flags | `plan.test.ts` | — |
| b | Hidden row's HLS endpoints refuse with a warm cache | `server.test.ts` | positive control: the same request with restrictions off is confirmed to succeed first |
| c | Two concurrent requests collapse to one process | `manager.test.ts` | — |
| d | Seek past the frontier starts a fresh job at that offset | `manager.test.ts`, `server.test.ts` | **not** a discontinuity tag on the old playlist — D6 |
| e | An idle job is killed, no process left running | `manager.test.ts` | — |
| f | A rescan that changes fingerprint invalidates the cache | `cache.test.ts`, `server.test.ts` | — |
| g | Probe pool shrinks/recovers with the budget | `pool.test.ts`, `scanner.test.ts` | — |
| h | A segment is never listed before ffmpeg closes it | *(see below)* | not independently tested |

(b)'s positive control follows the standing rule from AAR-M0/AAR-M1b: the four refusal
assertions sit next to one confirming the identical request succeeds once restrictions are off,
so they cannot be passing vacuously against a request that would 404 for an unrelated reason.

(h) relies entirely on ffmpeg's own guarantee — a segment is appended to the playlist only after
it is closed — which the server trusts rather than re-verifies. The real end-to-end run observed
this working correctly under an actively-generating playlist (segments arrived one at a time,
none truncated, playback never stalled on a bad chunk), which is real evidence, but no unit test
forces the specific race (reading the playlist mid-write) the way (a)–(g) force their properties.
Recorded as a coverage gap, not a passing test — see Actions.

---

## 2. Defects found in this review

### D1 — `hlsUrl` was page-relative and resolved against the wrong origin · **Severity: high · FIXED**

`server.ts`'s 415 body built `hlsUrl` as `/hls/${id}/playlist.m3u8?t=...` — a path, not a URL.
The renderer resolved it with `new URL(hlsUrl, window.location.href)`, and the renderer's own
page origin is `file://` (or the dev server's), never the media server's
`http://127.0.0.1:8723`. The result was a literal `file:///D:/hls/1023/playlist.m3u8` request
that failed with no useful signal beyond `ERR_FILE_NOT_FOUND`.

`/stream/<id>` never had this bug, because `urlFor()` has always built a full absolute URL. The
new `hlsUrl` field skipped that pattern. Found on the very first launch of the real app against
a real file — no unit test constructs a `URL` against a `file://` base, because no unit test has
a renderer page origin to get wrong.

Fixed: `hlsUrlFor(id)`, mirroring `urlFor()` exactly. Regression test added
(`points /stream's 415 body at an absolute hlsUrl, not a page-relative path`).

### D2 — The segment route never matched what ffmpeg actually wrote into the playlist · **Severity: high · FIXED**

The frozen design put segments at `/hls/<id>/segments/<name>`. ffmpeg writes **bare** segment
filenames into the playlist (`seg00000.ts`, no path prefix — the segment sits next to the
playlist on disk, so ffmpeg has no reason to prefix anything). hls.js resolves that bare
reference relative to the playlist's own URL, dropping the last path element:
`/hls/<id>/playlist.m3u8` → `/hls/<id>/seg00000.ts`. The actual route,
`/hls/<id>/segments/seg00000.ts`, was never once requested by hls.js in the real run — every
segment 404'd.

This is the sharper of the two, because it is invisible to exactly the kind of test this phase
already had: the server-side HLS tests use a fake spawn that writes a fake segment file and then
fetch the *matching* URL directly — correct by construction, since the test author (not ffmpeg)
chose both the file path and the request URL. Nothing forced them to agree with what real ffmpeg
would reference. Only real ffmpeg output, read by real hls.js, could show the mismatch.

Fixed: playlist and segments now live in the same URL directory —
`/hls/<id>/<name>` and `/hls/<id>/seek/<n>/<name>`, where `<name>` is either
`playlist.m3u8` or a segment. All affected tests updated to the new URL shape.

### D3 — Three real-media probe tests had been silently skipping on Windows since M1 · **Severity: medium · FIXED**

A side effect of fixing `ffmpeg.ts` (scope item 9): `tests/helpers/media.ts`'s `hasFfmpeg()`
looked up `ffmpeg`/`ffprobe` via bare PATH resolution (`execFileSync('ffprobe', …)`), and neither
binary has ever been on this Windows machine's PATH — only bundled in `resources/bin/`. Every
`it.runIf(hasFfmpeg())` real-media test in `tests/probe.test.ts` has therefore been silently
skipped on every Windows run since the test was written in M1, with no failure and no signal —
`vitest`'s summary line does not distinguish "skipped because the guard is false" from "skipped
because the guard is testing the wrong thing."

Found only because fixing AAR-M1b D6 (OPEN-ACTIONS #3) for an unrelated reason (making
`ffmpeg.ts` importable outside Electron) meant `tests/helpers/media.ts` could finally resolve the *real*
bundled binary through the same code path the app uses — and the moment it could, the tests it
had been skipping started running and immediately hit a second bug (`execFileSync('ffprobe', …)`
inside the test bodies themselves, same PATH assumption).

Fixed: `hasFfmpeg()`/`ffmpegBin()`/`ffprobeBin()` now resolve through `ffmpeg.ts`, and
`tests/probe.test.ts` calls them instead of the bare command name. All three previously-skipped
tests now execute and pass.

### D4 — A resize test raced two fixed sleeps against a 20ms task, under load · **Severity: low · FIXED**

`vitest --repeats=20` (this project's compensating control for the absence of CI, per PRA-M1b
§10) caught it on the first run of this session's new `Pool` tests: under 20 repeats' worth of
system load, a `setTimeout(…, 5)` occasionally took long enough that a 20ms task had already
completed by the time the assertion ran, changing which tasks were active when `resize()` was
called and making `expect(pool.active).toBe(3)` see 2.

Fixed by removing the wall-clock dependency entirely rather than widening the margin: the task
now blocks on a manually-resolved promise, so admission and resize can be asserted synchronously
with no timing window at all. The sibling "shrinking" test had an unnecessary sleep too — removed
on the same reasoning, since size-3 admission of three tasks is synchronous by construction.

### D5 — Single-flight (PRA-M1c §5.7) was not reused, by design · **DEVIATION, RESOLVED**

The PRA proposed reusing `src/main/idempotency/single-flight.ts` to dedupe two concurrent
requests for the same transcode job, generalising the mechanism past provider calls. Building it
showed this was unnecessary: single-flight exists to close the race window around an `await` —
the check and the registration must both happen before any suspension point. Starting a
transcode job has no such window. `mkdirSync`, `ConcurrencyBudget.reserve` and
`child_process.spawn` are all synchronous, so the job is written into `TranscodeManager`'s job
map before this code's first `await`. Two calls invoked back-to-back already coalesce with a
plain `Map`, verified by a test (`two rapid calls in the same synchronous turn still coalesce`).

Recorded here rather than silently built the other way, because the PRA's plan-wide-integration
section specifically called this out as a notable generalisation of an M1b mechanism — worth
correcting explicitly rather than leaving the record wrong. Reused where it solves a real
problem; not reused where it would guard a race that cannot occur.

### D6 — Seeking uses a fresh job per offset, not a discontinuity-splice · **DEVIATION, RESOLVED**

PRA-M1c §5.3 designed seeking as: kill the running ffmpeg, restart it with `-ss`, and append new
segments to the *same* playlist behind an `#EXT-X-DISCONTINUITY` tag. Before building it, this
was flagged back to the user as a real complexity/risk trade-off (correct segment renumbering,
safe mid-write splicing, more failure modes to test) against a simpler alternative — a seek
beyond the buffered range gets its own job and its own playlist URL, and the player points
hls.js at the new manifest. Approved before building.

Both are equally "segment-addressed, exact by construction" per ARCHITECTURE §8's own framing of
why HLS was chosen; they differ only in mechanism. The simpler one shipped, is tested
(`manager.test.ts`, `server.test.ts`), and was exercised once in the real end-to-end run with no
error.

---

## 3. The falsification outcome

PRA-M1c §10 listed four criteria in advance. One resolved with a real, informative answer; three
remain genuinely untested — not falsified, not confirmed, honestly unresolved.

### Resolved: hls.js *can* play a real `ffmpeg -f hls` output in the Electron renderer — but only after two Que-side bugs were found and fixed

This is the one link in ASSUMPTIONS.md A2's whole chain that had never executed. The first two
real attempts **did fail**, in exactly the shape the criterion worried about — but not because
HLS, hls.js or ffmpeg don't work together. Both failures were Que's own URL plumbing (D1, D2).
Once fixed, a real 369-file MKV library scanned, a real 90-minute file played end to end through
the new routes (confirmed visually — correct running time, real video frames, real audio), and a
real mid-playback seek succeeded with no error. The chain holds; it just was not free.

### Unresolved: real HEVC/AC-3 transcode timing

PRA-M1c §3 M-3's 36× figure is a proxy — 720p H.264 source, re-encoded on a 28-core machine —
not a measurement of the case M1c exists for. No real HEVC or AC-3 sample was available to this
session (confirmed again: the reference library remains 100% H.264+Vorbis MKV). The synthesized
fixtures in `tests/transcode/plan.test.ts` prove the *planner* correctly recognises HEVC/AC-3;
they say nothing about how fast a real 4K HEVC file would transcode. Carried forward.

### Unresolved: whether the shared concurrency budget actually protects playback under load

`ConcurrencyBudget` and `Pool.resize()`'s wiring is unit-tested and demonstrably correct in
isolation (`scanner.test.ts`'s `createProbePool` tests). No manual test ran a real scan and a
real transcode on this machine at the same time to observe whether either visibly stutters the
other. Carried forward — this is real-media-and-real-playback territory per the handoff's own
warning, and it was not exercised this session.

### Unresolved (premise changed): repeated seek-induced process/segment corruption

The criterion as written no longer quite applies: it was about discontinuity-splicing into one
running playlist, and D6 means M1c does not do that. The analogous risk in the shipped design —
does superseding a job ever leave a stray ffmpeg process — was exercised exactly once, cleanly,
in the live run. Once is not evidence of "rarely" one way or the other. Carried forward.

---

## 4. Process

### P1 — Manual verification found what 425 passing tests could not

Neither D1 nor D2 is reachable by a unit test as this project's suite is currently shaped: D1
needs a real `file://`-origin page resolving a real relative URL, and D2 needs real ffmpeg
output read by real hls.js — both server-side HLS tests use a fake spawn that writes exactly the
file the test then requests, which is correct by construction and therefore structurally blind
to whether ffmpeg and hls.js would agree with that choice in reality. This is the sharpest
confirmation yet of the handoff's central thesis: a Windows-targeted, runtime-behaviour-dependent
change is not verified by typecheck, lint or a green test suite. Both bugs were found in the
first two minutes of actually launching the app.

### P2 — The repeats gate caught a real flake in code written this same session

Second milestone in a row (after AAR-M1b P1) that `vitest --repeats=20` earned its keep, this
time against a test authored and merged within the same session rather than something inherited.
Consistent with the standing rule: a test that has never been seen to fail proves nothing, and
that now includes tests about a feature (`Pool.resize`) built in the same sitting as the test.

### P3 — A bulk edit was silently corrupted by shell quoting, caught by review before it shipped

Removing the now-defunct `/segments/` path segment from several test URLs was attempted with a
`perl -e` bulk replace inside a double-quoted shell string containing `${id}` — bash expanded
`${id}` to an empty string before perl ever saw the pattern, silently turning several URLs into
`/hls//seg00000.ts`. Caught by grep-reviewing the diff before running the suite, not by the suite
itself (a few of the corrupted URLs would have failed loudly; it was luck, not design, that this
was caught by inspection first). Worth naming as a rule: a bulk textual edit gets the same
"read it back before trusting it" discipline as a bulk `git add`.

### P4 — The whole session ran on an EOL, explicitly-excluded Node version

Discovered mid-session, unrelated to any specific change: this machine runs Node 25.2.1,
past the 2026-06-01 EOL date README.md itself documents, and outside `package.json`'s
`engines: "^22.12.0 || ^24.0.0 || >=26.0.0"`. `npm install` only warns rather than refusing, so
every gate this session — and, per HANDOFF.md, the M1b verification before it — ran on a runtime
the project deliberately excludes. Not a code defect; an environment fact that undermines
confidence in "the gates are green" until fixed. Flagged to the user; fixing it is a machine
change outside this phase's scope.

### P5 — Coverage after this pass

| Layer | Coverage |
|---|---|
| Transcode planner (`plan.ts`) | 14 tests, incl. real synthesized AC-3/HEVC fixtures |
| Concurrency budget (`budget.ts`) | 9 tests |
| Segment cache (`cache.ts`) | 16 tests |
| Job manager (`manager.ts`) | 15 tests, incl. one real end-to-end ffmpeg run |
| `Pool.resize()` | 4 tests |
| Scanner ↔ budget wiring | 5 tests |
| HTTP HLS routes | 11 tests |
| Renderer (`Player.tsx` + hls.js) | **0 automated** — jsdom has no MediaSource; covered by the manual end-to-end run only |
| Real HEVC/AC-3 codec paths | **0** — no real sample available (falsification §3) |

**425 tests passing, 1 skipped** (the benchmark), up from 351 at the start of this session.

---

## 5. Downstream impact

Re-answering PRA-M1c §6 with what building it actually taught:

| Finding | Impact on later milestones |
|---|---|
| **D1 + D2, both URL-plumbing bugs invisible to unit tests** | Any future client-facing URL that a server builds and a browser resolves needs the same treatment: either build it absolute and test the string, or run it through a real resolver once. Worth a line in ARCHITECTURE §17 before M9 builds LAN-facing URLs of its own. |
| **Single-flight generalises only where a real await-gap exists (D5)** | M9's LAN server will have a genuine one — several devices requesting a resource across real network round-trips, not a synchronous spawn. That is exactly the shape single-flight solves; the transcode job registry is not the counter-example, it's a case that didn't need it. |
| **Seek-as-fresh-job (D6) keeps the mechanism identical to the from-start job** | M9 sees no new surface: a LAN client hitting a seek URL is indistinguishable from the local player doing the same, since both are just HTTP requests to the same routes. |
| **Segment cache size cap is a hardcoded constant** | M11's Settings UI needs a control for it, and ideally a "clear transcode cache" action next to artwork's equivalent. |
| **HEVC/AC-3 timing remains unmeasured** | Before this becomes a real complaint (a 4K HEVC library), get one real sample and re-run PRA-M1c §3 M-3's measurement. If it comes in far under the 36× proxy, the "start ffmpeg and let it catch up" default needs an explicit pre-buffer target, per PRA-M1c falsification 1. |
| **Concurrency budget unverified under real load** | Before relying on it, run a real scan and a real transcode together on this machine and watch for stutter. Cheap to do, not yet done. |

---

## 6. What changed as a result of this review

| Change | Files |
|---|---|
| `hlsUrl` built absolute via `hlsUrlFor()`, matching `urlFor()` (D1) | `server/server.ts` |
| Playlist and segments share one URL directory per job (D2) | `server/server.ts`, `tests/server.test.ts` |
| `ffmpeg.ts` no longer imports `electron`; search roots injected (D3, scope item 9) | `ffmpeg.ts`, `main/index.ts` |
| Test helpers resolve the bundled binary instead of PATH (D3) | `tests/helpers/media.ts`, `tests/probe.test.ts` |
| `Pool.resize()` test rewritten off wall-clock timing (D4) | `tests/concurrency/pool.test.ts` |
| `Pool.resize()` — new capability on the shared M1b/M1c utility | `concurrency/pool.ts` |
| Per-stream transcode planner | `transcode/plan.ts` |
| Progressive HLS job manager, process lifecycle | `transcode/manager.ts` |
| Segment cache, fingerprint invalidation, size-capped LRU | `transcode/cache.ts` |
| Shared concurrency budget | `transcode/budget.ts` |
| Probe pool wired to the shared budget | `library/scanner.ts` |
| `/hls/<id>/...` and `/hls/<id>/seek/<n>/...` routes | `server/server.ts` |
| hls.js wired into the player, token carried via `xhrSetup` header | `renderer/src/app/Player.tsx`, `package.json` |
| ARCHITECTURE §8 (route surface, cache location), §10.5 (shared budget), §22 (M1c ✅) | `docs/ARCHITECTURE.md` |
| README status, troubleshooting, documentation index | `README.md` |
| This review | `docs/AAR-M1c.md` |

Gates: **typecheck clean · lint clean · 425 tests passing · 157 concurrency/idempotency tests
passing under `--repeats=20`**. Manually verified: real 369-file MKV library scanned, a real
file played end to end through the new routes, a real seek succeeded — screenshots and network
log captured during the session.

---

## 7. Actions carried forward

Reconciled into [OPEN-ACTIONS.md](OPEN-ACTIONS.md).

1. **Get or synthesize a real HEVC/AC-3 sample and re-measure transcode timing** against it.
   The 36× figure in PRA-M1c §3 is a proxy on a cheap source; this is the load-bearing unknown
   in the whole design. *(§3 falsification, unresolved)*
2. **Stress-test the shared concurrency budget** with a real simultaneous scan and transcode on
   the target machine. Unit-tested in isolation; never observed under real load. *(§3
   falsification, unresolved)*
3. **Move the segment cache size cap from a hardcoded constant to Settings UI**, and add a
   "clear transcode cache" action. *(M1c-SCOPE §9, explicitly deferred; M11)*
4. **Switch the dev machine off Node 25** to 24 LTS or 26+ before the next session. Every gate
   this session ran on an EOL, explicitly-excluded runtime. *(P4, environment, not milestone-owned)*
5. Write an adversarial test for (h) — reading the playlist while ffmpeg is still writing a
   segment — rather than relying on ffmpeg's own guarantee plus one clean observed run. *(§1,
   item 11h coverage gap)*

Carried from before this phase, unaffected by it:

6. **Fix `library:setFields` for first-class columns**, delete the known-gap test. *(AAR-M1b D1, M3)*
7. **Measure MusicBrainz burst tolerance** against the real API. *(PRA-M1b §13, M3)*
8. Refresh the row after playback so resume isn't stale. *(AAR-M1 D6, M2)*

---

## 8. What went right

- **Real verification found real bugs a green test suite could not.** Both D1 and D2 are
  structurally invisible to this project's current test shape, and both were found within
  minutes of actually launching the app — the exact bet the handoff to this session made.
- **The repeats gate did its job on code written in the same sitting**, not just on inherited
  code — the standing rule holds regardless of how fresh the test is.
- **Knowing when *not* to reuse a mechanism.** D5 could have been built as directed — reuse
  single-flight — and it would have worked, just with unneeded machinery guarding a race that
  cannot happen. Recognising that and saying so in the code is the same discipline as reusing
  M1b's `Pool` for the probe pool: one module for a shared problem, no module for a problem that
  doesn't exist.
- **A design trade-off was surfaced and decided before being built, not after.** D6's
  simplification was proposed, its cost named, and approved — rather than silently shipped and
  explained afterward.
- **The pre-phase planner correction (§4 C1) held exactly as designed.** The MKV+H.264+AC-3
  fixture in `plan.test.ts` exists because the PRA caught the single-enum trap before any code
  existed; building it the other way and finding the bug later would have cost far more than
  writing the fixture did.

# Que — Open Actions

Every action carried out of an after-action review, in one place, with its current state.

**Why this exists.** AARs are point-in-time records and are never edited, so an action closed
three milestones after it was raised leaves no trace in the document that raised it. The PRA's
Inputs section gathers open items from *the previous* AAR — which silently loses anything
deferred twice. This is the mutable index; the AARs remain the frozen account of why each item
exists.

Updated at step 6 of every phase ([PROCESS.md](PROCESS.md)). An action is only removed from
this table when it is **done** and has been done for a full milestone; until then it stays,
struck through, so the closing is visible.

---

## Open

| # | Action | Raised | Owner phase | Notes |
|---|---|---|---|---|
| 4 | **Refresh the row after playback so resume isn't stale.** | AAR-M1 D6 | M2 | Progress writes don't emit `library:changed`, so reopening immediately resumes from the previous session's position. Folds into M2's library view. |
| 5 | **Fix `library:setFields` for first-class columns**, and delete the known-gap test in `tests/ipc-roundtrip.test.ts`. | AAR-M1b D1 | M3 | ARCHITECTURE §6 documents the channel as "first-class + custom"; the handler writes everything to `media_fields`, where the real column shadows it. M3 owns which columns are editable. |
| 6 | **Measure MusicBrainz burst tolerance** against the real API and set the token bucket from data. | PRA-M1b §13 | M3 | Documented limit is an average of 1 req/s. Bucket is currently the conservative 1. |
| 8 | **Get or synthesize a real HEVC/AC-3 sample and re-measure transcode timing.** | AAR-M1c §3 | soon, before real 4K/HEVC use | PRA-M1c §3 M-3's 36× figure is a proxy on a cheap 720p H.264 source. The reference library remains 100% H.264+Vorbis MKV — the load-bearing unknown in the whole M1c design is still unmeasured. |
| 9 | **Stress-test the shared concurrency budget** under a real simultaneous scan + transcode. | AAR-M1c §3 | soon | Unit-tested in isolation (`scanner.test.ts`); never observed whether it actually prevents stutter on real hardware under real load. |
| 10 | **Move the segment cache size cap to Settings UI**, add a "clear transcode cache" action. | PRA-M1c §9 | M11 | Currently a hardcoded 5 GB constant (`DEFAULT_CACHE_CAP_BYTES`), deliberately deferred — no Settings UI existed to put it in yet. |
| 11 | **Switch the dev machine off Node 25** to 24 LTS or 26+. | AAR-M1c P4 | immediate, environment | Discovered mid-M1c: this machine runs Node 25.2.1, past its 2026-06-01 EOL and outside `package.json`'s declared `engines`. Every gate in M1b's Windows verification and all of M1c ran on it anyway, since `npm install` only warns. Not a code defect. |
| 12 | **Write an adversarial test for "a segment is never listed before ffmpeg closes it."** | AAR-M1c §1, item 11h | M1c follow-up | Relies entirely on ffmpeg's own guarantee plus one clean real-run observation; no test forces the actual race (reading the playlist mid-write). |

## Recently closed

| Action | Raised | Closed | How |
|---|---|---|---|
| ~~Size the M1c transcode pool against the probe pool~~ | AAR-M1b §5 | M1c | `src/main/transcode/budget.ts`'s `ConcurrencyBudget` plus a new `Pool.resize()` — a transcode reserves cores first, the probe pool resizes to what's left. |
| ~~Fold the ffmpeg-path fix into M1c~~ | AAR-M1b D6 | M1c | `ffmpeg.ts` no longer imports `electron`; search roots are injected by `main/index.ts`. Fixing this also surfaced and fixed AAR-M1c D3 — three real-media probe tests had been silently skipping on Windows since M1. |
| ~~Re-run the benchmark against a real library~~ | AAR-M1b §3 | M1c (handoff session) | Done: 369 real MKV files, 28 cores. 53.04 ms/file serial -> 9.34 at pool 8, **5.68×**, 20k projection **3.1 min**. Real-media serial cost is *above* the 43.5 ms/file baseline from generated clips, confirming AAR-M1b §5's prediction that generated clips understate real probe cost. |
| ~~A remote + CI actually running~~ | AAR-M0 P2 | M1b+ | `.github/workflows/check.yml` live on push. Carried for four milestones; it caught a real defect on its first run (below). |
| ~~Run `npm run bench` on the Windows machine~~ | AAR-M1b §3 | M1b+ | Done: 240 files, 28 cores. 46.72 ms/file serial -> 15.25 at pool 16, **3.06×**, 20k projection **5.1 min**. Against AAR-M1's 15.6 min baseline that is a real win; against PRA-M1b's 2-3 min prediction it is a **miss**, and the reason is now understood (ASSUMPTIONS H1). |
| ~~Gates run against a partial tree~~ | CI, first run | M1b+ | `eslint .` passed locally and failed in CI: the working copy was missing `docs/sanity-tests/` entirely. Fixed by scoping those files out of lint (they are frozen records nothing imports) and by adding a tree-parity check to PROCESS.md §4. |
| ~~Bounded concurrency pool as a shared utility~~ | AAR-M1 D3 | M1b | `src/main/concurrency/`, used by the scanner now and by providers in M3. |
| ~~IPC handler round-trip tests~~ | AAR-M1 P1 | M1b | 28 tests through `createDispatch`; found AAR-M1b D1 and D5 on their first outing. |
| ~~State the one-definition-per-wire-shape rule in ARCHITECTURE~~ | AAR-M1 D1 | M1b | ARCHITECTURE §6. |

## Accepted, not scheduled

| Item | Raised | Why it is not an action |
|---|---|---|
| Progress timer runs while paused | AAR-M1 D7 | One wasted query per 5 seconds on a paused player. Noted, measured, not worth a patch. |
| **Reduce main-thread work per scanned file** — nice to have, production polish | ASSUMPTIONS H1 | **The measurement is sharp; the problem is not.** Past pool ~2 the single JS main thread binds at 15.25 ms/file — 6.15 stage A plus 9.10 of parent-side probe cost (spawn, pipe, JSON parse). Halving it would take a 20,000-file cold scan from ~5.1 min to ~2.5. But that scan happens **once**, and rescans skip unchanged files entirely, so the user-visible saving is two and a half minutes on first run. The cost is a `worker_thread` refactor or a batched-ffprobe redesign — both in the subsystem that has already produced two silent data-loss bugs (AAR-M1 D-a, D-b). A sharp finding is not the same as a problem worth fixing. Revisit only if scan time becomes an actual complaint; the candidate levers and the numbers are recorded in ASSUMPTIONS H1 so the work starts from evidence rather than from scratch. |

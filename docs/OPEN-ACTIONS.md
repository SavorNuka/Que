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
| 10 | **Move the segment cache size cap to Settings UI**, add a "clear transcode cache" action. | PRA-M1c §9 | M11 | Currently a hardcoded 5 GB constant (`DEFAULT_CACHE_CAP_BYTES`), deliberately deferred — no Settings UI existed to put it in yet. |

## Recently closed

| Action | Raised | Closed | How |
|---|---|---|---|
| ~~Get or synthesize a real HEVC/AC-3 sample and re-measure transcode timing~~ | AAR-M1c §3 | post-M1c | Found real content already in the library: House of the Dragon (HEVC, 1080p, MP4) and several Ghibli films (HEVC, 1080p, MKV), plus Chicken Little (mpeg4+AC-3, AVI — needs all three fixes at once). Measured: real 1080p HEVC transcodes at **1.1–1.4× realtime**, not the 36× the 720p H.264 proxy suggested — a ~30× gap. ASSUMPTIONS H4. |
| ~~Stress-test the shared concurrency budget under a real simultaneous scan + transcode~~ | AAR-M1c §3 | post-M1c | Real test, not simulated: fired on the first try — a real concurrent scan slowed a real transcode **3.83×**, and the probe pool never shrank (the reservation was too small to matter on a 28-core machine). The first fix (reserve more cores, use that same number for `-threads`) made it **12.8× worse** — more encoder threads bought nothing alone and cost heavily under contention. Fixed by decoupling: a large reservation shrinks the probe pool, a small fixed `TRANSCODE_ENCODER_THREADS` (4) keeps the encoder stable. Re-measured: **1.26×**. ASSUMPTIONS H5; new test `tests/transcode/budget-stress.test.ts` (gated behind `QUE_STRESS=1`, real media, not part of the normal run). |
| ~~Switch the dev machine off Node 25 to 24 LTS or 26+~~ | AAR-M1c P4 | post-M1c | Node 24.21.0 LTS installed via nvm-windows, and all four gates confirmed clean on it. **Two traps, both paid for — see HANDOFF.md §5.** (1) The pre-existing standalone Node install sits in the **system-level** PATH, which outranks nvm's user-level entries, so a fresh terminal still resolves `node` to 25.2.1 until that is fixed with admin elevation. (2) nvm's `.shim`/`.nodejs` `node.exe` are **736 KB proxies, not real Node** — vitest forks workers via `process.execPath`, and through the proxy the IPC channel never connects, so `tests/renderer/useAsync.test.tsx` **silently did not run at all** (425 tests instead of 428, reported as an "unhandled error" rather than a failure, and the run took 36 minutes instead of 23 seconds on worker-spawn retries). Always point PATH at the real binary directory, `…/nvm/installs/v24.21.0`. |
| ~~Write an adversarial test for "a segment is never listed before ffmpeg closes it"~~ | AAR-M1c §1, item 11h | post-M1c | `tests/transcode/playlist-readiness.test.ts` — forces the actual race with a paced (`-re`) real ffmpeg run and a tight poll loop. Zero violations found, closing the coverage gap AAR-M1c recorded honestly rather than claiming tested. Building it also found and fixed a real production bug: `-hls_time` was never actually honored for a real transcode (x264's default keyframe interval is longer than the target segment length), so real segments ran far longer than intended. Fixed with `-force_key_frames` in `plan.ts`. |
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

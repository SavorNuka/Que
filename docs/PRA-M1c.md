# Pre-phase Risk & Integration Assessment — M1c (HLS transcode)

Written 2026-09-13, after M1b (`681e0d8`) and the handoff to Claude Code on Windows, before any
M1c code exists. First assessment run partly on the target machine rather than the cloud
container — see §3, which is real ffmpeg output against real files, not a model.

**Headline finding — the brief's `remux_reason` model cannot drive the transcode command.**
`needs_remux`/`remux_reason` is a single enum: `container` | `video-codec` | `audio-codec`.
ARCHITECTURE §2.1 itself names the common real case as **MKV + H.264 + AC-3** — a file that
needs a container remux *and* an audio transcode at once. A planner that branches on the single
reason handles only one of the two and ships a file that still won't play. §4 C1 fixes this
before it is built; the fix is free because `media.container/video_codec/audio_codec` already
carry everything needed.

**Second finding.** Container-only remux, which the sampled real library is 100% of, is not a
throttled or on-demand operation in any meaningful sense — measured at **1250× realtime**
(§3, M-1). The "on-demand" framing in the brief is correct for genuine video transcode, whose
cost is unmeasured on real HEVC content because none exists in the reference library (§3, M-4,
open question). Building one progressive-generation pipeline that serves both cases (§5.2)
avoids having to guess which one a given file needs before deciding the mechanism.

---

## 1. Inputs

| Source | Items carried in |
|---|---|
| [HANDOFF.md](HANDOFF.md) §4, §6 | Verify `fetch-ffmpeg.mjs`/`bench.mjs` on Windows (done, this session) · re-run the benchmark against a real library (done, this session, §3) · M1c scope and carried actions |
| [AAR-M1b](AAR-M1b.md) D6 | `probeFile` cannot run outside Electron — `ffmpeg.ts` resolves its binary via `app.getAppPath()`. Open, owned by this phase. |
| [AAR-M1b](AAR-M1b.md) §5 | Transcode pool must be sized against the probe pool, not independently, or a scan during playback starves the player. |
| [OPEN-ACTIONS.md](OPEN-ACTIONS.md) | #2 (pool sizing), #3 (ffmpeg.ts testability), #7 (real-library benchmark — closed by this session, §3) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | §2.1/§8 playback design · §10.5 concurrency utility · §22 M1c scope statement · §23 restrictions |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) A2 | HLS over `http://127.0.0.1`, one code path for local + LAN, MKV+H.264+AC-3 named as the common case |
| `src/main/library/probe.ts` | `needsRemux`/`remuxReason` derivation — single enum, container checked first (§4 C1) |
| `src/main/server/server.ts` | Current `needs_remux` path returns 415 with a message pointing at "M1b" — stale, corrected by this phase (§9 item 12) |
| `src/main/concurrency/` (M1b) | `Pool`, `RateGate`, clock injection — the utility this phase must reuse, not duplicate (AAR-M1 §4 rule) |
| `src/main/idempotency/single-flight.ts` (M1b) | Built for provider calls; §5.7 reuses it for a different purpose — two players requesting the same transcode job |

**Architecture sections this phase modifies:** §8 (concrete HLS route surface, cache location),
§22 (M1c row, as-built), §2.1/§10.5 (shared concurrency budget note).
**Sections it must not disturb:** §23 — restriction enforcement stays in the query layer, and the
new HLS routes must carry the same guard as `/stream/<id>`.

---

## 2. What changed since the plan was written

1. **The probe pool now has a real number to size against.** Step 4 of the handoff measured
   9.34 ms/file at pool 8 on real media (§3, M-0) — this phase's budget math (§5.4) has an actual
   probe cost to share cores against, not the 2-second-clip estimate M1b shipped with.
2. **`ffmpeg.ts`/`ffprobe.ts` are proven to work on Windows** (§3) — the handoff's top concern,
   that Windows-only code had never executed, is resolved for the probe half. The transcode half
   is new code and gets the same treatment before this phase closes (§10).
3. **The reference library has no HEVC or AC-3 sample.** ARCHITECTURE A2 names HEVC/AC-3 as the
   codecs that actually need help; the entire sampled library (369 files) is H.264 + Vorbis in
   MKV, which is container-only. The "expensive path" numbers in §3 are therefore extrapolated
   from a cheap source, not measured on the case that matters most — recorded as an open question
   (§11) rather than papered over.

---

## 3. Measured facts

Produced against real files on the Windows target machine, not a model or a generated clip —
this is the first PRA in the project to do so. `resources/bin/ffmpeg.exe`/`ffprobe.exe`,
369 real `.mkv` files under `D:\Media\Video\TV Shows\Bleach` (h264 + vorbis, MKV container,
embedded `ass` subtitles and font attachments in most files). Reproducible with any file from
that set; commands are plain `ffmpeg`/`ffprobe` invocations, not project code, since no
transcode code exists yet.

**M-0 · Cold-scan benchmark, real library (closes OPEN-ACTIONS #7)**

| pool | total | per file | speed-up | 20k projection |
|---|---|---|---|---|
| 1 | 19570 ms | 53.04 ms | 1.00× | 17.7 min |
| 2 | 6623 ms | 17.95 ms | 2.95× | 6.0 min |
| 4 | 3802 ms | 10.30 ms | 5.15× | 3.4 min |
| 8 | 3446 ms | **9.34 ms** | 5.68× | 3.1 min |

Best at pool 8: 5.68× serial, 83% of the 6.83× Amdahl ceiling (28 cores). Real-media serial cost,
**53.04 ms/file**, is *above* AAR-M1 D3's 43.50 ms/file baseline from 2-second generated clips —
confirming AAR-M1b §5's prediction that generated clips understate real probe cost. This is the
number §5.4's shared budget is sized against.

**M-1 · Container-only remux (the common real case: MKV, H.264, Vorbis)**

One 24m01s episode (`Bleach 204.mkv`), `-map 0:v:0 -map 0:a:0 -c:v copy -c:a copy -f hls`:

| | |
|---|---|
| Wall time | **1155 ms** |
| Speed | **~1250× realtime** |
| Output | 240 segments, valid VOD `.m3u8`, playlist and segment durations consistent |

Stream copy is close to free. A 2-hour film would remux in an estimated ~4-5 seconds. This is
the case ARCHITECTURE calls "cheap," and the number confirms it is not a figure of speech.

**M-2 · Audio-only transcode (video copy, audio → AAC)**

Same file, `-c:v copy -c:a aac -b:a 192k -f hls`:

| | |
|---|---|
| Wall time | 34.3 s |
| Speed | **~42× realtime** |

Comfortably fast enough to run to completion before a user notices, even for a 2-hour file
(~3 minutes worst case, and this starts overlapping with playback immediately — see §5.2).

**M-3 · Full video transcode (720p H.264 source → H.264 `veryfast`/CRF 20 + AAC)**

Same file, `-c:v libx264 -preset veryfast -crf 20 -c:a aac -f hls`:

| | |
|---|---|
| Wall time | 39.9 s |
| Speed | **~36× realtime** |

Faster than expected on this hardware (28 cores, x264 auto-threads). **This number must not be
generalised**: the source here is 1280×688 H.264, which is cheap to decode and cheap to
re-encode. It says nothing about a 4K HEVC source, which is the case that actually needs a
software transcode path (ASSUMPTIONS A2: HEVC decodes in hardware on capable GPUs, but has *no
software fallback* — the file that reaches this code path either has no GPU decode available, or
has an unsupported audio/container on top of HEVC). See §11.

**M-4 · What the codec survey did not find**

12 files sampled at random plus the full scan above: every file is H.264 + Vorbis in an MKV
container, several with embedded `ass` subtitle streams and font attachments (which a transcode
command must exclude via explicit `-map`, or ffmpeg will try to mux subtitle/attachment streams
into the HLS output and fail). **No HEVC, no AC-3, no DTS sample exists in the reference
library.** M-2 and M-3 are the closest available proxies for the audio-codec and video-codec
paths respectively, not a measurement of them.

---

## 4. Corrections to the brief

**C1 — The transcode plan is per-stream, computed fresh, not read off `remux_reason`.**
`needs_remux`/`remux_reason` (`src/main/library/probe.ts`) is a single enum with container
checked first: a file gets exactly one reason, even when more than one is true. ARCHITECTURE
§2.1's own worked example — MKV + H.264 + AC-3 — needs a container remux *and* an audio
transcode simultaneously; as currently derived, that file's `remux_reason` is `'container'` and
a planner that reads only that field would copy the AC-3 audio into an HLS container Chromium
still can't decode. The fix costs nothing new: `media.container`, `media.video_codec` and
`media.audio_codec` are already columns. The transcode planner (§5.1) re-derives three
independent yes/no answers from those three columns — container playable, video playable, audio
playable — and builds the `-map`/`-c:v`/`-c:a` arguments from all three, never from the single
enum. `remux_reason` stays as-is for the UI ("why can't this play directly"), it just stops being
an input to the ffmpeg command.

**C2 — "On-demand" describes the mechanism, not a throttle that applies equally to every file.**
The brief's phrase invites picturing a slow, metered generation. M-1 shows container-only remux
finishing in ~1 second for a 24-minute file — indistinguishable from instant at the point a
player would need it. Building a mechanism that assumes slowness (heavy pre-buffering, aggressive
rate limiting on segment generation) would add latency to the case that is actually free. §5.2's
single pipeline handles both without a fork in the code: it always starts generating immediately
and serves the playlist as it grows, so a remux converges to "fully generated" in about a second
and a real transcode converges over tens of seconds to minutes — same mechanism, different
convergence time, no special-casing required.

---

## 5. Design

### 5.1 Transcode planning — per stream, pure, tested

A pure function `(container, videoCodec, audioCodec, ext) → Plan`, reusing the same playable-set
constants `probe.ts` already has (`PLAYABLE_CONTAINERS`, `PLAYABLE_VIDEO`, `PLAYABLE_AUDIO`).
Output: `{ remuxContainer: boolean, transcodeVideo: boolean, transcodeAudio: boolean }`. All three
are independent (C1). The command builder maps this to ffmpeg arguments:

- container only → `-map 0:v:0 -map 0:a:0 -c:v copy -c:a copy -f hls`
- + audio transcode → `-c:a aac -b:a 192k` in place of `-c:a copy`
- + video transcode → `-c:v libx264 -preset veryfast -crf 20` in place of `-c:v copy`

`-map 0:v:0 -map 0:a:0` is mandatory, not cosmetic: M-4 shows real files carry subtitle and
attachment streams that the HLS muxer cannot pass through, and an unqualified `-map 0` fails on
most of the sampled library.

### 5.2 One progressive-generation pipeline, remux and transcode alike

ffmpeg starts writing segments immediately; the server serves the `.m3u8` as ffmpeg extends it,
not after ffmpeg exits. This is the standard shape (`hls_playlist_type event` while running,
finalised to `vod` on exit) and is what lets a remux "complete before anyone notices" (M-1) and a
real transcode "start playing at second 6 instead of after the whole file finishes" — both are
the same code path, differing only in how fast the tail catches up to the encoder.

**Correctness detail that matters:** the server must treat a segment as ready only once ffmpeg's
own `.m3u8` lists it, never by polling the segment directory. ffmpeg opens a segment file before
it is fully written (M-1's log output shows this), so a directory listing can name a file that is
still being appended to; the playlist is only extended once a segment is closed. Reading the
playlist as the source of truth is free — it costs nothing beyond what the mechanism already
needs — and it is the one thing that must not be gotten wrong (R1).

### 5.3 Seeking — restart with a discontinuity, not a fresh file

A seek inside the already-generated range is free (HLS, addressed by segment). A seek past the
frontier kills the in-flight ffmpeg process for that job and starts a new one with `-ss <target>`,
appending new segments to the same playlist behind an `#EXT-X-DISCONTINUITY` tag rather than
starting a new playlist. Per M-1/M-2/M-3, the wait this produces is proportional to the file's
transcode cost: near-zero for a remux-only file, up to several seconds for a real video-codec
transcode. This is expected and is what ARCHITECTURE A2 means by "seeking is exact by
construction" — exact, not necessarily instant, for the expensive case.

### 5.4 Shared concurrency budget — probe pool and transcode compete for the same cores

AAR-M1b §5's warning is concrete now that both sides have real numbers: probing costs
9.34 ms/file at pool 8 (M-0); a single video-codec transcode is a multi-threaded `libx264` process
that auto-claims most of the visible core count on its own (M-3 ran on 28 cores without any
`-threads` cap). Run both at once with no coordination and each starves the other.

Mechanism: a process-wide budget object, seeded with `availableParallelism()`. A transcode job
reserves cores from it **before** starting ffmpeg (transcode is foreground, user-waiting work —
it gets priority) and passes the reservation to ffmpeg as `-threads N`. The probe pool asks the
budget for its ceiling each time it has a free worker, rather than fixing its size once at scan
start, so a scan that begins before playback starts still yields cores once a transcode reserves
them. **This requires `Pool` to support resizing an already-running pool** — a new capability on
the shared M1b/M1c utility, not a duplicate one (AAR-M1 §4's rule holds: one module, two
importers, even when the second importer needs it to do something the first didn't).

### 5.5 Segment cache

`userData/transcode/<mediaId>-<fingerprint>/`, where `fingerprint` is `size_bytes:mtime_ms` —
cheap, already on the row, and it invalidates automatically the moment a rescan sees the file
change (a replaced or re-encoded file gets a fresh cache directory; the stale one is deleted
rather than served).

No provider_cache-style TTL policy applies here — video bytes don't go stale the way a metadata
answer does. What bounds it is size: a single fully-generated 24-minute episode's HLS copy is
tens to ~90 MB per the M-1/M-2/M-3 output sizes, so a library-sized cache is a real disk-space
question. LRU eviction by directory mtime against a fixed cap is enough for this phase; making
the cap user-configurable is Settings UI work this phase does not include (§9, out of scope).

### 5.6 Process lifecycle

A registry of active transcode child processes, keyed by job id (media id + fingerprint). Killed
on: app quit (no orphaned encoders after the window closes); an idle timeout with no segment
requests for N seconds (nobody is watching — matches the existing rule against leaking a socket
that connects and says nothing, `server.ts`'s `headersTimeout`); and explicitly, when a new seek
supersedes the job (§5.3).

### 5.7 Single-flight, reused from M1b for a second purpose

Two requests for the same `(mediaId, fingerprint)` job — a second tab, a second device once M9
exists, or the player's own retry after a transient network blip — must share one ffmpeg process,
not start two. `src/main/idempotency/single-flight.ts` already implements exactly this shape
(cache check + in-flight check before any `await`, `finally`-cleared) for provider calls; this
phase is the first evidence that the mechanism generalises past "network request," which is worth
recording in ARCHITECTURE §10.5 once it ships.

### 5.8 HTTP surface

`GET /hls/<id>/playlist.m3u8` and `GET /hls/<id>/segments/<name>`, added to `MediaServer` next to
the existing `/stream/<id>` route. Both carry the **same** two guards `/stream/<id>` already has:
token auth (`authorised()`) and the restriction clauses (`mediaClauses()`, via the same `resolve()`
path). This is the §23 invariant carried forward, and it needs the same kind of dedicated test
PRA-M1b's R5 added for the provider cache: a hidden row's HLS endpoints refuse even once its
segments are already generated and sitting on disk (§9 item 11b) — a warm cache must not become a
way around the query-layer guard.

`server.ts`'s current `needs_remux → 415` branch is replaced: instead of a fixed error, it
redirects the caller to the HLS endpoints (or the renderer, informed via `MediaDetail`, requests
the HLS URL directly rather than the direct-play one — see §5.10).

### 5.9 `ffmpeg.ts` becomes testable outside Electron (closes AAR-M1b D6 / OPEN-ACTIONS #3)

`candidates()` currently calls `app.getAppPath()` unconditionally when building its search list,
which throws outside a running Electron app — the reason the benchmark had to reimplement probe
binary resolution rather than import it. Fix: the search roots become a parameter with a default
supplied by the Electron-aware caller (`src/main/index.ts`), so `ffmpeg.ts` itself imports nothing
from `electron` and both `probeFile` and the new transcode-spawn function share one fixture-driven
test suite. This phase touches the module anyway (adding the transcode spawn call next to probe),
which is why AAR-M1b carried the fix here rather than doing it standalone.

### 5.10 Player fallback path (renderer)

`MediaDetail` already carries `needsRemux`/`remuxReason` (§2.1). The player checks it once, before
setting `<video>`'s source: direct-play files get the existing `http://127.0.0.1:.../stream/<id>`
URL; anything needing help gets `hls.js` attached to the new `/hls/<id>/playlist.m3u8` endpoint
instead. No change to state shape (`docs/ARCHITECTURE.md §8`'s `{ mediaId, playing, positionMs,
… }` store) — HLS vs. direct is a source-URL decision, not a new state field.

---

## 6. Plan-wide integration

| Milestone | What M1c gives it | What it constrains | Cost of deferring |
|---|---|---|---|
| **M1c itself** | every MKV/HEVC file in the library becomes playable instead of a 415 | — | the AAR-M1 415 response is the only thing standing in for this today |
| **M2 library view** | none | none | none |
| **M3–M8** | none directly | none | none |
| **M9 LAN server** | the HLS routes and the process registry are already process-wide, not per-window, so a phone on the network reaches the same jobs and cache the app window does | single-flight (§5.7) must key on `(mediaId, fingerprint)` only, never on which client asked, or two devices playing the same file double the encode cost | N devices × N transcodes of the same file, the exact failure shape M1b's single-flight was built to prevent for providers |
| **M10 skins / M11 polish** | a bounded, self-evicting cache needs no skin-layer awareness; a future "clear cache" setting (M11) has one directory to point at | — | — |

**Interaction with §23 (hiding / age limits).** Same invariant as PRA-M1b §6: restrictions are
enforced in the query layer, never against cached bytes. A stale or wrong cache entry may serve
wrong video; it must never let a hidden row become streamable. Explicit test, §9 item 11b.

---

## 7. Risk register

| ID | Risk | Sev | Detection | Mitigation |
|---|---|---|---|---|
| **R1** | A segment is served while ffmpeg is still writing it, and the player gets a truncated/corrupt chunk | high | dedicated test: read the playlist mid-generation, assert every listed segment is fully closed | server treats ffmpeg's own `.m3u8` as the sole readiness signal, never the directory listing (§5.2) |
| **R2** | Two players (or a retry) request the same file and start two ffmpeg processes | medium | test: two concurrent requests for one `(id, fingerprint)` yield one child process | single-flight keyed on `(mediaId, fingerprint)`, reused from M1b (§5.7) |
| **R3** | Segment cache grows without bound and fills the disk | medium | manual: play enough distinct files to exceed the cap, confirm eviction | size-capped LRU by directory mtime under `userData/transcode/` (§5.5) |
| **R4** | HLS endpoints become a path around §23 restrictions | high | dedicated test: hidden row + warm segment cache → still refused | same token auth + `mediaClauses()` guard as `/stream/<id>` (§5.8) |
| **R5** | A transcode process outlives its player (app quit, window closed, superseded by a seek) and keeps burning CPU | medium | manual: close the app mid-transcode, confirm no orphaned `ffmpeg.exe` in Task Manager | process registry, killed on quit / idle timeout / seek-supersession (§5.6) |
| **R6** | A concurrent scan and transcode starve each other for cores | high | manual: start a scan, then start a transcode-requiring playback, observe both make forward progress | shared concurrency budget; transcode reserves and passes `-threads N`; probe pool re-checks its ceiling per-worker rather than fixing it at scan start (§5.4) |
| **R7** | The per-stream planner regresses to the single-`remux_reason` shortcut under review pressure and the MKV+H.264+AC-3 case ships half-fixed | high | dedicated test: a container+audio-codec fixture produces a plan with *both* flags set, not one | planner takes `(container, videoCodec, audioCodec)` directly, never `remux_reason`, and is unit-tested against that fixture (§5.1, §4 C1) |
| **R8** | Real HEVC/AC-3 transcode cost is far outside what M-2/M-3 measured, and the "usually fast enough" framing throughout this PRA is wrong for the case that matters most | high | get or synthesize a real HEVC/4K/AC-3 sample before freezing confidence in the design; re-measure | see §10 falsification 1 — this is the load-bearing unknown in this document |

---

## 8. Entry criteria

| Criterion | Status |
|---|---|
| M1 complete — HTTP/Range server live | ✅ |
| M1b complete — `Pool`, single-flight, clock injection available | ✅ |
| `test:concurrency` wired into CI (`check.yml`) | ✅ — added this session |
| ffmpeg/ffprobe verified executing on Windows | ✅ — §3, this session |
| Real-library benchmark, closing OPEN-ACTIONS #7 | ✅ — §3 M-0, this session |
| A real sample of the codecs M1c actually targets (HEVC, AC-3/DTS) | ❌ **unmet — the reference library has none (§3 M-4)** |

One unmet, with a compensating control: build against the per-stream planner (§5.1) and the
progressive pipeline (§5.2), which do not depend on which codec is involved — then verify against
a real HEVC/AC-3 file as the first item of the build phase, before scope is called done (§10
falsification 1). If no such file is available on this machine, ffmpeg can synthesize a HEVC test
clip (`-f lavfi`) as a labelled-synthetic stand-in; that is weaker evidence than a real file and
the AAR must say so explicitly rather than quietly treating it as equivalent.

---

## 9. Frozen scope — M1c

Copied verbatim to `docs/M1c-SCOPE.md`. Not edited during the phase.

1. **Per-stream transcode planner** — pure function over `(container, videoCodec, audioCodec,
   ext)`, independent of `remux_reason`; produces container/video/audio copy-or-transcode flags
   and the ffmpeg argument list. Handles the container+audio-codec double case (§4 C1).
2. **Progressive HLS generation** — one pipeline for remux-only and full-transcode files; server
   reads ffmpeg's own growing `.m3u8` as the readiness signal, never the segment directory (§5.2).
3. **Seek beyond the generated frontier** — kill and restart ffmpeg at the target offset; new
   segments appended behind `#EXT-X-DISCONTINUITY` (§5.3).
4. **Shared concurrency budget** between the probe pool and active transcodes, including the
   `Pool` resize capability this requires (§5.4).
5. **Segment cache** under `userData/transcode/<mediaId>-<fingerprint>/`; fingerprint-based
   invalidation on rescan; size-capped LRU eviction (§5.5).
6. **Process lifecycle** — registry of active transcode children; killed on app quit, idle
   timeout, and seek-supersession (§5.6).
7. **Single-flight** on `(mediaId, fingerprint)`, reusing `src/main/idempotency/single-flight.ts`
   (§5.7).
8. **HTTP surface** — `/hls/<id>/playlist.m3u8`, `/hls/<id>/segments/<name>`, same token auth and
   `mediaClauses()` guard as `/stream/<id>` (§5.8).
9. **`ffmpeg.ts` testable outside Electron** — injected search roots, no unconditional
   `app.getAppPath()` call (§5.9, closes AAR-M1b D6 / OPEN-ACTIONS #3).
10. **Renderer fallback** — player attaches `hls.js` to the HLS endpoint when `needsRemux` is
    true, direct URL otherwise (§5.10).
11. **Tests**, each with a verified negative control where it guards something:
    a. a container+audio-codec fixture produces a plan with both flags set (R7)
    b. a hidden row's HLS endpoints refuse even with a warm segment cache (R4)
    c. two concurrent requests for the same `(id, fingerprint)` collapse to one ffmpeg process (R2)
    d. a seek past the frontier kills the old process; new segments carry a discontinuity tag
    e. an idle job is killed after its timeout and leaves no running process (R5)
    f. a rescan that changes a file's fingerprint invalidates its cached segments
    g. the probe pool's effective size shrinks while a transcode holds the budget and recovers
       once it releases (R6)
    h. a segment is never listed in the served playlist before ffmpeg has closed it (R1)
12. **ARCHITECTURE / living-doc updates** — §8 gains the concrete HLS route surface and cache
    location; §22 M1c row marked delivered with what shipped; §2.1/§10.5 note the shared
    concurrency budget; `server.ts`'s stale "arrives in M1b" message is corrected or removed.

**Explicitly out of scope:** LAN-specific hardening beyond reusing the existing auth/restriction
guard (full LAN work is M9) · a Settings UI for the cache size cap (hardcoded constant this
phase) · subtitle burn-in or any subtitle handling inside the transcode (subtitles remain a
separate `TextTrack`, §9 of ARCHITECTURE, untouched by this phase) · multi-quality/adaptive
bitrate HLS (single rendition only — this is a compatibility fallback, not a quality feature) ·
background or predictive pre-transcoding of a library.

### Exit criteria

- Typecheck clean, lint clean, all tests passing, concurrency tests passing under `--repeat=20`.
- A real container-only file (from the reference library) plays end-to-end via HLS in the actual
  packaged/dev Electron renderer, manually verified — not just a unit test of the pipeline.
- A real or, failing that, synthesized HEVC/AC-3 file plays end-to-end via HLS, manually verified,
  with the synthetic case labelled as weaker evidence in the AAR if a real sample could not be
  found (§8).
- The shared-budget mechanism observed, manually, not to starve a concurrent scan or a concurrent
  transcode on this machine (R6) — this is real-media-and-real-playback territory per the
  handoff's own warning, not a deterministic gate.

---

## 10. Falsification

Written now, while it is still cheap to be honest.

1. **Real HEVC/AC-3 transcode timing, once measured, is under ~2× realtime.** M-3's 36× is
   measured on a cheap 720p H.264 source and must not be trusted for the case M1c actually exists
   for. If real timing is much worse, "start ffmpeg and let it catch up" (§5.2) stops being a safe
   default for video-codec files: it needs an explicit pre-buffer target before the player is told
   playback can start, and the shared-budget design (§5.4) may need a hard cap of one concurrent
   transcode rather than a soft reservation.
2. **The shared concurrency budget does not actually protect playback.** If a manual test shows a
   scan visibly stuttering an active transcode (or vice versa) despite §5.4, the mitigation is
   wrong, not just mistuned — the honest fallback is pausing the scanner outright while any
   transcode is active, which is cruder but correct, and is a decision to make explicitly rather
   than a bug to leave in.
3. **Killing and restarting ffmpeg on seek leaves a dangling process or a corrupt segment more
   than rarely.** If R1/R5's mitigations do not hold up under repeated real seeking, the fix is
   not "handle it more carefully in the same shape" — it likely means the job needs an explicit
   completion marker (mirroring M1b's per-row transactional apply, §5.6 of PRA-M1b) rather than
   trusting process exit and ffmpeg's own file-close ordering.
4. **`hls.js` cannot play a plain `ffmpeg -f hls` MPEG-TS VOD playlist inside the Electron
   renderer.** This is the one link in ASSUMPTIONS A2's chain that has never actually run. If it
   fails, the whole "seeking is exact by construction" claim needs a different segment format
   (`-hls_segment_type fmp4`) or a different player before scope can be called done — not a patch
   on top of the current one.

---

## 11. Open questions for the AAR

Not blockers; record answers when known.

- What is the real transcode-vs-realtime ratio for 4K HEVC on this machine? M-3 is a proxy at
  best (§3 M-4, §8).
- Is a hard cap of one concurrent transcode enough for this phase, or does it need to allow two
  before M9 makes "two devices, two files" a real scenario?
- What segment-cache size cap is actually right against a real library's viewing pattern, and
  should it move from a hardcoded constant to a Settings UI value sooner than M11?
- Does the idle-timeout kill (§5.6) fight with `hls.js`'s normal quiet periods between segment
  fetches? The right timeout value needs tuning against real request traces, not a guess.

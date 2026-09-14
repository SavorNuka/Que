# M1c — Frozen Scope

Frozen 2026-09-13 from [PRA-M1c.md](PRA-M1c.md) §9. **Not edited during the phase.**
AAR-M1c checks the output against this list line by line.

**M1c is on-demand HLS remux/transcode for MKV and HEVC, a segment cache, and the player
fallback path.** It owns OPEN-ACTIONS #2 and #3.

---

## In scope

| # | Item |
|---|---|
| 1 | **Per-stream transcode planner** — pure function over `(container, videoCodec, audioCodec, ext)`, independent of the single `remux_reason` enum; produces container/video/audio copy-or-transcode flags and the ffmpeg argument list. Handles the container+audio-codec double case (PRA-M1c §4 C1) — e.g. MKV + H.264 + AC-3 needs both a container remux and an audio transcode at once. |
| 2 | **Progressive HLS generation** — one pipeline for remux-only and full-transcode files alike; server reads ffmpeg's own growing `.m3u8` as the readiness signal, never the segment directory. |
| 3 | **Seek beyond the generated frontier** — kill and restart ffmpeg at the target offset; new segments appended behind `#EXT-X-DISCONTINUITY`. |
| 4 | **Shared concurrency budget** between the probe pool and active transcodes, including the `Pool` resize capability this requires in `src/main/concurrency/pool.ts`. |
| 5 | **Segment cache** under `userData/transcode/<mediaId>-<fingerprint>/`; fingerprint (`size_bytes:mtime_ms`) invalidation on rescan; size-capped LRU eviction. |
| 6 | **Process lifecycle** — registry of active transcode child processes; killed on app quit, idle timeout, and seek-supersession. |
| 7 | **Single-flight** on `(mediaId, fingerprint)`, reusing `src/main/idempotency/single-flight.ts` rather than a new mechanism. |
| 8 | **HTTP surface** — `/hls/<id>/playlist.m3u8`, `/hls/<id>/segments/<name>`, same token auth and `mediaClauses()` guard as `/stream/<id>`. |
| 9 | **`ffmpeg.ts` testable outside Electron** — injected search roots, no unconditional `app.getAppPath()` call (closes AAR-M1b D6 / OPEN-ACTIONS #3). |
| 10 | **Renderer fallback** — player attaches `hls.js` to the HLS endpoint when `needsRemux` is true, direct URL otherwise. No new state-shape field. |
| 11 | **Tests**, each with a verified negative control where it guards something: (a) a container+audio-codec fixture produces a plan with both flags set · (b) a hidden row's HLS endpoints refuse even with a warm segment cache · (c) two concurrent requests for the same `(id, fingerprint)` collapse to one ffmpeg process · (d) a seek past the frontier kills the old process and new segments carry a discontinuity tag · (e) an idle job is killed after its timeout and leaves no running process · (f) a rescan that changes a file's fingerprint invalidates its cached segments · (g) the probe pool's effective size shrinks while a transcode holds the budget and recovers once it releases · (h) a segment is never listed in the served playlist before ffmpeg has closed it |
| 12 | **ARCHITECTURE / living-doc updates** — §8 gains the concrete HLS route surface and cache location · §22 M1c row marked delivered with what shipped · §2.1/§10.5 note the shared concurrency budget · `server.ts`'s stale "arrives in M1b" message corrected or removed. |

## Out of scope

LAN-specific hardening beyond reusing the existing auth/restriction guard (full LAN work is M9)
· a Settings UI for the cache size cap (hardcoded constant this phase) · subtitle burn-in or any
subtitle handling inside the transcode (subtitles remain a separate `TextTrack`, ARCHITECTURE §9,
untouched by this phase) · multi-quality/adaptive bitrate HLS (single rendition only — a
compatibility fallback, not a quality feature) · background or predictive pre-transcoding of a
library.

---

## Entry actions

1. `git add -A && git commit` the pending M1b/handoff tree (Windows verification of
   `fetch-ffmpeg.mjs`/`bench.mjs`, `test:concurrency` wired into CI, `docs/PRA-M1c.md`, this
   file). M1c must not start on an uncommitted tree — same rule PRA-M1b §10 established for M1b.
2. Verify a real HEVC/AC-3 sample is available, or accept the synthesized-ffmpeg-clip fallback
   and label it as weaker evidence in the AAR (PRA-M1c §8 — the one unmet entry criterion).

## Exit criteria

- Typecheck clean · lint clean · all tests passing · concurrency tests passing under
  `vitest --repeat=20` (compensating control for absent CI, same as M1b).
- A real container-only file (from the reference library) plays end-to-end via HLS in the actual
  packaged/dev Electron renderer, manually verified — not just a unit test of the pipeline.
- A real or, failing that, synthesized HEVC/AC-3 file plays end-to-end via HLS, manually
  verified, with the synthetic case labelled as weaker evidence in the AAR if a real sample could
  not be found.
- The shared-budget mechanism observed, manually, not to starve a concurrent scan or a concurrent
  transcode on this machine (PRA-M1c R6) — real-media-and-real-playback territory, not a
  deterministic gate.

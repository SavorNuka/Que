# Que — Assumptions Register

A living record of every load-bearing assumption in
[ARCHITECTURE.md](ARCHITECTURE.md). Each was tested, not asserted.

Sections A–G are the **pre-implementation** sanity check, run 2026-09-13 before any code
existed. Section H is **what implementation overturned since** — assumptions that survived
the sanity check and did not survive contact with a running system. It grows each milestone;
per [PROCESS.md](PROCESS.md), adding to it is part of closing a phase.

Test scripts are reproducible; method is stated per row.

**Pre-implementation verdict: 19 assumptions checked — 13 confirmed, 4 corrected, 2 wrong.**
The two wrong ones both sit in the playback path and change the design. Nothing
found invalidates the overall architecture.

**Since implementation began: 3 overturned** (§H), one of which changed a measurement we had
been reasoning from for two milestones.

---

## A. Corrections that change the design

### A1. ⛔ WRONG — contentless FTS5 cannot be updated the way §18 describes

**Assumed:** a contentless FTS5 table (`content=''`) with a `reindex(mediaId)` that deletes and re-inserts one row.

**Tested:** `better-sqlite3` 13.0.3 (SQLite **3.53.4**), in-memory.

```
FAIL  contentless FTS5 without contentless_delete: DELETE
      → "cannot DELETE from contentless fts5 table: f1"
PASS  content='' AND contentless_delete=1 together
      → delete + reinsert works
PASS  UPDATE on a contentless_delete table
      → "cannot UPDATE a subset of columns on fts5 contentless-delete table"
PASS  reading a column back from a contentless table
      → title = null
```

**Three corrections:**

1. The table must declare **both** options: `content=''` **and** `contentless_delete=1`. `contentless_delete=1` alone fails with *"requires a contentless table"*; `content=''` alone cannot delete. The doc specifies only `content=''`, so as written the index could never be updated.
2. `UPDATE` is rejected. Reindex is **DELETE then INSERT**, always.
3. **Columns read back as NULL.** Search results cannot be rendered from the FTS table — every query must join back to `media` on `rowid`. §18 implied otherwise.

`contentless_delete=1` needs SQLite ≥ 3.45; we have 3.53.4, so this is safe — but it becomes a documented minimum.

**Performance is not a concern**, which the test also settles:

```
PASS  50k-row contentless FTS
      insert 50k = 136ms · query = 3ms (50 hits) · 200 single-row reindexes = 39ms
PASS  external-content equivalent, for comparison
      insert+rebuild 50k = 126ms · join query = 4ms
```

3 ms at 50,000 rows. The 120 ms debounce in §18 is doing nothing useful — drop it to ~60 ms.

**Why not external-content instead?** It's the more ergonomic option (readable, trigger-synced) but `content='media'` can only mirror one table, and our search document is assembled from `media` + `audio_meta` + `video_meta` + `media_fields` + `groups`. Contentless is the right call; it just has to be declared correctly.

### A2. ⛔ WRONG — fragmented-MP4-over-a-pipe can't seek, and MKV is a bigger problem than codecs

**Assumed:** §2.1/§8 — remux unsupported files with `ffmpeg -c copy -f mp4 -movflags frag_keyframe+empty_moov pipe:1` and stream that through `que://`, restarting ffmpeg with `-ss` on seek.

**Two problems, both fatal as designed:**

1. A fragmented MP4 off a pipe has no index. The browser seeks by **byte offset**, and there is no reliable byte→time mapping for VBR content, so "restart ffmpeg with `-ss`" cannot answer the request the player actually makes. Seeking silently breaks or lands in the wrong place.
2. The research also reframes *why* remuxing is needed. Chromium has **no Matroska demuxer at all** — an `.mkv` doesn't play regardless of codec, including plain H.264+AAC. So remux isn't an edge case for exotic files, it's the common path for a real movie folder.

**Revised codec picture**, from the Electron/Chromium research:

| Input | Status | Action |
|---|---|---|
| MP4 / H.264 / AAC | Native | Direct play |
| WebM / VP9 / Opus | Native | Direct play |
| MP3, FLAC, WAV, Ogg | Native | Direct play |
| **Any `.mkv`** | **No demuxer** | Remux container (`-c copy`, cheap) |
| **HEVC/H.265** | HW decode built into Electron ≥ 22 on Windows; **no software fallback** | Direct play on capable GPUs, transcode otherwise |
| **AC-3 / E-AC-3 / DTS / TrueHD** | Unsupported | Transcode audio → AAC (cheap), copy video |
| AVI / WMV / MPEG-TS | Mostly unsupported | Remux |

The good news: the most common real case is *MKV + H.264 + AC-3*, which needs a container remux plus an audio-only transcode — both cheap.

**Revised design — one streaming path, not two:**

Serve **all** playback over the local HTTP server on `127.0.0.1`, and let the renderer use `<video src="http://127.0.0.1:8723/stream/12">`.

- Real Range/206 handling on a real HTTP server is well-understood and exact.
- For files needing transcode, serve **HLS** (`ffmpeg -f hls`) with `hls.js` in the renderer. Seeking becomes segment-addressed, so it's exact by construction — this is what Jellyfin and Plex do, for this reason.
- The LAN server and the local player become **the same code path**, which removes a whole class of "works locally, broken on the phone" bugs and deletes a module.
- `que://` shrinks to artwork, subtitles, and skin assets — small, no Range needed, which is exactly what a custom protocol is good at.

Cost: the server binds `127.0.0.1` always, even with LAN sharing off. LAN exposure stays gated by bind address plus token, so the security posture is unchanged. Renderer CSP gains `media-src http://127.0.0.1:*`.

This is a simplification, not extra work. It should land in **M1**.

### A3. ⚠️ CORRECTED — `protocol.handle` needs a privilege flag the doc never mentions

Electron's docs are explicit: *"Protocols that use streams (http and stream protocols) should set `stream: true`. The `<video>` and `<audio>` HTML elements expect protocols to buffer their responses by default."*

Even in its reduced role, `que://` must be registered before `app.ready`:

```js
protocol.registerSchemesAsPrivileged([{
  scheme: 'que',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);
```

Omit `stream: true` and media elements buffer whole responses. Omitted from §8 entirely; now a scaffold checklist item.

### A4. ⚠️ CORRECTED — no Visual Studio Build Tools needed, and probably no rebuild either

**Assumed:** README told the user they may need VS Build Tools 2022 and `electron-rebuild`.

**Tested:** `npm view` + inspecting the installed package.

```
better-sqlite3 13.0.3
  dependencies: { node-addon-api: ^8.0.0 }     ← Node-API, not raw V8
  no install script, no prebuild-install
  prebuilds/ ships: win32-x64.node, win32-arm64.node, darwin-*, linux-*
  engines: { node: >=22 }
```

It's a **Node-API module shipping prebuilt binaries via prebuildify**, including `win32-x64`. Node-API is ABI-stable *across Electron versions too*, so the same `.node` loads in Electron without recompilation. Install on a clean Windows box should be a plain `npm install` with no compiler.

`npm run rebuild` stays in the README as a repair step, but the "you'll probably need VS Build Tools" framing was wrong and discouraging. Demote it to troubleshooting.

**Bonus finding:** Node 22 ships `node:sqlite`, and it has FTS5 *with* `contentless_delete` (SQLite 3.51.2, verified). If `better-sqlite3` ever becomes a packaging problem, a zero-native-dependency fallback exists — assuming Electron's Node build exposes the module, which is unverified and experimental. Noted, not adopted.

---

## B. Confirmed — the skin security model holds up under test

This is the one place where being wrong would be *dangerous* rather than inconvenient, so it got a real browser: Chromium 141, two same-origin iframes over real HTTP, one `sandbox="allow-same-origin"` and one unsandboxed control.

```
CONTROL  unsandboxed iframe, three attack vectors      #out = "SVG ANIMATE RAN"
         → inline <script>, img onerror, and SVG <animate onbegin>
           each fired in sequence, the last one winning. All three vectors live.

PASS  sandbox w/o allow-scripts blocks all three       #out = "unbound"
PASS  parent reads sandboxed DOM (hook discovery)      found 2 data-que-* hooks
PASS  parent writes into sandboxed DOM (binding)       #out = "Blade Runner"
PASS  parent-attached listener fires (action engine)   true
PASS  parent-injected <script> does NOT execute        #out unchanged
CONTROL  same injection without sandbox DOES execute   #out = "PARENT-INJECTED SCRIPT RAN"
PASS  CSS still applies inside the frame               rgb(1, 2, 3)
```

Every claim in §14 verified, including the one that actually matters: **a `<script>` the parent injects into the sandboxed document does not run, while the identical injection into an unsandboxed frame does.** That is the defence-in-depth layer holding independently of the sanitizer — if the allowlist is ever bypassed, the browser still refuses to execute.

And the engine still works through the sandbox: read hooks, write bindings, attach listeners, apply CSS. The design is sound as specified.

One note for implementation: the first attempt at this test produced a false pass because the control frame's script never ran, so nothing was proven. Worth remembering when writing the real suite — **a sandbox test without a working positive control proves nothing.** The `skins:validate` suite gets a mandatory control case.

---

## C. Confirmed — SQLite behaviours the data model depends on

All tested against SQLite 3.53.4 via better-sqlite3.

| Assumption | Result |
|---|---|
| `bm25()` with 7 per-column weights ranks title matches first | ✅ `order=1,2` — *Alien* (title) above *Prometheus* (overview) |
| Prefix queries for typeahead (`"prome"*`) | ✅ |
| `porter unicode61 remove_diacritics 2` tokenizer | ✅ "amelie" matches *Amélie*; "run" matches "running" |
| Raw user input breaks FTS if unquoted | ✅ `alien OR (NEAR` → *"fts5: syntax error"* — quoting is mandatory, not stylistic |
| Quoting neutralises it | ✅ same input, no error |
| Row-value tuple comparison `(a,b) > (?,?)` for keyset pagination | ✅ supported; page 1 `[1,4]`, page 2 `[3,2]`, no overlap with duplicate sort keys |
| Recursive CTE for the nested group tree | ✅ 4 nodes, depth 2 (Series → Season → Disc) |
| Partial `UNIQUE … WHERE dedupe_key IS NOT NULL` | ✅ multiple NULLs allowed, duplicate key rejected — group derivation is safe |
| Fractional REAL positions for drag-reorder | ✅ one `UPDATE` moves an item between neighbours |
| WAL + `foreign_keys = ON` on a file database | ✅ `journal_mode=wal foreign_keys=1` |

The FTS-quoting result is worth calling out: it is a **live crash** in any search box that passes input through unescaped, and it's the kind of thing that ships. One `quote()` helper, used everywhere, no exceptions.

---

## D. Confirmed — key-free providers, re-tested live

| Provider | Test | Result |
|---|---|---|
| Cinemeta — movie detail | `GET /meta/movie/tt0111161.json` | ✅ name, year, runtime, description, genre, cast, director, imdbRating, poster/background/logo, **`trailers[{source}]`** |
| Cinemeta — search | `GET /catalog/movie/top/search=blade%20runner.json` | ✅ `metas[]` with id (= IMDB id), name, type, poster, releaseInfo |
| Cinemeta — series | `GET /meta/series/tt0903747.json` | ✅ `videos[]` flat with `season`, `episode`/`number`, `name`, `overview`, `thumbnail`, `released`; plus `imdb_id`, `tvdb_id`, `moviedb_id`. Confirms §12.3 must group by `season` itself. |
| OpenSubtitles v3 | `GET /subtitles/movie/tt0111161.json` | ✅ `subtitles[]` with id, url, lang (3-letter), subtitleFileName, movieReleaseName, SubEncoding. No auth. |
| lyrics.ovh | `GET /v1/Radiohead/Creep` | ✅ `{ "lyrics": "…" }`, no key |
| Cover Art Archive | `GET /release-group/{mbid}` | ✅ 302 → archive.org, `images[]` with image, `thumbnails{250,500,1200,large,small}`, front, back, types, approved |
| MusicBrainz ws/2 | not re-tested | ⚠️ robots.txt blocks the fetch tool. Docs confirm 1 req/s per IP and the User-Agent requirement; first integration test to write. |

Every provider the design leans on answered without a key, as specified. No change.

---

## E. Confirmed — versions and packaging

| Package | Latest | Note |
|---|---|---|
| electron | 44.3.0 | HEVC HW decode since 22, HW encode since 33 |
| better-sqlite3 | 13.0.3 | Node-API + prebuilds, `engines: node >= 22` |
| electron-vite | 5.0.0 | |
| electron-builder | 26.15.3 | |
| @electron/rebuild | 4.2.0 | repair path only |
| zod | 4.6.4 | v4 — API differs from v3, pin deliberately |
| chokidar | 5.0.0 | |
| parse5 | 8.0.1 | sanitizer |
| postcss | 8.5.28 | CSS sanitizer |
| bonjour-service | 1.4.4 | mDNS |
| sharp | 0.35.4 | see below |

**One substitution worth making:** §12.4 specifies `sharp` for hero-image re-encoding. `sharp` is a heavy native dependency with a well-earned reputation for Electron packaging pain. Electron's built-in **`nativeImage`** does everything that step needs — decode, resize, re-encode to JPEG/PNG — and re-encoding drops EXIF as a side effect, which was the actual security requirement. Drop `sharp`, use `nativeImage`, lose a native dependency.

---

## F. Untestable here — flagged as first-run-on-Windows checks

Honest list of what this environment can't settle. None is architecture-threatening; all are cheap to verify once M0 runs on the real machine.

1. **Gamepad API in a packaged Electron window.** Needs a physical controller. The focus/button-press requirement is documented Chromium behaviour, not in doubt, but the mapping indices should be confirmed against your actual pad.
2. **`webUtils.getPathForFile` from a sandboxed preload.** Electron's docs explicitly endorse this pattern (*"place the API call in your preload script and expose it using contextBridge"*), so confidence is high, but it isn't executed here.
3. **HEVC hardware decode on your GPU specifically.** Electron ≥ 22 has the plumbing; whether it engages depends on your hardware and the Windows HEVC extension. First real 4K file answers it.
4. **`node:sqlite` availability inside Electron.** Fallback only; unverified.
5. **Windows Firewall prompt behaviour** on first LAN-server bind.
6. **electron-builder NSIS output on this project.** Standard, but unbuilt.

---

## G. Net changes before implementation

| # | Change | Milestone |
|---|---|---|
| 1 | FTS table declares `content=''` **and** `contentless_delete=1`; reindex is DELETE+INSERT; all search queries join back to `media` | M2 |
| 2 | Document SQLite ≥ 3.45 as a hard minimum | M0 |
| 3 | Search debounce 120 ms → 60 ms | M2 |
| 4 | Mandatory `quote()` helper for all FTS input | M2 |
| 5 | **Playback served over `http://127.0.0.1` by the local server**, not `que://`; HLS + hls.js for transcoded content; LAN and local share one path | M1 (HTTP/Range) · M1c (HLS) |
| 6 | `que://` reduced to artwork / subtitles / skin assets | M1 |
| 7 | `registerSchemesAsPrivileged` with `stream: true` | M0 |
| 8 | CSP gains `media-src http://127.0.0.1:*` | M0 |
| 9 | Remux treated as the common path (MKV), not an edge case; audio-only transcode for AC-3/DTS | M1c |
| 10 | README: VS Build Tools demoted from Requirements to Troubleshooting | M0 |
| 11 | `sharp` → Electron `nativeImage` | M7 |
| 12 | Skin sanitizer test suite must include a positive control | M10 |

Items 5 and 6 are the only structural ones, and they make the system smaller. Everything else is a one-line correction.

---

## H. Overturned after implementation began

Assumptions that passed the pre-implementation check — or were never questioned, which is
worse — and were falsified by a running system. Each names the milestone that found it.

### H1. ⛔ WRONG — ffprobe is I/O-bound, so a deep pool will parallelise it freely

*Held through M1 and M1b's planning. Overturned by M1b's benchmark ([AAR-M1b](AAR-M1b.md) §3).*

AAR-M1 D3 measured a cold scan as "98% ffprobe wait" and everyone, including the PRA built on
top of it, read *wait* as *I/O wait*. It is not. Measured across pool sizes on a 2-core
machine:

```
  pool 1   52.17 ms/file   1.00×
  pool 2   26.57 ms/file   1.96×
  pool 4   26.34 ms/file   1.98×
  pool 8   26.58 ms/file   1.96×
  pool 16  26.98 ms/file   1.93×
```

Speed-up saturates at exactly the core count and never moves again. ffprobe is a subprocess
decoding container headers on a CPU, not a request waiting on a platter. The 98% figure was
right about where wall-clock goes and wrong about why.

**What changed.** Not the design — a pool is still correct and still delivers everything the
hardware allows. What changed is the ceiling: `defaultProbeConcurrency()` tracks
`availableParallelism()` capped at 8, and the cap is justified by "past the core count there
is nothing to gain" rather than by a guess about disk depth. The exit-criterion assertion was
rewritten from a flat `> 2×` to a fraction of `min(cores, maxPool)`, because a flat threshold
fails a 2-core machine achieving 100% of what it has.

**Still open:** the projection for a 20,000-file library on real hardware. On 2 cores it is
8.8 min; at 8 cores the arithmetic says ~2.2 min. Arithmetic, not a measurement — `npm run
bench` on the Windows machine settles it.

### H2. ⛔ WRONG — `http_cache` (migration 001) can serve as the provider response cache

*Assumed in [PRA-M1b](PRA-M1b.md) §5.4. Overturned during M1b ([AAR-M1b](AAR-M1b.md) D3).*

`http_cache` is keyed by URL. The key the idempotency design produces is deliberately **not**
a URL: two library rows resolving to the same release must share one entry even when their
request URLs differ, and one URL must not serve two languages. A URL-keyed table cannot
express either.

**What changed.** Migration 004 replaces it with `provider_cache`, keyed by idempotency key
and carrying provider, capability and origin as indexed columns. `http_cache` had never been
written to — no provider had shipped — so nothing was migrated.

### H3. ⚠️ CORRECTED — one unique idempotency key per row

*Corrected in [PRA-M1b](PRA-M1b.md) §4 C4, before implementation, by
[`sanity-tests/idempotency.mjs`](sanity-tests/idempotency.mjs).*

Recorded here because it is the most expensive assumption the project has had, and it was
caught only because someone ran it rather than reasoning about it.

A key per *row* is right about collisions and wrong about sharing. Twelve tracks from one
album are twelve rows legitimately wanting the same release lookup; keyed on `media.id` that
is twelve identical network calls, and against MusicBrainz's 1 req/s the deduplication saving
on a 5,000-track library — 158 minutes — disappears entirely. Keyed too coarsely instead (one
key for a batch) the harness measured 1 call, 1 distinct result, and **1 of 12 rows correct**.

**What changed.** The key identifies the *request*, not the row: origin identity plus every
parameter that varies the response. Rows wanting the same resource share a key by design;
rows wanting different resources cannot collide.

---

## Test artifacts

| Script | Covers |
|---|---|
| `fts.js` | First FTS5 pass — the run that exposed A1 |
| `fts2.js` | Corrected FTS5 suite, 9/9 passing, plus 50k-row benchmarks |
| `skin-sandbox2.js` | Chromium iframe sandbox suite with positive control |
| `idempotency.mjs` | Concurrency and idempotency semantics — the run that exposed H3 |

The cold-scan benchmark behind H1 lives in the repo rather than here, because it needs the
scanner: `npm run bench`.

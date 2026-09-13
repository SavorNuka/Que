# Que — Architecture & Implementation Plan

**Que** — a local personal media library and video/music player for Windows.

Status: **M0 built and verified** (typecheck, lint, 46 tests green). Repo: `D:\Projects\Que`.
Corrections from [ASSUMPTIONS.md](ASSUMPTIONS.md) are folded in below.
Last updated: 2026-09-13.

---

## 1. Locked decisions

| Decision | Choice |
|---|---|
| Shell | Electron |
| UI | React 19 + TypeScript, bundled with Vite |
| Catalogue store | SQLite via `better-sqlite3` (synchronous, in main process) |
| Codec coverage | Bundled **ffmpeg sidecar**, remux on demand (§2.1) |
| Controller input | Chromium Gamepad API (no native addon) |
| Providers | **Key-free by default**; TMDB / Wyzie are optional upgrades (§10) |
| API keys | Optional. Entered in Settings, encrypted at rest with `safeStorage` |
| Packaging | `electron-builder` → NSIS installer + portable |

Que installs and runs with **zero API keys configured**. Every requirement in the brief is
satisfied by a key-free provider; keys only buy better match quality and higher rate limits.

---

## 2. Risks worth knowing before code is written

**2.1 Container and codec coverage is the biggest one.** Revised after research ([ASSUMPTIONS.md A2](ASSUMPTIONS.md)) — the original framing blamed codecs, but the container matters more:

| Input | Status | Action |
|---|---|---|
| MP4 / H.264 / AAC, WebM / VP9 / Opus, MP3, FLAC, WAV, Ogg | Native | Direct play |
| **Any `.mkv`** | Chromium has **no Matroska demuxer** | Remux container (`-c copy`, cheap) |
| HEVC/H.265 | HW decode built in since Electron 22 on Windows; no software fallback | Direct play on capable GPUs |
| AC-3 / E-AC-3 / DTS / TrueHD | Unsupported | Transcode audio → AAC, copy video |
| AVI / WMV / MPEG-TS | Mostly unsupported | Remux |

The common real case is *MKV + H.264 + AC-3*: a container remux plus an audio-only transcode, both cheap.

Three ways out, in order of preference:

1. **Ship an ffmpeg sidecar** (`ffmpeg.exe`, ~80 MB) and remux/transcode on demand into a fragmented-MP4 stream the `<video>` element can take. Remux (copy streams, change container) is near-free CPU; only unsupported codecs need a real transcode. This also gives us thumbnail extraction and duration probing for free, and it is what the LAN server needs anyway.
2. **Swap the render surface for libmpv** (via `mpv.js`-style embedding). Plays everything, but it's a native module, it fights with the HTML skin system (it renders into its own surface), and it complicates packaging.
3. **Accept the limitation** and document supported formats.

**Decision: option 1, confirmed.** Native `<video>` playback first; probe each file on import with `ffprobe`, mark files that need remuxing, and route those through a local remux pipe. The skin system stays pure HTML/CSS over a normal `<video>` element.

**2.2 Key-free by default.** Wyzie Subs now requires a key (free tier, 1,000 req/UTC day) and TMDB always has. Both are therefore *optional* rather than load-bearing — Que ships with key-free providers as the default chain and treats keys as an upgrade. See §10.

**2.3 `npm install` must run on Windows.** `better-sqlite3` and Electron have native/platform binaries. The Linux VM this session's shell runs in can scaffold files but cannot produce a working `node_modules` for your Windows build. Install and run from PowerShell in `D:\Projects\Que`.

---

## 3. Process model

```
┌─────────────────────────────────────────────────────────────┐
│ MAIN  (Node, full privileges)                               │
│  • SQLite (better-sqlite3)                                  │
│  • filesystem: scanner, watcher, import                     │
│  • providers: TMDB / MusicBrainz / CAA / Wyzie / lyrics.ovh │
│  • artwork + subtitle + lyrics cache on disk                │
│  • que:// protocol handler (Range-capable local streaming)  │
│  • LAN HTTP server (opt-in)                                 │
│  • ffmpeg/ffprobe sidecar                                   │
│  • settings + secrets (safeStorage)                         │
└───────────────▲─────────────────────────────────────────────┘
                │ contextBridge, typed, validated both ends
┌───────────────┴─────────────────────────────────────────────┐
│ PRELOAD  (sandboxed, no Node in renderer)                   │
│  • exposes window.que.* — a narrow, hand-written surface    │
└───────────────▲─────────────────────────────────────────────┘
                │
┌───────────────┴─────────────────────────────────────────────┐
│ RENDERER  (React, contextIsolation: true, sandbox: true)    │
│  • library grid, groups, detail, playlists, settings        │
│  • <video>/<audio> element + skin layer                     │
│  • gamepad poll loop + spatial focus manager                │
│  • skin <iframe sandbox> (no scripts, sanitized HTML/CSS)   │
└─────────────────────────────────────────────────────────────┘
```

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true` — no exceptions. Local media never reaches the renderer as a `file://` URL; it comes through the `que://` protocol so we keep `webSecurity` on even under the Vite dev server.

---

## 4. Repo layout

```
Que/
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json / tsconfig.node.json
├─ resources/
│  └─ bin/                    # ffmpeg.exe, ffprobe.exe (downloaded on postinstall)
├─ skins/                     # bundled skins, copied to userData on first run
│  ├─ classic/ minimal/ theater/ vinyl/ neon/ terminal/
├─ src/
│  ├─ shared/                 # imported by BOTH sides — types only, no Node
│  │  ├─ types.ts
│  │  ├─ ipc-contract.ts      # channel names + arg/return types
│  │  └─ zod-schemas.ts       # runtime validation, used in main
│  ├─ main/
│  │  ├─ index.ts             # app lifecycle, window creation
│  │  ├─ db/
│  │  │  ├─ connection.ts
│  │  │  ├─ migrations/001_init.sql …
│  │  │  └─ repos/{media,groups,playlists,sources,settings}.ts
│  │  ├─ library/
│  │  │  ├─ scanner.ts        # walk source paths
│  │  │  ├─ watcher.ts        # chokidar, debounced
│  │  │  ├─ importer.ts       # drag-drop + dialog imports
│  │  │  ├─ grouping.ts       # derive albums / seasons / sagas, saga suggestions
│  │  │  └─ probe.ts          # ffprobe → duration, codecs, embedded tags/art
│  │  ├─ providers/
│  │  │  ├─ registry.ts       # capability → ordered chain, from settings
│  │  │  ├─ cinemeta.ts       # key-free movies/series + trailers
│  │  │  ├─ opensubs-v3.ts    # key-free subtitles
│  │  │  ├─ tmdb.ts           # optional
│  │  │  ├─ wyzie.ts          # optional
│  │  │  ├─ musicbrainz.ts
│  │  │  ├─ coverart.ts
│  │  │  ├─ itunes.ts         # key-free artwork fallback
│  │  │  ├─ lyricsovh.ts
│  │  │  └─ http.ts           # shared fetch: UA, retry, per-host rate-limit queue, cache
│  │  ├─ media/
│  │  │  ├─ protocol.ts       # que:// with Range
│  │  │  └─ remux.ts          # ffmpeg pipe for unsupported containers
│  │  ├─ server/
│  │  │  ├─ server.ts         # LAN host
│  │  │  ├─ routes.ts
│  │  │  └─ web/              # tiny static client served to other devices
│  │  ├─ skins/
│  │  │  ├─ loader.ts         # discover, install, duplicate, preview render
│  │  │  └─ sanitize.ts       # ← security-critical
│  │  ├─ trailer/window.ts    # isolated BrowserWindow, ephemeral partition
│  │  └─ ipc/handlers.ts
│  ├─ preload/index.ts
│  └─ renderer/
│     ├─ main.tsx
│     ├─ app/{router,theme}.tsx
│     ├─ features/{library,search,filters,groups,detail,player,playlists,skins,settings,server}/
│     ├─ player/
│     │  ├─ PlayerHost.tsx    # owns <video>, exposes player state
│     │  ├─ SkinFrame.tsx     # sanitized skin iframe + binding bridge
│     │  ├─ Subtitles.tsx
│     │  └─ Lyrics.tsx
│     └─ input/
│        ├─ gamepad.ts        # poll loop → action events
│        └─ focus.ts          # spatial navigation
├─ README.md                  # install / run / command reference
└─ docs/ARCHITECTURE.md       # this file
```

---

## 5. Data model (SQLite)

WAL mode, `foreign_keys = ON`, versioned migrations in `meta.schema_version`.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- "One path may be designated for each media file type": UNIQUE(kind) enforces it.
CREATE TABLE sources (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL UNIQUE CHECK (kind IN ('video','audio')),
  path         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER
);

CREATE TABLE media (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('video','audio')),
  path           TEXT NOT NULL UNIQUE,
  file_name      TEXT NOT NULL,
  ext            TEXT NOT NULL,
  size_bytes     INTEGER,
  mtime_ms       INTEGER,
  quick_hash     TEXT,        -- size + first/last 64KB; detects moves vs. new files
  duration_ms    INTEGER,
  video_codec    TEXT,
  audio_codec    TEXT,
  container      TEXT,
  needs_remux    INTEGER NOT NULL DEFAULT 0,
  title          TEXT,
  sort_title     TEXT,
  year           INTEGER,
  overview       TEXT,
  genres         TEXT,        -- JSON array; also mirrored into media_genres for faceting
  trailer_yt_id  TEXT,        -- YouTube id from Cinemeta/TMDB, NULL if none known
  user_rating    REAL,        -- 0..10, half-star granularity in UI
  thumb_path     TEXT,        -- cached file under userData/artwork/
  thumb_source   TEXT CHECK (thumb_source IN ('tmdb','caa','embedded','frame','user')),
  provider       TEXT CHECK (provider IN ('cinemeta','tmdb','musicbrainz','itunes','manual')),
  provider_id    TEXT,
  imdb_id        TEXT,
  added_at       INTEGER NOT NULL,
  last_played_at INTEGER,
  play_count     INTEGER NOT NULL DEFAULT 0,
  resume_ms      INTEGER,
  missing        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_media_kind_sort ON media(kind, sort_title);
CREATE INDEX idx_media_missing   ON media(missing) WHERE missing = 1;

CREATE TABLE audio_meta (
  media_id      INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  artist        TEXT, album_artist TEXT, album TEXT,
  track_no      INTEGER, disc_no INTEGER, genre TEXT,
  mb_recording_id TEXT, mb_release_id TEXT, mb_release_group_id TEXT
);

CREATE TABLE video_meta (
  media_id      INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  tagline       TEXT, runtime_min INTEGER, content_rating TEXT,
  backdrop_path TEXT, tmdb_id INTEGER,
  is_episode    INTEGER NOT NULL DEFAULT 0, season INTEGER, episode INTEGER,
  series_title  TEXT
);

-- free-form, user-authored metadata; the "write and edit file linked metadata" requirement
CREATE TABLE media_fields (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT,
  PRIMARY KEY (media_id, key)
);

CREATE TABLE playlists (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('video','audio')),
  description TEXT,
  artwork_path TEXT,
  shuffle    INTEGER NOT NULL DEFAULT 0,
  repeat     TEXT NOT NULL DEFAULT 'off' CHECK (repeat IN ('off','one','all')),
  smart_query TEXT,           -- JSON FilterSpec; NULL = manual playlist (§19)
  favorite   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position    REAL NOT NULL,      -- fractional, so reorder is one UPDATE
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, media_id)
);
CREATE INDEX idx_pl_pos ON playlist_items(playlist_id, position);

CREATE TABLE subtitle_cache (
  media_id  INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  language  TEXT NOT NULL,
  file_path TEXT NOT NULL,        -- .srt under userData/subtitles/
  source    TEXT NOT NULL,        -- 'wyzie' | 'sidecar' | 'embedded' | 'user'
  label     TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, language, source)
);

CREATE TABLE lyrics_cache (
  media_id   INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  synced     INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL,       -- 'lyricsovh' | 'embedded' | 'user'
  fetched_at INTEGER NOT NULL
);

-- Grouping (§12) — groups, group_items and group_fields are defined in §12.2,
-- kept there so the whole grouping model reads in one place.

-- Skin library (§14)
CREATE TABLE skins (
  id           TEXT PRIMARY KEY,       -- folder name
  name         TEXT NOT NULL,
  author       TEXT,
  version      TEXT,
  kind         TEXT NOT NULL DEFAULT 'both' CHECK (kind IN ('video','audio','both')),
  bundled      INTEGER NOT NULL DEFAULT 0,
  favorite     INTEGER NOT NULL DEFAULT 0,
  valid        INTEGER NOT NULL DEFAULT 1,
  report       TEXT,                   -- JSON: what the sanitizer stripped
  preview_path TEXT,
  installed_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Denormalised facet table so genre filtering is an index scan, not a JSON scan
CREATE TABLE media_genres (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  genre    TEXT NOT NULL,
  PRIMARY KEY (media_id, genre)
);
CREATE INDEX idx_genre ON media_genres(genre);

CREATE VIRTUAL TABLE media_fts USING fts5(
  title, overview, artist, album, series_title, genres, custom,
  content='',                 -- contentless
  contentless_delete=1,       -- ...and updatable. BOTH are required.
  tokenize='porter unicode61 remove_diacritics 2'
);
```

`playlist_items.position` as a REAL means dragging an item between two others is `position = (prev + next) / 2` — one row updated, no reindex.

Group names and taglines are indexed into the same FTS table as their own document type (§12.5), so one query covers files and groups alike.

`media_fts` is a **contentless** FTS5 table, so rows are pushed into it explicitly by the repo layer rather than by triggers — a single `reindex(mediaId)` after any write to `media`, `audio_meta`, `video_meta`, or `media_fields`. Contentless costs a little disk but removes the trigger fan-out of keeping FTS in sync across four tables. External-content was the ergonomic alternative but `content='media'` can only mirror one table, and this search document spans five.

Three things about contentless tables, all verified rather than assumed ([ASSUMPTIONS.md A1](ASSUMPTIONS.md)):

- **Both** `content=''` and `contentless_delete=1` are required. `content=''` alone cannot DELETE; `contentless_delete=1` alone is rejected outright. Declared wrong, the index can be written but never updated.
- `UPDATE` is refused even with the flag, so **reindex is always DELETE then INSERT**.
- **Columns read back as NULL.** Nothing displayable can come out of the FTS table — every query joins back to `media` on `rowid`. `searchMediaIds()` therefore returns ids only, by design.

Requires SQLite ≥ 3.45, asserted at startup in `db/connection.ts`. Measured cost at 50,000 rows: 3 ms per query, 39 ms for 200 single-row reindexes.

---

## 6. IPC surface

One contract file in `shared/ipc-contract.ts` gives both sides the same types. Every handler validates its argument with a Zod schema before touching the DB or the filesystem — the renderer is treated as untrusted.

```
library:list        (filter, sort, page)        → MediaSummary[]
library:get         (id)                        → MediaDetail
library:import      (paths[])                   → ImportResult      # drag-drop + dialog
library:pickFiles   (kind)                      → string[]          # native dialog
library:scan        (kind?)                     → ScanProgress      # streams via event
library:remove      (id, deleteFile: false)     → void
library:setRating   (id, rating)                → void
library:setFields   (id, patch)                 → MediaDetail       # first-class + custom
library:setThumb    (id, {fromFile|fromUrl|fromFrame})  → string

search:global       (q, limit?)                 → GlobalSearchResult   # §18
search:suggest      (prefix)                    → Suggestion[]         # typeahead
filter:query        (FilterSpec, sort, page)    → MediaPage            # §19
filter:facets       (FilterSpec)                → FacetCounts          # sidebar counts
filter:save         (name, kind, FilterSpec)    → Playlist             # smart playlist

trailer:find        (id)                        → TrailerRef | null    # §20
trailer:open        (id)                        → void                 # in-app window
trailer:openExternal(id)                        → void                 # YouTube fallback

sources:get         ()                          → Source[]
sources:set         (kind, path)                → Source
sources:pickFolder  (kind)                      → string | null

meta:searchMovie    (query, year?)              → TmdbMatch[]
meta:applyMovie     (id, tmdbId)                → MediaDetail
meta:searchMusic    (artist, title, album?)     → MbMatch[]
meta:applyMusic     (id, mbid)                  → MediaDetail

subs:search         (id, lang, season?, ep?)    → SubtitleOption[]
subs:fetch          (id, option)                → { path, cues }
lyrics:fetch        (id)                        → { text, synced }

playlists:list / create / update / delete / addItems / removeItems / reorder

groups:list         (kind?, type?, parentId?)   → GroupSummary[]      # §12
groups:get          (id)                        → GroupDetail
groups:create / update / delete / setFavorite
groups:setScreen    (id, GroupScreen)           → GroupDetail
groups:setHero      (id, {fromFile|fromUrl|fromMedia|fromFrame}) → string
groups:addItems / removeItems / reorder
groups:derive       (kind?)                     → DeriveReport        # idempotent
groups:suggestions  ()                          → GroupSuggestion[]   # saga heuristic
groups:acceptSuggestion / dismissSuggestion

player:progress     (id, positionMs)            → void              # throttled 5s
player:finished     (id)                        → void

server:status / start / stop / setConfig        → ServerStatus
skins:list / read / apply / install / duplicate / delete / openFolder / reload
skins:setFavorite   (skinId, favorite)          → SkinInfo
settings:get / set                              → Settings
providers:status    ()                          → ProviderStatus[]     # which chain is live
```

Events pushed main → renderer: `scan:progress`, `library:changed`, `server:client`, `provider:rateLimited`.

---

## 7. Import & scanning

**Drag and drop.** The renderer's drop handler reads `e.dataTransfer.files`. Under `sandbox: true` the renderer can't read paths freely, so we use `webUtils.getPathForFile(file)` (the supported replacement for the removed `File.path`) and hand the string paths to `library:import`. Main is the only side that touches the filesystem.

**Native picker.** `library:pickFiles` → `dialog.showOpenDialog` with extension filters per kind.

**Source scan.** `sources:set` stores one folder per kind; `library:scan` walks it, filters by extension, and diffs against the DB. Files gone from disk are flagged `missing = 1` rather than deleted, so ratings and playlist membership survive an unplugged drive. `chokidar` watches the source folders while the app runs, debounced 2 s.

**Per-file pipeline:** stat → quick-hash → if hash matches a `missing` row, treat as a *move* and update the path → `ffprobe` for duration/codecs/embedded tags → extract embedded cover art if present → parse the filename (`Title (Year)`, `S01E02`, `01 - Artist - Track`) for provider-lookup hints → insert → queue background artwork/metadata fetch if auto-fetch is enabled.

Extensions: video `mp4 mkv webm avi mov m4v wmv flv mpg mpeg ts m2ts`; audio `mp3 flac wav m4a aac ogg opus wma aiff`.

---

## 8. Playback

The renderer owns a single `<video>` element (audio plays through the same element — one code path, and it gives visualiser/artwork space for free).

**Source URL: `http://127.0.0.1:8723/stream/<id>`** — the local HTTP server (§13), not a custom protocol.

This changed after testing ([ASSUMPTIONS.md A2](ASSUMPTIONS.md)). The original design streamed fragmented MP4 down `que://` and restarted ffmpeg with `-ss` on seek. That cannot work: a fragmented MP4 off a pipe has no index, the browser seeks by **byte offset**, and there is no reliable byte→time mapping for VBR content. The same research also showed Chromium has **no Matroska demuxer at all**, so remux is the common path for a real movie folder rather than an edge case.

The revised path:

- Directly playable files stream from disk with real Range/206 handling.
- Files needing transcode are served as **HLS** (`ffmpeg -f hls`) and played with `hls.js`. Seeking becomes segment-addressed, so it is exact by construction — this is what Jellyfin and Plex do, for this reason.
- The LAN server and the local player are now **one code path**, which deletes a module and a class of "works locally, broken on the phone" bugs.

Every route resolves an integer id against SQLite; no path from the renderer or the network ever reaches `fs`.

`que://` keeps artwork, subtitles and skin assets — small, no-Range content. It must still be registered before `app.ready` with `stream: true`, or media elements buffer whole responses:

```js
protocol.registerSchemesAsPrivileged([{
  scheme: 'que',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);
```

State kept in a small store (Zustand): `{ mediaId, playing, positionMs, durationMs, volume, muted, rate, subtitleTrack, queue, queueIndex }`. This object is the *only* thing the skin layer and the gamepad layer talk to.

Progress is written back via `player:progress` every 5 s and on pause/close, so resume works.

---

## 9. Subtitles and lyrics

Resolution order, cheapest and most reliable first:

1. **Sidecar file** — `Movie.en.srt` next to the media file. Free, instant.
2. **Embedded stream** — `ffprobe` finds `subtitle` streams; `ffmpeg -map 0:s:0 -f srt` extracts one. Free, instant, no network.
3. **OpenSubtitles v3 (key-free)** — the default network provider.
4. **Wyzie Subs** — used instead of (3) when a key is present.

### OpenSubtitles v3 — key-free default

```
GET https://opensubtitles-v3.strem.io/subtitles/movie/{imdbId}.json
GET https://opensubtitles-v3.strem.io/subtitles/series/{imdbId}:{season}:{episode}.json
```

No key, no registration, no headers. Returns `{ subtitles: [ { id, url, lang, subtitleFileName, movieReleaseName, SubEncoding, fpsMilli, releaseGroup, releaseFormat } ] }`. `lang` is ISO 639-2/B three-letter (`eng`, `spa`, `pob`), so we keep a 3→2 letter map for the UI.

Caveats, stated plainly because they matter: this is a community relay in front of OpenSubtitles, not a contract. It has no documented SLA or rate limit, results are thinner than Wyzie's, and `url` may serve `.srt` or `.vtt` — so we sniff the first bytes rather than trusting the extension. We self-limit to 1 req/s, cache aggressively, and surface a clear "no subtitles found — add a Wyzie key in Settings for better coverage" empty state rather than failing silently.

### Wyzie Subs — optional upgrade

```
GET https://sub.wyzie.io/search?id={tmdbOrImdbId}&key={KEY}
    [&season=1&episode=1] [&language=en] [&format=srt] [&hi=true] [&encoding=utf-8]
```

A key is required for all Wyzie requests (free tier: 1,000/UTC day, redeemed at `store.wyzie.io/redeem`). Response is a JSON array; the fields we use are `id`, `url`, `fileName`, `format`, `encoding`, `display`, `language`, `isHearingImpaired`, `source`, `release`, `downloadCount`. Richer filtering (`release`, `origin`, `hi`, `encoding`) and better match rates are what the key buys.

### Common flow

Both providers key off an **IMDB id**, which Cinemeta gives us for free (§10) — so subtitle search is available as soon as a movie is matched, with or without any key. We list options, the user picks one (or auto-picks the preferred language, highest `downloadCount` where that field exists), download `url` to `userData/subtitles/<mediaId>.<lang>.srt`, record it in `subtitle_cache`, parse the SRT in main into `{ start, end, text }[]`, and hand cues to the renderer.

Rendering: cues go into a `TextTrack` created with `video.addTextTrack('subtitles')` and `addCue(new VTTCue(...))`. That keeps timing on the browser's clock rather than a React timer, and it means the skin can style `::cue`. SRT tags (`<i>`, `<b>`, `{\an8}`) are stripped or mapped; everything else is escaped. Encoding is detected (`SubEncoding` hint, then BOM, then `chardet`) and normalised to UTF-8 on write.

### lyrics.ovh (audio)

```
GET https://api.lyrics.ovh/v1/{artist}/{title}
  200 → { "lyrics": "…" }
  404 → { "error": "No lyrics found" }
```

No key, no documented rate limit — we self-limit to ~1 req/s and cache in `lyrics_cache` permanently. Artist/title come from embedded tags, falling back to the filename parse, falling back to whatever the user typed in the metadata editor. The API returns plain unsynced text, so display is a scrolling panel, not karaoke timing. (If you later want synced lyrics, that needs a different provider — LRCLIB — and a `lyrics_cache.synced` path that's already in the schema.)

---

## 10. Metadata and artwork providers

### 10.0 Provider abstraction

Every provider implements one of three interfaces in `src/main/providers/`:

```ts
interface MovieProvider {
  id: 'cinemeta' | 'tmdb';
  requiresKey: boolean;
  available(): boolean;                        // key present, or key-free
  search(q: string, year?: number): Promise<MovieMatch[]>;
  detail(providerId: string): Promise<MovieDetail>;   // incl. artwork + trailer
}
interface MusicProvider  { /* search / detail / artwork */ }
interface SubtitleProvider { /* search / download */ }
```

`ProviderRegistry` holds an ordered **chain** per capability and walks it until one returns a usable result. The chain is derived from settings, and the default is key-free:

| Capability | Default chain | With keys configured |
|---|---|---|
| Movie metadata | `cinemeta` | `tmdb` → `cinemeta` |
| Movie artwork | `metahub` (via Cinemeta) | `tmdb` → `metahub` |
| Movie trailers | `cinemeta` (`trailers[]`) | `tmdb` → `cinemeta` |
| Subtitles | sidecar → embedded → `opensubtitles-v3` | sidecar → embedded → `wyzie` → `opensubtitles-v3` |
| Music metadata | `musicbrainz` | unchanged (never needed a key) |
| Music artwork | `coverartarchive` → embedded | + `itunes` as a third fallback |
| Lyrics | `lyrics.ovh` | unchanged (never needed a key) |

Settings shows a provider status panel: each capability, which provider is currently answering, and a one-line "add a key to improve this" prompt where relevant. Nothing is ever silently degraded.

### 10.1 Cinemeta — key-free movie/series metadata (default)

Stremio's public metadata addon. No key, no registration, no headers.

```
Search : GET https://v3-cinemeta.strem.io/catalog/movie/top/search={query}.json
         → { query, rank, cacheMaxAge, metas: [ { id, name, type, poster,
                                                  releaseInfo|year, imdbRating } ] }
Detail : GET https://v3-cinemeta.strem.io/meta/movie/{imdbId}.json
         → { meta: { name, year, released, runtime, description, genre, cast,
                     director, writer, awards, imdbRating,
                     poster, background, logo,
                     trailers: [ { source: "<youtubeId>", type: "Trailer" } ] },
             videos, trailerStreams, popularity, links, slug }
Series : .../catalog/series/top/search=…  and  .../meta/series/{imdbId}.json
```

`id` **is** the IMDB id (`tt0111161`) — which is exactly the key the subtitle providers want, so one key-free lookup unlocks metadata, artwork, trailers, and subtitles together.

Artwork comes from `images.metahub.space`, with size in the path: `poster/small|medium|large`, `background/medium|large`, `logo/medium`. We cache `poster/medium` for the grid and `background/large` for the detail hero.

Caveats: Cinemeta is IMDB-derived and community-operated — no SLA, `imdbRating` is sometimes absent, and it has no music coverage at all. It is a genuinely good default, not a crippled one, but TMDB gives better search ranking on obscure titles, certifications, and multiple artwork options.

### 10.2 TMDB (movies) — optional upgrade

Base `https://api.themoviedb.org/3`. Auth: the v4 read access token as `Authorization: Bearer <token>` (preferred) or `?api_key=`. Practical ceiling around 40 req/s; we queue well under that and handle 429 with `Retry-After`.

- `GET /search/movie?query=&year=` → candidate list
- `GET /movie/{id}?append_to_response=images,external_ids,release_dates,videos` → detail, artwork, IMDB id, and trailers in one call
- Images: `https://image.tmdb.org/t/p/{size}{file_path}` — `w500` for posters in the grid, `original` cached for detail, `w780`/`original` for backdrops. `/configuration` is fetched once a week and cached rather than hardcoded.

Auto-match on import uses the parsed title + year and accepts the top hit only when the title similarity is high and the year matches; otherwise the item lands in a "needs review" filter and the user picks from `meta:searchMovie` results. Nothing is silently mis-tagged.

### 10.3 MusicBrainz + Cover Art Archive (music) — always key-free

Base `https://musicbrainz.org/ws/2`, `&fmt=json`.

- **Hard requirement:** a descriptive `User-Agent` on every request — `Que/0.1.0 ( https://github.com/<you>/que )`. Anonymous agents get throttled harder.
- **Hard limit:** 1 request per second per IP, averaged. The shared `http.ts` queue enforces a strict 1100 ms spacing for this host — no bursting.
- Best first call when we have an AcoustID-free setup: `GET /recording?query=recording:"{title}" AND artist:"{artist}"&fmt=json&limit=5`, then `GET /release/{mbid}?inc=artist-credits+recordings+release-groups&fmt=json`.

Cover art comes from `https://coverartarchive.org`:
- `GET /release/{mbid}/front-500` → 307 redirect to the image (follow it)
- `GET /release-group/{mbid}/front-500` → same, for when we only resolved the release group
- `GET /release/{mbid}/` → JSON with `images[]`, each having `image`, `thumbnails: {250,500,1200}`, `front`, `back`, `types`

No rate limiting and no UA requirement on CAA, but it 404s often — fall back to embedded album art, then (optionally) to the **iTunes Search API**, which is also key-free:

```
GET https://itunes.apple.com/search?term={artist}+{album}&entity=album&limit=5
  → results[].artworkUrl100 ; swapping "100x100bb" for "600x600bb" in that URL
    yields a larger image
```

Apple publishes no hard limit but throttles aggressively (roughly 20 calls/minute per IP, 403 beyond that), so it sits last in the chain and is cached permanently. Final fallback is a generated placeholder using the album's initials and a hue derived from its MBID.

### 10.4 Artwork cache

Everything downloaded is written to `userData/artwork/<mediaId>-<hash>.jpg` and referenced by `media.thumb_path`. The renderer loads it through `que://art/<id>`. The user can always override with `library:setThumb` from a local file, a URL, or the current video frame — `thumb_source = 'user'` then pins it so a later re-fetch won't clobber their choice.

---

## 11. Ratings and playlists

Rating is `media.user_rating` (0–10, displayed as five half-steppable stars), settable from the grid, the detail pane, and a gamepad shortcut during playback. Sort and filter by rating are first-class in `library:list`.

Playlists are per-kind (`video` or `audio`) so a playlist can't mix a movie with a song — which keeps the queue/skin behaviour coherent. CRUD plus reorder-by-drag, shuffle and repeat flags stored on the playlist, and a playlist can be the playback queue directly. Deleting a playlist never touches files.

---

## 12. Grouping — albums, seasons, sagas, collections

### 12.1 Groups are not playlists

A **group** is structural: it says what a thing *is*. "Disc 2 of *Kid A*", "Season 3 of *Breaking Bad*", "the Alien saga". A **playlist** is curated: it says what you want to hear next. They look similar in the UI and are completely different in the data model, and conflating them produces a "collection" concept that does both jobs badly.

The practical difference: a track belongs to exactly one album but any number of playlists; an album's membership is *derived from the files* and repairs itself on rescan, while a playlist's membership is authored and must never be touched by a scan.

### 12.2 Model

One self-referencing table. Nesting is what makes seasons and discs work without a second concept.

```sql
CREATE TABLE groups (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN
                 ('artist','album','series','season','saga','collection','custom')),
  kind         TEXT NOT NULL CHECK (kind IN ('video','audio')),
  parent_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,      -- derived; rescan may overwrite this
  display_name TEXT,               -- user override; rescan NEVER touches this
  sort_name    TEXT,
  year         INTEGER,
  origin       TEXT NOT NULL DEFAULT 'manual'
                 CHECK (origin IN ('derived','manual','smart')),
  provider     TEXT,               -- 'musicbrainz' | 'cinemeta' | 'tmdb'
  provider_id  TEXT,               -- release-group MBID, IMDB id, TMDB collection id
  dedupe_key   TEXT,               -- stable identity for re-derivation
  rule         TEXT,               -- JSON FilterSpec when origin='smart'
  screen       TEXT,               -- JSON GroupScreen (§12.4)
  user_rating  REAL,
  favorite     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_groups_dedupe ON groups(kind, type, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_groups_parent ON groups(parent_id);

CREATE TABLE group_items (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  source   TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('derived','manual')),
  PRIMARY KEY (group_id, media_id)
);
CREATE INDEX idx_group_items_media ON group_items(media_id);
CREATE INDEX idx_group_items_pos   ON group_items(group_id, position);
```

Two details carry most of the weight:

**`source` per membership row.** Re-derivation only reconciles rows with `source = 'derived'`. So if you manually drop a bonus track or a deleted-scenes file into a derived album, the next scan leaves it alone instead of helpfully removing it. This is the difference between grouping that feels reliable and grouping you stop trusting.

**`name` vs `display_name`.** Providers own `name`; you own `display_name`. Renaming *Star Wars Collection* to *The Skywalker Saga* doesn't sever the TMDB link, and a later metadata refresh updates the underlying name without reverting your label. `COALESCE(display_name, name)` is what the UI renders — there is one helper for this and nothing else formats a group name.

`media_fields` already exists (§5), so groups get the same treatment: `group_fields(group_id, key, value)` for arbitrary user metadata on a group.

### 12.3 Auto-derivation

`library:scan` ends by calling `grouping.derive()`, which is idempotent and keyed on `dedupe_key`.

**Audio — reliable, entirely key-free.**
Albums come from embedded tags: `album` + `album_artist` + `year`, with `disc_no`/`track_no` giving `position`. `dedupe_key` prefers the MusicBrainz release-group MBID when a match exists and falls back to a normalised `album_artist|album|year`. An `artist` group is created as the parent from `album_artist`. Compilations (`album_artist = 'Various Artists'`, or MusicBrainz release-group type *Compilation*) skip the artist parent and hold per-track artists instead. Multi-disc albums become `album` → `season`-style disc children only when more than one `disc_no` is present; otherwise discs are flattened.

**Series and seasons — key-free.**
Filename parsing (`S01E02`, `1x02`, `Series.Name.S01E02`) gets us a series title, season, and episode. Cinemeta then confirms it:

```
GET https://v3-cinemeta.strem.io/meta/series/{imdbId}.json
  → meta.videos[] = [{ id, name, season, episode, number, released, firstAired,
                       overview, description, thumbnail, rating, tvdb_id }]
```

`videos[]` is a **flat** array — Cinemeta does not pre-group by season — so we group on `videos[].season` ourselves. That's fine and actually convenient: one request yields the Series group, its Season children, and per-episode titles, overviews, and thumbnails, which we write onto the media rows. Season 0 is treated as Specials and sorts last.

**Movie sagas and collections — the one honest gap.**
With a TMDB key, `/movie/{id}` returns `belongs_to_collection: { id, name, poster_path, backdrop_path }` and `/collection/{id}` returns the full member list. That is a real, curated saga graph, and it is the one place where a key buys a *capability* rather than just better quality.

Key-free, there is no equivalent: Cinemeta has no collection concept. Rather than pretend otherwise, Que runs a title-affinity heuristic — normalise titles, strip articles and subtitle suffixes, compare leading token runs, require ≥2 matches and a shared leading token of ≥4 characters — and files the results as **suggestions in a review tray**, never auto-applied. You see "3 possible sagas found: *The Matrix* (3 films), *Alien* (4 films), *John Wick* (4 films)" and accept, edit, or dismiss each. False positives are cheap to reject and expensive to silently live with, so this path is opt-in by design. Manual group creation is always available and is the primary path if you never add a key.

**Reconciliation.** Derived groups whose members all disappear are soft-deleted (hidden, restorable) rather than dropped, so an unplugged drive doesn't destroy a saga you spent time customising.

### 12.4 Customizable group screens

Every group gets its own screen, and every screen is configurable. The configuration is one JSON blob in `groups.screen`:

```ts
type GroupScreen = {
  displayName?: string;        // mirrors groups.display_name
  tagline?: string;
  description?: string;
  hero?: {
    image?: string;            // userData/artwork/groups/<id>-hero.<ext>
    focal?: 'center' | 'top' | 'bottom';
    overlay?: number;          // 0..1 scrim opacity over the image
    blur?: number;             // px, for text legibility
    height?: 'compact' | 'standard' | 'full';
  };
  poster?: string; logo?: string; backdrop?: string;
  accent?: string;             // hex; defaults to a colour sampled from the hero
  layout: 'poster-wall' | 'shelf' | 'list' | 'grid' | 'timeline';
  sortBy: 'position' | 'title' | 'year' | 'rating' | 'added' | 'track' | 'episode';
  sections: ('hero'|'summary'|'children'|'items'|'cast'|'fields'|'stats')[];
  showFields?: string[];       // which media_fields / group_fields keys to surface
  skin?: string;               // optional group-screen skin id (§14)
};
```

**Hero image uploads.** Drag an image file onto the hero area, pick one with the native dialog, paste a URL, or promote a frame from any member video. Whatever the route, main does the same thing: sniff magic bytes to confirm it really is an image (never trust the extension), re-encode through `sharp` to strip EXIF and any embedded payload, cap the long edge at 4096 px, and write it to `userData/artwork/groups/<groupId>-hero.<ext>`. The original is never linked in place, so moving or deleting your source image can't break the screen.

**Accent colour** is sampled from the hero — downscale to 16×16, take the dominant hue, then clamp lightness until it passes contrast against both the light and dark surface — and drives the screen's gradient, focus ring, and progress fill. Manual override is a colour picker; sampling never overwrites a manual choice.

**Layouts** aren't cosmetic variants, they're shaped to the group type. `poster-wall` for sagas and collections (large art, minimal text). `shelf` for an artist's discography (horizontal rows of albums, one row per parent). `list` for albums and seasons (track/episode number, title, duration, rating). `timeline` for anything with meaningful chronology — sagas sorted by year with the gaps drawn to scale. Each group type gets a sensible default and you can change it per group.

**Sections** are a drag-to-reorder list with toggles, so a season screen can lead with episodes and an artist screen can lead with albums, without either being a special case in code.

**Group screens can be skinned** with the same engine as the player (§14): the sanitizer, the `<iframe sandbox>` host, and the `data-que-*` vocabulary are all reused, extended with `data-que-bind="group.name|group.year|group.itemCount|group.duration|group.rating"` and `data-que-slot="hero|items|children"`. One sanitizer, two surfaces — and skin authors who learned the player format already know this one. Group-screen skinning lands with the skin engine in M9; the built-in layouts above ship earlier and don't depend on it.

### 12.5 Integration

- **Browsing.** The library has a flat view (every file) and a grouped view (albums/series/sagas as tiles). The toggle is remembered per kind, because the useful default differs: music is almost always browsed by album, movies about half the time.
- **Search (§18).** Group names and taglines are indexed into `media_fts` as their own document type; groups come back as their own result cluster alongside Movies and Music. Searching *"breaking bad"* surfaces the series, its seasons, and matching episodes, in that order.
- **Filtering (§19).** `FilterSpec` gains `groupId`, `groupType`, and `inAnyGroup: boolean`, so "everything in the Alien saga rated 8 or above" and "music not in any album" both become one query. The ungrouped filter is how you find files that need attention.
- **Playback.** A group is a valid queue source, same as a playlist. Playing a Series plays its seasons in order; playing a Season plays that season; playing an album plays it by disc and track. Queue order is the screen's `sortBy`, so what you see is what plays.
- **LAN server (§13).** `GET /api/groups?kind=` and `GET /api/groups/:id` let the web client browse by group, with hero art served through `/art/group/:id`.
- **Gamepad (§15).** Group tiles join the same spatial focus model. `A` opens a group, `B` goes up one level (season → series → library), `X` plays the whole group.
- **Ratings.** Groups carry their own `user_rating`, independent of member ratings, plus a computed average shown alongside it.

---

## 13. LAN server

Off by default. Enabled from Settings, which shows the URL, a QR code, and a PIN.

- `node:http` + a small hand-rolled router in the main process (no Express; the surface is six routes and I'd rather not carry the dependency).
- Binds `0.0.0.0:8723` by default, port configurable. On first start it asks Windows Firewall for private-network permission.
- **Auth:** a random 32-byte session token minted when the server starts and shown as a 6-digit PIN → token exchange. Token goes in an HttpOnly cookie after `POST /auth` with the PIN. Every other route requires it. Token dies when the server stops.
- **Routes:** `GET /` (tiny built-in web client), `GET /api/library?kind=`, `GET /api/media/:id`, `GET /stream/:id` (Range, 206, same remux path as `que://`), `GET /art/:id`, `GET /sub/:id/:lang` (served as WebVTT for browser `<track>`), `POST /auth`, `GET /health`.
- **Path safety:** every route resolves an integer media id against SQLite. No route ever accepts a filesystem path. This is the single most important property of the server.
- Optional mDNS advertisement (`bonjour-service`) as `_que._tcp` so other devices find it without typing an IP.
- Rate-limited auth attempts (5 per minute per IP) so the PIN can't be brute-forced.

---

## 14. Skin system

A skin is a folder under `userData/skins/<id>/`:

```
skin.json    { name, author, version, engine: 1, entry: "skin.html", style: "skin.css" }
skin.html    layout markup — NO script
skin.css
assets/      images, fonts (local only)
```

**The skin never executes.** Instead of running the author's JavaScript, Que gives the skin a declarative vocabulary:

- `data-que-action="play|pause|toggle|next|prev|seek-forward|seek-back|volume-up|volume-down|mute|fullscreen|toggle-subs|toggle-lyrics"` — Que attaches the listener, the skin just marks the element.
- `data-que-bind="title|artist|album|year|position|duration|position-pct|rating|state"` — Que writes text content in, on each state change.
- `data-que-slot="video|artwork|subtitles|lyrics|seekbar|volumebar|queue"` — Que mounts its own real controls into these containers.
- `data-que-show-when="playing|paused|has-subs|has-lyrics|is-video|is-audio"` — Que toggles a class.

That covers essentially any layout a skin author actually wants, with zero script execution.

### Sanitization (`src/main/skins/sanitize.ts`)

Runs in **main**, on load, before the markup ever reaches the renderer. Allowlist, not denylist.

- Parse with `parse5` into a tree. Anything not on the allowlist is dropped, not escaped-and-kept.
- **Allowed tags:** `div, span, section, header, footer, main, aside, nav, ul, ol, li, p, h1–h6, img, figure, figcaption, button, svg` + a fixed SVG subset (`path, circle, rect, g, polygon, line`).
- **Allowed attributes:** `class, id, style, title, alt, width, height, data-que-*`, plus `d, viewBox, fill, stroke, stroke-width, points, cx, cy, r, x, y` on SVG.
- **Dropped unconditionally:** every `on*` attribute, `script`, `style` (as a tag — CSS comes from `skin.css` only), `iframe`, `object`, `embed`, `link`, `meta`, `base`, `form`, `input`, `template`, `noscript`, `math`, `foreignObject`, and any attribute whose name starts with `on` after Unicode normalisation and whitespace stripping.
- **URL attributes:** `img[src]` and `svg` `href`/`xlink:href` must resolve to a path *inside* the skin's own folder. `javascript:`, `data:` (except `data:image/png|jpeg|gif|webp`), `vbscript:`, and any remote origin are rejected. Resolved paths are re-checked against the skin root after `path.resolve` so `../../` escapes fail.
- **Inline `style=` and `skin.css`** go through a CSS parser (`postcss`): drop `@import`, `behavior`, `-moz-binding`, `expression()`, and any `url()` that isn't a same-folder relative path. `position: fixed` is allowed; `content:` with `url()` is not.
- The sanitizer is the first thing that gets unit tests — a fixture file of ~40 XSS payloads (mutation XSS, namespace confusion, entity-encoded `on` handlers, SVG `<animate>` attribute injection) that must all come out inert.

### Rendering

Sanitized HTML is written to a temp file and loaded into an `<iframe sandbox="allow-same-origin">` — **no `allow-scripts`**, which makes script execution impossible even if the sanitizer were bypassed. Defence in depth:

```
Content-Security-Policy:
  default-src 'none';
  img-src que: data:;
  style-src 'unsafe-inline' que:;
  font-src que:;
  script-src 'none';
```

Que reaches into the iframe through `contentDocument` (same-origin) to do the binding writes and event wiring. The real `<video>` element lives in Que's document and is positioned into the skin's `data-que-slot="video"` rectangle — so the skin can never get a handle on the media element itself.

A "Reload skin" button and a validation panel that lists what the sanitizer stripped makes authoring skins pleasant rather than mysterious.

### 14.4 Skin library

A dedicated screen, not a dropdown in Settings. Skins are a feature, so they get a room.

- **Grid of skin cards.** Each card shows a live preview — the skin rendered at 320×180 in a muted, non-interactive iframe against a fixed dummy player state (a sample title, 1:23 / 4:56, a placeholder poster) so previews are comparable. Rendered once and cached to `preview_path`.
- **Favorite** (★) on every card. Favorites sort to the top of the grid, and `RB` on the gamepad cycles *only* favorites during playback — so you can flip between the two or three you actually use without leaving the video.
- **Actions per card:** Apply · Favorite · Duplicate · Open folder · Delete (user skins only) · Validation report.
- **Duplicate** is how you author: fork a bundled skin into `userData/skins/<name>-copy/`, open the folder, edit `skin.html`/`skin.css` in any editor, hit Reload. Bundled skins are read-only and re-copied on upgrade, so a botched edit can't brick the player.
- **Install** accepts a dropped folder or `.zip`. Every file is sanitized and path-checked on install, not just on render — a zip cannot write outside its own skin folder (no `../`, no absolute paths, no symlinks, size cap).
- **Invalid skins stay visible** with a red badge and the sanitizer's report, rather than disappearing. A skin that fails validation can't be applied, but you can see exactly why.
- Filter chips: All · Favorites · Video · Audio · Bundled · Mine.

### 14.5 Bundled skins

Six shipped in `skins/`, copied to `userData/skins/` on first run. Enough variety that the format proves itself and there's something to fork.

| Skin | Kind | Character |
|---|---|---|
| **Classic** | both | Default. Chrome bar under the video, poster + metadata sidebar, standard transport. |
| **Minimal** | both | Controls fade out entirely; a single thin progress line on hover. |
| **Theater** | video | Full-bleed video, backdrop-blurred letterbox fill, oversized 10-foot controls sized for gamepad. |
| **Vinyl** | audio | Rotating album art, large lyrics panel, warm palette. |
| **Neon** | both | High-contrast dark, saturated accent, animated seekbar glow. |
| **Terminal** | both | Monospace, ASCII-ish transport glyphs, green-on-black. |

Each doubles as documentation: `Classic` uses every `data-que-*` hook at least once and is commented throughout, so "read Classic" is the tutorial.

---

## 15. Gamepad (X-input)

Chromium exposes Xbox controllers through the standard mapping. No native module.

- Poll loop driven by `requestAnimationFrame` in the renderer reading `navigator.getGamepads()`; diffed against the previous frame to synthesise `buttondown` / `buttonup` / `axischange`.
- Chromium only reveals a gamepad after the user presses a button on it, and only while the window has focus — the Settings screen says so explicitly rather than leaving it looking broken.
- Default map (standard indices): A(0) select/play-pause · B(1) back · X(2) toggle subtitles/lyrics · Y(3) global search (§18) · LB(4) prev track · RB(5) cycle favorite skins (§14.4) · LT(6)/RT(7) seek −10 s/+10 s (analog: pressure scales the jump) · Back(8) library · Start(9) play-pause · D-pad(12–15) navigate · Left stick navigate/scrub · Right stick volume. Holding `Y` during playback opens the rating overlay.
- Deadzone 0.25, d-pad repeat 400 ms then 120 ms.
- Bindings are stored in settings and remappable from a "press a button" capture UI.
- **Focus management** is the part that actually makes it feel right: a spatial navigation manager registers focusable elements by their bounding rect and picks the nearest neighbour in the pressed direction, with a visible focus ring sized for a couch. Every screen gets a defined initial focus.

---

## 16. Settings and secrets

`userData/settings.json`, written atomically. Keys: source paths (mirrored to the `sources` table), preferred subtitle/lyrics language, auto-fetch metadata on import, artwork quality, gamepad bindings, active skin, server config, theme.

TMDB token and Wyzie key are **optional** (§10). When present they're stored in the same file but **encrypted with Electron's `safeStorage`** (DPAPI on Windows), falling back to plaintext with a visible warning if it isn't available. Keys never reach the renderer — Settings shows a masked placeholder and only ever sends a *new* value down. All provider calls happen in main.

---

## 17. Security checklist

- [ ] `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every window
- [ ] Renderer CSP with no `unsafe-eval`; `script-src 'self'`
- [ ] `will-navigate` and `setWindowOpenHandler` deny everything except `shell.openExternal` for explicit user links
- [ ] Every IPC handler Zod-validates its input; ids are integers, never paths
- [ ] `que://` and every LAN route resolve ids through the DB — no renderer- or network-supplied paths reach `fs`
- [ ] Skin sanitizer allowlist + script-free iframe sandbox + CSP (three independent layers)
- [ ] LAN server off by default, token-gated, private-network binding, auth rate-limited
- [ ] API keys encrypted at rest, never sent to the renderer
- [ ] Trailer window is a separate `BrowserWindow` on an ephemeral partition, navigation-restricted to YouTube hosts
- [ ] Skin `.zip` install rejects `../`, absolute paths, and symlinks; per-file and total size caps
- [ ] Uploaded hero images are magic-byte sniffed, re-encoded through `sharp` (EXIF stripped), and size-capped before being written to the artwork folder
- [ ] `ffmpeg` invoked via `execFile` with an argument array — never a shell string

---

## 18. Global search

One search box, reachable from anywhere with `Ctrl+K` (and `Y` on the gamepad), searching the whole library regardless of which screen you're on.

**Index.** `media_fts` (§5) covers `title`, `overview`, `artist`, `album`, `series_title`, `genres`, and a flattened `custom` column holding every `media_fields` value — so metadata you wrote by hand is searchable on equal footing with metadata that came from a provider. `reindex(mediaId)` runs after any write; a full rebuild is a single statement and takes well under a second for a library of tens of thousands of rows.

**Query handling.** The raw string is escaped and turned into an FTS5 prefix query — `blade run` → `"blade" AND "run"*` — so results appear while typing. Ranking is `bm25(media_fts, 10.0, 2.0, 6.0, 4.0, 6.0, 1.0, 1.0)`: title weighted heaviest, then artist/series, then album, with overview and custom fields last. A trailing exact-phrase pass promotes literal matches above tokenised ones.

**Operators**, parsed out of the query string before it reaches FTS:

```
artist:radiohead        year:1994        year:1990..1999
genre:noir              rating:>=8       kind:audio
added:<30d              codec:hevc       has:subs
```

Anything not matching an operator is free text. This keeps the power-user path and the type-three-letters path in the same box.

**Results** come back grouped — Movies, Music, Playlists, Skins — each group capped, with "show all N" expanding into a filtered library view. Keyboard and gamepad navigate the groups; `Enter` plays, `Ctrl+Enter` opens the detail page. Recent searches persist.

**Debounce** 120 ms, queries run on the main process against SQLite synchronously (`better-sqlite3` makes this genuinely fast), and an in-flight query is superseded rather than queued.

---

## 19. Filtering and smart playlists

Search narrows by *words*; filters narrow by *structure*. Both compose — a filter set can have a search term inside it.

**`FilterSpec`** is a plain JSON object, shared between renderer and main, with a single builder in `main/db/repos/media.ts` that turns it into parameterised SQL. Nothing else in the codebase writes a `WHERE` clause for the library.

```ts
type FilterSpec = {
  q?: string;                        // folded into the FTS join
  kind?: 'video' | 'audio';
  genres?: string[];                 // via media_genres, AND or OR
  years?:  [number, number];
  rating?: { min?: number; max?: number; unrated?: boolean };
  artists?: string[]; albums?: string[]; series?: string[];
  playlistId?: number;
  groupId?: number; groupType?: GroupType; inAnyGroup?: boolean;   // §12.5
  watched?: 'yes' | 'no' | 'in-progress';   // play_count / resume_ms
  hasSubs?: boolean; hasLyrics?: boolean; hasArtwork?: boolean;
  codecs?: string[]; containers?: string[]; needsRemux?: boolean;
  duration?: [number, number];       // minutes
  addedWithin?: string;              // '7d' | '30d' | '1y'
  missing?: boolean;
  fields?: { key: string; op: 'eq'|'contains'|'exists'; value?: string }[];
  match: 'all' | 'any';
};
```

**Facet counts.** `filter:facets` runs the same spec with each facet's own clause removed, returning counts per genre / year-decade / rating bucket / codec. The sidebar shows live counts and greys out zero-result options, so you never click into an empty grid.

**Sorting:** title, year, rating, date added, last played, play count, duration, artist/album — each with a stable secondary key so pagination never duplicates or drops rows. Keyset pagination (`WHERE (sort_key, id) > (?, ?)`), not `OFFSET`, so deep scrolling stays O(1).

**Smart playlists.** Any filter set can be saved with `filter:save`, which writes the `FilterSpec` into `playlists.smart_query`. A smart playlist resolves its members at read time, so "Unwatched sci-fi rated 8+" stays current as the library grows. Smart and manual playlists appear in the same list, visually distinguished, and both can be a playback queue. Converting smart → manual ("freeze") materialises the current members into `playlist_items`.

**Indexes** backing all of this: `idx_media_kind_sort`, `idx_genre`, plus `(kind, year)`, `(kind, user_rating)`, `(kind, added_at)`, and `(kind, last_played_at)`. Every filter path either hits an index or an FTS lookup.

---

## 20. Trailers

Cinemeta and TMDB both hand us YouTube video ids, so this works **without any key**:

- Cinemeta: `meta.trailers[] = [{ source: "<youtubeId>", type: "Trailer" }]`, plus `trailerStreams`.
- TMDB (if a key is set): `/movie/{id}?append_to_response=videos` → `videos.results[]` filtered to `site === 'YouTube' && type === 'Trailer'`, preferring `official: true`.

The chosen id is cached in `media.trailer_yt_id` at match time, so the Watch Trailer button knows instantly whether it has anything to offer.

**In-app playback.** `trailer:open` creates a separate `BrowserWindow` — never the main window, never a skin iframe — loading:

```
https://www.youtube-nocookie.com/embed/{id}?autoplay=1&rel=0&modestbranding=1
```

with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and a **dedicated ephemeral session partition** (`partition: 'trailer'`, cleared on close) so YouTube gets no persistent cookies and nothing it stores touches the rest of the app. `setWindowOpenHandler` denies popups; `will-navigate` is restricted to `youtube-nocookie.com` and `youtube.com`, with anything else pushed to `shell.openExternal`. Main playback pauses when the trailer window opens and resumes on close.

**Fallback.** Some videos are embed-restricted by their uploader, and some titles simply have no trailer id. Both cases route to `trailer:openExternal`, which opens the user's real browser via `shell.openExternal` at either the watch URL or, when we have no id at all, a search URL built from the title and year:

```
https://www.youtube.com/results?search_query=<title>+<year>+trailer
```

The button label reflects which path it will take — "Watch Trailer" vs. "Search YouTube" — rather than surprising you with a browser window.

---

## 21. Running it on Windows

```powershell
cd D:\Projects\Que
npm install            # must run on Windows: native better-sqlite3 + Electron binaries
npm run fetch:ffmpeg   # downloads ffmpeg/ffprobe into resources/bin
npm run dev            # electron-vite dev, HMR on the renderer
npm run build:win      # electron-builder → dist/Que Setup x.y.z.exe
```

The full command reference — every npm script, what it does, and when you'd reach for it — lives in **[README.md](../README.md)**.

---

## 22. Milestones

| # | Milestone | Contents |
|---|---|---|
| **M0** ✅ | Scaffold | electron-vite + TS + React, window, preload bridge, SQLite + migrations, typed IPC contract with Zod validation, provider registry, `que://` protocol, **hiding + age limits (§23)**, ffmpeg fetch + db CLI, lint/typecheck/46 tests |
| **M1** | Library & playback | source paths, scan, drag-drop + dialog import, ffprobe + remux pipe, `que://` protocol, grid + detail, `<video>` playback, resume |
| **M2** | Search & filter | FTS5 index + reindex hooks, global search box with operators, `FilterSpec` builder, facet sidebar, sorting, keyset pagination |
| **M3** | Metadata & artwork | provider registry + chain, Cinemeta, MusicBrainz/CAA, optional TMDB, auto-match, manual match UI, metadata editor incl. custom fields, custom thumbnails, ratings |
| **M4** | Subtitles, lyrics & trailers | sidecar + embedded extraction, OpenSubtitles v3, optional Wyzie, SRT → TextTrack, lyrics.ovh panel, trailer window + YouTube fallback |
| **M5** | Playlists | CRUD, drag reorder, shuffle/repeat, queue integration, smart playlists from saved filters |
| **M6** | Grouping | `groups`/`group_items`, album + artist derivation from tags, series + season derivation from Cinemeta, TMDB collections, saga suggestion tray, grouped/flat browse toggle, group as queue source |
| **M7** | Group screens | `GroupScreen` config, five layouts, hero upload pipeline, accent sampling, section reorder, display-name override, group ratings and fields |
| **M8** | Gamepad | poll loop, action map, spatial focus, remap UI, 10-foot styling pass |
| **M9** | LAN server | routes, Range streaming, PIN auth, built-in web client, group browsing, mDNS |
| **M10** | Skins | folder format, sanitizer + its test corpus, iframe host, binding/action/slot engine, six bundled skins, skin library with favorites, group-screen skinning, validation panel |
| **M11** | Package & polish | electron-builder, first-run wizard, empty states, error surfaces, provider status panel, restrictions UI (§23.5) |

M0–M1 is the point where it becomes a usable thing. M2 lands early because search and filtering shape the library UI's data layer — retrofitting them later means rewriting it. M6 before M7 for the same reason: the grouping model has to be right before screens are built on top of it, and M6 alone is already useful with default layouts. Everything else is additive and can be reordered freely.

---

## 23. Hiding content and age limits

Two related controls: **hiding** individual items or groups outright, and an **age limit** that filters by content rating. Both were added during M0 rather than later, because they are a query-layer concern and the query chokepoint was being built — retrofitting them would have meant revisiting every query written in between.

### 23.1 The property that matters

Enforcement lives in **the query builder, never in the UI**. The renderer cannot ask for hidden or over-age rows: the clauses are appended by main from state the renderer does not supply and cannot set. A bug in a React component cannot leak anything, because the rows never reach the renderer to begin with.

Concretely, `FilterSpec` has no `hidden` or `maxAge` field, and it never will. Restriction clauses come from `main/restrictions.ts` and are ANDed onto every read — including the two paths a careless implementation forgets:

- **Direct id lookup.** `media.get(id)` carries the same clauses, so asking for a restricted row by id throws rather than returning it.
- **Search.** `search:global` routes through `mediaRepo.searchRanked()` rather than querying `media` itself. The first draft of the IPC handler did query `media` directly and would have leaked restricted rows through the search box; the type system caught it when `MediaSummary` gained new fields, and it is now a regression test.

They are also ANDed **outside** the user's filter group, never folded into it. A `match: 'any'` filter ORs the user's clauses together, and a restriction folded into that OR would widen straight past the limit. Tested.

The same clauses will be used by the LAN server (§13). A phone on the network is a *less*-trusted client than the app window, not a more-trusted one.

### 23.2 Schema (migration 002)

```sql
ALTER TABLE media  ADD COLUMN hidden   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media  ADD COLUMN age_min  INTEGER;   -- normalised; NULL = unrated
ALTER TABLE media  ADD COLUMN explicit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN hidden   INTEGER NOT NULL DEFAULT 0;
```

`age_min` is a **normalised minimum age**, not a certificate string, so one comparison covers every rating system: `G`/`TV-G`/`U` → 0, `PG` → 8, `TV-Y7` → 7, `PG-13` → 13, `TV-14` → 14, `R`/`TV-MA` → 17, `NC-17`/`18` → 18, and BBFC `12`/`15` map to themselves. `ratingToAge()` owns the table; `NR`, `Unrated` and anything unrecognised become `NULL`.

`explicit` covers the music case that has no age certificate — the `ITUNESADVISORY`/`rtng` tag, or provider data.

### 23.3 Settings

```ts
interface RestrictionSettings {
  enabled: boolean;        // master switch; off makes everything below inert
  maxAge: number;          // 13 shows G/PG/PG-13, blocks R
  allowUnrated: boolean;   // what to do with items carrying no rating
  blockExplicit: boolean;  // independent of age rating
  pinSet: boolean;         // derived — never settable directly
  unlockMinutes: number;   // an unlock expires on its own
}
```

Restriction state is **injected** into `restrictions.ts` at startup and on every settings write, not read from the settings module. The repo layer calls into it on every query, so if it imported settings it would drag Electron's `app` into the data layer — and into every test that touches a query. That bit us during M0 and the inversion is the fix.

### 23.4 Unlocking

Unlocking is a main-process, time-limited session. The PIN is stored as a **salted scrypt hash** (N=16384) and never crosses IPC in either direction — not on the way in, not on the way out. `restrictions:get` returns settings plus an `unlocked` boolean, never the hash.

Which operations need an unlock is deliberately asymmetric:

| Operation | Requires unlock |
|---|---|
| Hiding an item | No — hiding is always allowed |
| **Un**hiding an item | Yes |
| Setting or changing an age rating | Yes |
| Changing any restriction setting | Yes |
| Setting or clearing the PIN | Yes |
| Reading current state | No |

Anything that *weakens* the restriction is gated; anything that strengthens it is not. Otherwise the lock would be removable from the very UI it governs. The guard is a no-op while restrictions are off, so people who never turn them on never meet a PIN prompt.

### 23.5 Still to come

The schema and enforcement shipped in M0; the surface has not. Remaining: the Settings panel, the PIN entry dialog, per-item hide/unhide affordances, populating `age_min` automatically from TMDB `release_dates` certifications and `explicit` from audio tags during M3, and applying the same clauses in the LAN server in M9.

---

## Appendix — provider key requirements at a glance

| Provider | Key? | Used for | Limit |
|---|---|---|---|
| **Cinemeta** (`v3-cinemeta.strem.io`) | No | Movie/series metadata, artwork, trailers, IMDB ids, season/episode lists | Undocumented; self-limit 1/s |
| **OpenSubtitles v3** (`opensubtitles-v3.strem.io`) | No | SRT subtitles by IMDB id | Undocumented; self-limit 1/s |
| **MusicBrainz** (`musicbrainz.org/ws/2`) | No | Music metadata | 1 req/s per IP, descriptive User-Agent required |
| **Cover Art Archive** (`coverartarchive.org`) | No | Album art | None stated |
| **lyrics.ovh** (`api.lyrics.ovh/v1`) | No | Lyrics | None stated; self-limit 1/s |
| **iTunes Search** (`itunes.apple.com/search`) | No | Album art fallback | ~20/min per IP |
| **TVmaze** (`api.tvmaze.com`) | No | TV episode data, if series support is added later | ~20 calls / 10 s per IP |
| TMDB | Yes (free) | Better movie matching, certifications, multi-artwork, **movie collections/sagas** (§12.3 — the one genuine capability a key adds) | ~40 req/s |
| Wyzie Subs | Yes (free) | Better subtitle coverage and filtering | 1,000 / UTC day |

## Sources

- [Cinemeta / Stremio addon protocol](https://stremio.github.io/stremio-addon-sdk/) — endpoints verified live against `v3-cinemeta.strem.io`
- [OpenSubtitles v3 Stremio addon](https://github.com/Stremio/stremio-official-addons) — endpoint verified live against `opensubtitles-v3.strem.io`
- [Wyzie Subs — Direct Fetching](https://docs.wyzie.io/subs/usage/direct) · [API Keys](https://docs.wyzie.io/subs/usage/api-keys) · [Intro](https://docs.wyzie.io/subs/intro)
- [lyrics.ovh API definition](https://github.com/NTag/lyrics.ovh/blob/main/apiary.apib)
- [TMDB — image basics](https://developer.themoviedb.org/docs/image-basics) · [rate limiting](https://developer.themoviedb.org/docs/rate-limiting)
- [MusicBrainz API rate limiting & User-Agent](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)
- [Cover Art Archive API](https://musicbrainz.org/doc/Cover_Art_Archive/API)
- [iTunes Search API](https://performance-partners.apple.com/search-api)
- [TVmaze API rate limit](https://www.tvmaze.com/threads/3189/api-rate-limit)

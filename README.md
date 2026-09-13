```
--                                             
--            * ***                            
--          *  ****                            
--         *  *  ***                           
--        *  **   ***                          
--       *  ***    *** **   ****               
--      **   **     **  **    ***  *    ***    
--      **   **     **  **     ****    * ***   
--      **   **     **  **      **    *   ***  
--      **   **     **  **      **   **    *** 
--      **   **     **  **      **   ********  
--       **  ** *** **  **      **   *******   
--        ** *   ****   **      **   **        
--         ***     ***   ******* **  ****    * 
--          ******* **    *****   **  *******  
--            ***   **                 *****   
--                  **                         
--                  *                          
--                 *                           
--                *                                                                   
```

A local personal media library and video/music player for Windows. Point it at a movies folder
and a music folder, and it catalogues, tags, rates, groups, plays, subtitles, and streams them —
with customizable group screens, a skin system, gamepad control, and a LAN server for other
devices in the house.

**Runs with zero API keys.** Every feature has a key-free provider by default; TMDB and Wyzie
keys are optional upgrades. See [docs/ARCHITECTURE.md §10](docs/ARCHITECTURE.md).

---

## Requirements

| | Minimum | Notes |
|---|---|---|
| OS | Windows 10 (21H2) / 11 | x64 |
| Node.js | **24 LTS** recommended — also 22.12+ or 26 | `node --version` |
| npm | 10+ | ships with Node |
| Disk | ~1.5 GB | `node_modules` + Electron + bundled ffmpeg |

> **Avoid Node 25.** It went end-of-life on 1 June 2026 — no security patches — and several
> dependencies (vitest among them) exclude it, since odd-numbered Node lines never become LTS.
> `package.json` declares `^22.12.0 || ^24.0.0 || >=26.0.0`, so npm will tell you if you're on
> a line this project doesn't support. Electron 44 itself needs at least 22.12.

**No C++ compiler needed.** `better-sqlite3` is a Node-API module shipping a prebuilt
`win32-x64` binary, and Node-API is ABI-stable across Electron versions too — so a plain
`npm install` should just work. (An earlier draft of this README told you to install Visual
Studio Build Tools; that was wrong. If a native module ever does fail to load, see
Troubleshooting.)

> `npm install` must still run **on Windows** — Electron's own binaries are platform-specific,
> so a `node_modules` built on Linux or macOS will not work here.

---

## First run

```powershell
git clone <your-remote> %PATH%\Que
cd %PATH%\Que
npm install
npm run dev
```

`npm install` pulls dependencies, downloads the Electron binary, and fetches the ffmpeg
sidecar. The Electron and ffmpeg steps are re-runnable (`npm run fetch:electron`,
`npm run fetch:ffmpeg`) and never fail the install if you're offline — `npm run dev`
retries them.

> **Why Electron needs its own download step.** As of Electron 42 the npm package no longer
> downloads its binary in a `postinstall` script; it fetches lazily on `npx electron`, or on
> demand via `npx install-electron`. Tools that resolve the executable path directly —
> electron-vite included — never trigger that lazy path, so a plain `npm install` leaves you
> with `Error: Electron uninstall`. Que runs the downloader itself before `dev`, `start` and
> `build`, so this should stay invisible.

Then, in the app: **Settings → Library** → set a folder for *Movies* and a folder for *Music* →
**Scan**. That's the whole setup. Optional keys go in **Settings → Providers**.

---

## Command reference

All commands run from `%PATH%\Que` in PowerShell.

Commands marked **(M*n*)** arrive with that milestone and are not in `package.json` yet.
Everything unmarked works today.

### Everyday

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies, then downloads the Electron binary and the ffmpeg sidecar. Both steps are skipped if already present and never fail the install. |
| `npm run dev` | Starts Que in development: Vite dev server, HMR on the renderer, main-process watch + restart. |
| `npm start` | Runs the last production build from `out/` without repackaging. Fastest way to sanity-check a build. |

### Build and package

| Command | What it does |
|---|---|
| `npm run build` | Type-checks and bundles main, preload, and renderer into `out/`. No installer. |
| `npm run build:win` | Full Windows package → `dist/Que Setup <version>.exe` (NSIS) and `dist/Que <version>.exe` (portable). |
| `npm run build:win -- --dir` | Unpacked app in `dist/win-unpacked/`. Much faster than building an installer; use while debugging packaging. |
| `npm run fetch:ffmpeg` | Downloads `ffmpeg.exe` and `ffprobe.exe` into `resources/bin/`. Runs automatically on postinstall; re-run to repair or upgrade. |
| `npm run fetch:electron` | Downloads the Electron binary into `node_modules/electron/dist`. Runs automatically before `dev`, `start` and `build`; you shouldn't need it by hand. |
| `npm run check:electron` | Reports whether the Electron binary is present, without downloading. |
| `npm run rebuild` | Rebuilds native modules (`better-sqlite3`) against the installed Electron ABI via `electron-rebuild`. Run after upgrading Electron or Node. |
| `npm run clean` | Removes `out/`, `dist/`, and Vite's cache. |
| `npm run clean:all` | `clean` plus `node_modules`. Follow with `npm install`. |

### Quality

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` across all three tsconfigs (main, preload, renderer). |
| `npm run lint` | ESLint over `src/`. |
| `npm run lint:fix` | ESLint with `--fix`. |
| `npm run format` | Prettier over `src/`, `skins/`, and `docs/`. |
| `npm test` | Vitest, single run. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:concurrency` | Re-runs the concurrency and idempotency suites **20 times each**. Concurrency defects are non-deterministic, so a suite that passed once has not been shown to pass. Stands in for CI until there's a remote — see [docs/PRA-M1b.md](docs/PRA-M1b.md) §10. |
| `npm run bench` | Cold-scan benchmark. Generates real media with ffmpeg, scans it at pool sizes 1–16, and prints per-file timings plus a 20,000-file projection. Takes about a minute; excluded from the normal test run. |
| `npm run test:skins` **(M10)** | Runs **only** the skin sanitizer suite against the XSS fixture corpus. Run this after any change to `src/main/skins/sanitize.ts` — it is the security boundary for user-authored skins. |
| `npm run check` | `typecheck` + `lint` + `test` + `test:concurrency`. What CI would run, if there were CI. |

### Database

| Command | What it does |
|---|---|
| `npm run db:path` | Prints the absolute path of the SQLite file for this machine. |
| `npm run db:migrate` | Applies any pending migrations to the existing database. Runs automatically at app start; this is for inspecting the result without launching. |
| `npm run db:reset` | Backs up the current database to `que-<timestamp>.db.bak`, then recreates it empty. Ratings, playlists, and edited metadata are in the backup, not the new file. |
| `npm run db:reindex` | Rebuilds the FTS5 search index from scratch. Use if global search starts missing items. |
| `npm run db:vacuum` | `VACUUM` + `ANALYZE`. Worth running after deleting a large number of items. |
| `npm run db:stats` | Row counts per table, database size, index sizes. |

### Library

| Command | What it does |
|---|---|
Scanning is available in the app today (**Settings → Library → Scan**). The commands below
are the headless equivalents, and none of them exist yet.

| Command | What it does |
|---|---|
| `npm run scan` **(M2)** | Scans the configured source folders and exits. Same code path as the in-app scan; handy for a scheduled task. |
| `npm run scan -- --kind=video` **(M2)** | Scans only the movie source. `--kind=audio` for music. |
| `npm run scan -- --full` **(M2)** | Ignores mtime/hash shortcuts and re-probes every file. Slow; use after changing the probe logic. |
| `npm run scan -- --concurrency=4` **(M2)** | Overrides how many ffprobe processes run at once. Defaults to your core count, capped at 8 — probing is CPU-bound, so more than that buys nothing. |
| `npm run artwork:prune` **(M3)** | Deletes cached artwork with no matching library row. Skips group hero images you uploaded. |
| `npm run cache:clear` **(M3)** | Empties the provider response cache (`provider_cache`) and the applied-operations ledger, so the next scan re-fetches metadata from scratch. In the app this is per-item: **re-match** on a single title clears only that one. |

### Groups

Albums, artists, series, seasons, sagas, and collections. See
[docs/ARCHITECTURE.md §12](docs/ARCHITECTURE.md).

| Command | What it does |
|---|---|
| `npm run groups:derive` **(M6)** | Rebuilds derived groups from tags and provider data. Idempotent, and it never touches manually added members or a group's custom screen. Runs automatically after a scan. |
| `npm run groups:derive -- --kind=audio` **(M6)** | Rebuilds only album/artist groups. `--kind=video` for series/seasons/sagas. |
| `npm run groups:suggest` **(M6)** | Runs the key-free saga heuristic and prints candidate movie groupings without creating anything. Accept them in the app's review tray. |
| `npm run groups:list` **(M6)** | Prints the group tree with member counts. Quick way to see what derivation produced. |
| `npm run groups:prune` **(M6)** | Permanently removes soft-deleted groups whose members are all gone. |

### Skins

| Command | What it does |
|---|---|
| `npm run skins:dir` **(M10)** | Prints the user skin folder path and opens it in Explorer. |
| `npm run skins:sync` **(M10)** | Re-copies the bundled skins into the user skin folder. Repairs a bundled skin you edited by mistake; never touches your own skins. |
| `npm run skins:validate <path>` **(M10)** | Runs the sanitizer against a skin folder and prints the report — every tag, attribute, and CSS rule that would be stripped, with line numbers. No app launch needed. |
| `npm run skins:new <name>` **(M10)** | Scaffolds a new skin from the `classic` template into the user skin folder. |

### Server

| Command | What it does |
|---|---|
| `npm run server` **(M9)** | Starts the LAN server standalone (no window). Prints the URL and PIN. |
| `npm run server -- --port=9000` **(M9)** | Overrides the port for this run. |

---

## Where Que keeps things

| What | Path |
|---|---|
| Database | `%APPDATA%\Que\que.db` |
| Settings (keys encrypted) | `%APPDATA%\Que\settings.json` |
| Artwork cache | `%APPDATA%\Que\artwork\` |
| Group hero images | `%APPDATA%\Que\artwork\groups\` |
| Database backups (`db:reset`) | `%APPDATA%\Que\que-<timestamp>.db.bak` |
| Subtitles | `%APPDATA%\Que\subtitles\` |
| Skins (yours) | `%APPDATA%\Que\skins\` |
| Logs | `%APPDATA%\Que\logs\` |
| ffmpeg / ffprobe | `resources\bin\` (dev) · `resources\` inside the install (packaged) |

Your media files are never moved, renamed, or modified. Que stores paths, not copies.

---

## Optional API keys

Both are free and neither is required.

| Key | Where to get it | What it improves |
|---|---|---|
| **TMDB** read access token | themoviedb.org → Settings → API | Better movie match ranking on obscure titles, certifications, multiple poster/backdrop choices, official trailer selection, and **automatic saga/collection grouping** — the one thing with no key-free equivalent. |
| **Wyzie Subs** key | store.wyzie.io/redeem | Wider subtitle coverage, release-name and hearing-impaired filtering. 1,000 requests per UTC day on the free tier. |

Paste either into **Settings → Providers**. They're encrypted at rest with Windows DPAPI and
never leave the main process. **Settings → Providers** always shows which provider is currently
answering each capability, so you can see exactly what a key changed.

---

## Hiding content and age limits

Off by default. Turn it on in **Settings → Restrictions** to hide individual items or
filter the library by content rating.

| | |
|---|---|
| **Age limit** | Set a maximum age. `13` shows G/PG/PG-13 and blocks R. Ratings are normalised, so US, TV and BBFC certificates all work. |
| **Unrated items** | Shown or hidden, your choice — a lot of home video and older rips carry no rating at all. |
| **Explicit audio** | Blocked independently of age rating, for tracks flagged by their tags. |
| **Hidden items** | Hide anything individually, regardless of rating. |
| **PIN** | Optional, 4–12 digits. Unlocking lasts 30 minutes by default, then re-locks itself. |

Two things worth knowing:

- Restrictions are enforced **in the database queries**, not in the interface. Restricted
  items don't reach the app window at all — they can't be revealed by a URL, a search, or
  a bug in a screen. The same rules will apply to devices watching over your network.
- **Hiding** something never needs the PIN. **Unhiding**, changing the age limit, or
  changing the PIN does. Anything that weakens the restriction is gated; anything that
  strengthens it isn't.

Your PIN is stored as a salted scrypt hash and never leaves the main process. There is no
recovery: if you forget it, delete the `restrictions` and `pin` keys from
`%APPDATA%\Que\settings.json`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `better-sqlite3` fails to load, `NODE_MODULE_VERSION` mismatch | Shouldn't happen — it's a Node-API module with Windows prebuilds. If it does: `npm run rebuild`. Only if *that* fails do you need VS Build Tools 2022 with the C++ workload. |
| `Error: Electron uninstall` at `getElectronPath` | Electron's binary isn't on disk. Electron 42+ no longer downloads it during `npm install` — see the note below. `npm run fetch:electron` fixes it, and `npm run dev` now does that automatically. |
| `Que needs SQLite >= 3.45` on startup | The bundled SQLite is too old for `contentless_delete` FTS5. Reinstall dependencies; don't downgrade `better-sqlite3` below 13. |
| A video shows a black screen with audio, or won't play at all | Unsupported codec. Check `npm run db:stats` for `needs_remux` counts and confirm `resources\bin\ffmpeg.exe` exists — `npm run fetch:ffmpeg` if not. |
| Nothing plays, and the window shows "the media server isn't running" | Playback is served over `http://127.0.0.1`, so a dead server means dead playback. The banner carries the reason. A port clash is handled automatically — Que falls back to an OS-assigned port and the footer says so. |
| The first scan of a large library is slow | Expected, and it's ffprobe, not Que — our own code is about 2% of a cold scan. Probing runs in parallel across your cores (capped at 8); it's CPU-bound, so it will not go faster than your machine allows. Rescans skip anything whose size and mtime are unchanged. Run `npm run bench` for real numbers on your hardware. |
| Gamepad does nothing | Chromium only reveals a controller after you press a button on it, with the Que window focused. Press **A** once, then check **Settings → Controller**. |
| Global search misses recently edited items | `npm run db:reindex`. |
| Other devices can't reach the server | The server is off by default — enable it in **Settings → Server**. On first start, allow Que through Windows Firewall on **private** networks. |
| A skin renders blank or half-missing | Open it in the Skin Library and read the validation report, or run `npm run skins:validate <path>`. The sanitizer strips anything executable by design. |
| Albums split into several groups | Inconsistent `album_artist` or `year` tags across the files. Fix the tags and run `npm run groups:derive`, or merge the groups by hand in the app — manual members survive every later rescan. |
| Movies aren't grouped into sagas | Saga detection needs a TMDB key. Without one, run `npm run groups:suggest` for heuristic candidates, or create the group manually. |
| A group's hero image or custom name disappeared | It shouldn't — derivation never overwrites `display_name` or an uploaded hero. If it did, that's a bug worth reporting with the output of `npm run groups:list`. |
| "No subtitles found" on everything | The movie needs a matched IMDB id first — match it in the detail pane, then retry. A Wyzie key widens coverage considerably. |

---

## Documentation

Two kinds, and the difference matters: **living** documents describe Que as it is now and are
updated every milestone; **point-in-time** records are written once and never edited, because
their value is being an honest account of what was known at the time.

### Living

| Doc | What it is |
|---|---|
| **[README.md](README.md)** | This file. Install, commands, paths, troubleshooting. |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Process model, data model, IPC surface, provider chains, concurrency and idempotency, grouping, skin sanitization, LAN server, restrictions, milestones. |
| **[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)** | Every load-bearing assumption, how it was tested, and what had to change — including the ones later overturned by implementation (§H). |
| **[docs/PROCESS.md](docs/PROCESS.md)** | How a milestone is run: the assessment before, the freeze, the review after, and the standing rules that came out of them. |

### Point-in-time

| Doc | Phase |
|---|---|
| [docs/PRA-M1b.md](docs/PRA-M1b.md) | Risk & integration assessment, written before M1b |
| [docs/M1-SCOPE.md](docs/M1-SCOPE.md) · [docs/M1b-SCOPE.md](docs/M1b-SCOPE.md) | Frozen scopes |
| [docs/AAR-M0.md](docs/AAR-M0.md) · [docs/AAR-M1.md](docs/AAR-M1.md) · [docs/AAR-M1b.md](docs/AAR-M1b.md) | After-action reviews |
| [docs/sanity-tests/](docs/sanity-tests/) | The runnable harnesses behind the assumption register |

---

## Status

**M0, M1 and M1b complete.** Scaffold and schema; source scanning, import, HTTP/Range
playback with resume; and a shared concurrency, rate-limiting and idempotency layer with
parallel probing.

| | |
|---|---|
| Gates | typecheck clean · lint clean · **351 tests** · 153 of them re-run 20× |
| Works today | set source folders, scan (including nested folders), drag-and-drop or dialog import, catalogue with search, play with resume, hide items and set age limits |
| Not yet | metadata, artwork, subtitles, lyrics, playlists, grouping, skins, gamepad, LAN server |
| Next | **M1c** — HLS transcode for MKV and HEVC. Then **M2** — search, filters and the real library UI. |

Provider chains are registered and reported in Settings, but no provider is implemented yet —
that's M3. The plumbing they will run on is finished and tested.
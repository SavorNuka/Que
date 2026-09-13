# M1 — Library & Playback · frozen scope

Frozen 2026-09-13 before implementation began. Per AAR-M0 action 2, this list does not
change during the pass; anything that lands outside it, or fails to land inside it, is
recorded in `docs/AAR-M1.md` instead.

Baseline: `02247db` on `main`.

## In scope

1. **Recursive scanner** — walks each source folder to any depth, skips system and noise
   directories, refuses to follow symlinks into cycles, and streams progress to the UI.
2. **Probe** — `ffprobe` per file for duration, container, video/audio codec, resolution;
   sets `needs_remux` from the container/codec rules in ARCHITECTURE §2.1.
3. **Move detection** — quick-hash (size + head/tail) so a file that moved is recognised as
   the same item and keeps its rating, group membership and play history.
4. **Missing handling** — a file gone from disk is flagged `missing`, never deleted.
5. **Folder drag-and-drop** — dropping a folder imports its contents recursively. *(AAR D4)*
6. **Local streaming server** — `127.0.0.1`, Range/206, token-gated, serving media by id.
   *(ASSUMPTIONS A2/A5 — replaces `que://` for playback)*
7. **Playback** — `<video>` against the server URL, play/pause/seek/volume, resume from
   `resume_ms`, progress written back.
8. **IPC handler tests** — Zod rejection of malformed arguments, round-trips per family.
   *(AAR P3)*
9. **Boot smoke test** — launch the built app headlessly, assert the window loads and
   `app:info` answers. This is the gate that would have caught the blank window. *(AAR P3)*

## Explicitly out of scope

- **HLS transcoding.** Direct play and remux *detection* are in; the actual transcode
  pipeline for MKV/AC-3 is M1b. Files needing remux are catalogued and marked, and report
  a clear reason rather than failing silently.
- File watching (`chokidar`) — scan is manual in M1.
- Metadata providers, artwork, subtitles, groups derivation — M3+.
- Playlists, gamepad, skins, LAN exposure beyond localhost.

## Done means

`npm run check` green (typecheck, lint, tests), the smoke test passes, and a real folder of
media scans, appears in the catalogue, and plays.

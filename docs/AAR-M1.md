# After Action Review — M1 (Library & Playback)

Reviewed 2026-09-13, immediately after M1 was committed as `7b0378b`, before M1b or M2.
Assessed against the frozen scope in [M1-SCOPE.md](M1-SCOPE.md) and the actions carried
forward from [AAR-M0.md](AAR-M0.md).

**Verdict: 8 of 9 scope items fully delivered, 1 partial. No high-severity defects. The
most consequential finding is a measurement, not a bug — a cold scan is 98% ffprobe wait,
and the design has no concurrency anywhere.**

Freezing the scope worked. It is the reason this review can report a partial honestly
instead of quietly widening the definition, which is exactly what M0 did.

---

## 1. Did the output match the frozen scope?

| # | Scope item | Status |
|---|---|---|
| 1 | Recursive scanner — depth, skip rules, symlink safety, streamed progress | ✅ delivered, 19 tests |
| 2 | Probe — duration, container, codecs, resolution, `needs_remux` | ✅ delivered, 11 tests incl. real media |
| 3 | Move detection via quick-hash | ✅ delivered, and a real bug found (§2, D-a) |
| 4 | Missing handling — flagged, never deleted | ✅ delivered, and a real bug found (§2, D-b) |
| 5 | Folder drag-and-drop *(AAR-M0 D4)* | ⚠️ **delivered but untested at commit — see D2** |
| 6 | Local streaming server — Range/206, token-gated, id-only | ✅ delivered, 27 tests |
| 7 | Playback — resume, progress write-back | ✅ delivered, untested at commit — see D5 |
| 8 | IPC handler tests — *"Zod rejection … and round-trips per family"* | ⚠️ **PARTIAL — see P1** |
| 9 | Boot smoke test | ✅ delivered, with a verified negative control |

Out-of-scope items stayed out: no HLS transcoding, no file watching, no providers, no
playlists. Nothing crept in.

### Two bugs the tests caught during the pass

Recorded because both would have been silent data loss, and neither was found by reading
the code:

- **(D-a) Identical files were treated as moves.** Move detection matched on hash alone, so
  a second copy of a file was read as the first one relocating, and the first vanished from
  the catalogue. Duplicates are entirely normal in a library. Fixed: a move requires the
  other copy to be gone from disk. *Found because two fixture files happened to share bytes
  — an accident, which is worth noting: nobody designed that test to find this.*
- **(D-b) Two scans in the same millisecond flagged nothing missing.** The sweep compared
  `seen_at < scanStart`; a rescan starting in the same millisecond left them equal. Fixed by
  deriving the marker from the highest stamp already stored, which also survives a DST shift
  or an NTP correction. Windows' ~15 ms clock granularity makes this reachable in practice,
  not just in tests.

---

## 2. Defects found in this review

### D1 — Two definitions of the same wire shape · **Severity: low · FIXED**

`ScanResult` and `ServerStatus` were each declared twice: once in `src/shared/types.ts` and
once in the main-process module that produces them. They were structurally identical, so
nothing complained.

That is the problem. Divergence is only caught in one direction — if the shared type gains a
required field, the handler fails to typecheck; if the *main* type gains a field, the
renderer silently never learns about it. Two sources of truth for one boundary.

Fixed: the wire shape is declared once in `@shared/types` and re-exported by the main
module. `ScanProgress` now derives from `EventMap['scan:progress']` rather than restating it.

### D2 — The folder-drop fix shipped with no test · **Severity: medium · FIXED**

Scope item 5 was the remediation for AAR-M0 D4, and it was committed with zero coverage.
I verified by hand during this review that it works (a dropped folder imports 2 of 3 files,
correctly ignoring the `.txt`), but "works when I checked" is exactly the state M0's
`useAsync` was in.

Fixed: 10 tests in `tests/import.test.ts` — recursion into a dropped folder, mixed
files-and-folders drops, non-media handling, duplicate rejection, probe-failure tolerance,
and that hand-imported items get `source_id = NULL` so a later source scan can't flag them
missing.

The same audit found a smaller wart in that function: a dynamic `await import('./walk')`
inside the import loop, re-resolving a module per file. Now a static import.

### D3 — A cold scan is 98% ffprobe wait, and nothing is concurrent · **Severity: medium · OPEN (M1b)**

Measured rather than estimated. Scanner overhead with a stubbed probe, 5,000 files:

```
cold  4,002 ms   0.80 ms/file
warm    311 ms   0.06 ms/file   (unchanged fast path, 13× faster)
```

Then real ffprobe latency, serial, on this machine:

```
ffprobe   43.5 ms/file
projected cold scan:   1,000 files  ~0.7 min
                       5,000 files  ~3.6 min
                      20,000 files  ~14.5 min
```

Our own code is 2% of a cold scan. The other 98% is waiting on ffprobe subprocesses one at a
time. A modest 4–8 way concurrency pool would cut a 20,000-file first scan from about a
quarter of an hour to two or three minutes.

Left open deliberately: this is a design change (a bounded worker pool), not a defect fix,
and adding it now would repeat exactly the scope creep this process exists to prevent. It is
the first item in M1b. The downstream argument for doing it there rather than later is in §4.

### D4 — A taken port killed playback silently · **Severity: medium · FIXED**

If port 8723 was in use — another Que instance, or anything else — `start()` rejected, the
reason went to a terminal, and the app came up looking completely normal with playback dead
and no explanation anywhere in the UI.

Fixed on both sides. The server now treats the configured port as a preference: on
`EADDRINUSE` it falls back to an OS-assigned port and records `usedFallbackPort`. A genuine
failure is recorded in `status().error`. The UI shows a banner when the server isn't
running, and the footer shows the live port. Three tests cover it.

### D5 — Playback progress had no tests · **Severity: low · FIXED**

`setProgress` and `markFinished` carry the "don't put a just-started or nearly-finished
title in Continue Watching" rule, and neither was tested. Six tests added covering the 5%
thresholds at both ends, unknown-duration files, finishing, and a nonexistent id.

### D6 — Resume uses a stale snapshot · **Severity: low · OPEN (M2)**

The player reads `resumeMs` from the list row it was opened with. Progress writes don't emit
`library:changed`, so closing and immediately reopening an item resumes from the *previous*
session's position, not the one just written. Harmless in practice — reopening later, after
any refresh, is correct — and it belongs with M2's library view rather than a patch here.

### D7 — Progress timer runs while paused · **Severity: trivial · OPEN**

The 5-second write-back interval doesn't pause with the video, so a paused player keeps
rewriting the same position. One wasted query per 5 seconds. Noted, not worth a patch.

---

## 3. Process

### P1 — Declared done against a gate I hadn't fully met · **Severity: medium**

Scope item 8 read *"IPC handler tests — Zod rejection of malformed arguments, round-trips
per family."* I delivered 30 argument-validation tests and **no round-trips**, then reported
M1 complete without noting the shortfall.

This is the same shape as the M0 finding, one level down. In M0 I edited the milestone to
match what I built; here I left the definition alone — an improvement — but still called it
done while a clause of it was unmet. The freeze only helps if the report is checked against
it line by line, which is what this review is for.

Round-trip coverage carries to M2. It is genuinely useful: handlers wire schemas to repos,
and nothing currently tests that `library:scan` rejects a concurrent scan, or that
`media:streamUrl` refuses a restricted id.

### P2 — CI still isn't running · **Severity: medium · UNCHANGED**

The workflow exists and now includes the smoke test. There is still no remote, so nothing
triggers it. Every gate in this project remains "the author ran it". Carried from AAR-M0 P2.

### P3 — What the M1 gates did and didn't cover

A deliberate improvement over M0, where the honest answer was "nothing above the database":

| Layer | Coverage |
|---|---|
| Scanner, walk, probe, hash | 45 tests, incl. real ffmpeg-produced media |
| Streaming server | 36 tests, incl. real HTTP and Range |
| IPC argument validation | 30 tests |
| Boot path | smoke test, with a verified negative control |
| IPC handler round-trips | **none** (P1) |
| Player component | **none** — no test renders `Player.tsx` |

---

## 4. Downstream impact

| Finding | Impact on later milestones |
|---|---|
| **D3** (no concurrency) | The important one. M3 fetches metadata per item over the network, and MusicBrainz enforces **1 request/second**. A 5,000-track library is 83 minutes *at the limit*, serial. M3 needs a bounded, rate-limited work pool — and so does the scanner. Build it **once**, in M1b, as a shared utility, and M3 inherits it. Solve it twice and they will drift. |
| **D1** (duplicate types) | M2–M3 add many shared shapes. The rule is now established and enforced by re-export; worth stating in the architecture before more are added. |
| **D4** (port fallback) | M9 exposes this server to the LAN, where port conflicts are likelier and the failure is remote. The status-reporting path now exists to build on. |
| **P1** (round-trips) | M2 roughly doubles handler surface again (filters, facets, saved filters). Untested wiring compounds. |
| **D6** (stale resume) | Folds into M2's library view for free. |

---

## 5. What changed as a result of this review

| Change | Files |
|---|---|
| One definition per wire shape; `ScanProgress` derives from the contract | `scanner.ts`, `server.ts`, `shared/types.ts` |
| 10 tests for folder/file import; static import in the loop | `tests/import.test.ts`, `scanner.ts` |
| Port fallback, `error`/`usedFallbackPort` in status, UI banner and footer | `server.ts`, `shared/types.ts`, `App.tsx`, `styles.css` |
| 6 tests for playback progress, 3 for port handling | `tests/server.test.ts` |
| This review | `docs/AAR-M1.md` |

Gates after remediation: **typecheck clean · lint clean · 170 tests passing** (up from 151).

---

## 6. Actions carried into M1b / M2

1. **Bounded concurrency pool as a shared utility**, used by the scanner now and the
   providers in M3. First item of M1b. *(D3)*
2. **HLS transcode pipeline** — the original M1b scope, unchanged.
3. **IPC handler round-trip tests** — the unmet half of M1 scope item 8. *(P1)*
4. **A remote + CI actually running.** Third milestone carrying this. *(P2)*
5. Refresh the row after playback so resume isn't stale. *(D6)*
6. State the one-definition-per-wire-shape rule in ARCHITECTURE. *(D1)*

---

## 7. What went right

- **The frozen scope did its job.** It made a partial delivery visible instead of absorbable.
- **Tests found two silent data-loss bugs** that code review would not have. Both concerned
  correctness of *identity* — which file is which — where the symptom is a quietly wrong
  library rather than a crash.
- **Real media beat fixtures.** Generating an actual MKV and MP4 with identical streams
  confirmed the Matroska finding that reshaped the playback design. A JSON fixture would
  have tested my own assumption back to me.
- **The smoke test was verified to fail.** Deleting the preload produced exactly the M0
  blank-window failure, caught in seconds. Applying the M0 lesson about positive controls
  the first time it mattered.
- **Measuring beat guessing, again.** "Scanning feels like it could be slow" would have been
  a shrug. `43.5 ms/file, 98% of cold scan, 14.5 min at 20k files` is a decision.

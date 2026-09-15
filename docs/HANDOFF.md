# Que — Handoff to Claude Code

Written 2026-09-13, at the end of M1b. Implementation moves from a cloud session to Claude
Code running on the Windows machine.

**Read [PROCESS.md](PROCESS.md) first.** This document is the context that is *not* in the
other docs: what the transition is for, what is unverified, and what has already gone wrong.

---

## 1. Why the move

Three of the defects in the last two days were Windows-only, and none of them could have been
caught by the gates:

| Bug | Symptom | Why the gates missed it |
|---|---|---|
| `"bench": "QUE_BENCH=1 vitest…"` | `'QUE_BENCH' is not recognized` | POSIX env-var syntax. npm runs scripts through `cmd.exe` on Windows. Typechecks, lints, tests clean on both platforms. |
| `resources/bin/ffmpeg` with no `.exe` | Silent fallback to PATH, then "not found" | `existsSync` simply returns false. No error, no test. |
| `Expand-Archive` with `stdio: 'inherit'` | **Terminal crashed**, no logs | Child process rendering `Write-Progress` into the parent console. Cannot happen on Linux. |

The pattern is identical each time: a Windows-targeted feature, written and verified on Linux,
declared done. The cloud container cannot run `cmd.exe`, cannot run PowerShell, cannot launch
Electron with a window, and cannot play a video. CI's `build` job runs on `windows-latest` but
only does `npm run build` + `npm run test:smoke` — it never touches the scripts, the benchmark,
or playback.

**M1c is the worst possible milestone to keep that blind spot for.** It is HLS transcoding:
ffmpeg subprocesses, file paths, segment caching and actual video playback — nearly all of it
Windows-specific behaviour verifiable only by running it.

### What to do differently

1. **Run it, don't reason about it.** If a change touches a path, a subprocess, a script or the
   player, execute it on Windows before calling it done. "Typechecks and the tests pass" is not
   evidence for any of those four.
2. **`stdio: 'inherit'` on a Windows child process is a trap.** Capture and surface on failure.
   A crashed terminal produces no logs, which cost an entire round trip to diagnose.
3. **Anything platform-branching gets both branches exercised**, or the unexercised one is
   labelled unverified in the code, not silently trusted.

---

## 2. Where the project is

| | |
|---|---|
| Repo | `D:\Projects\Que` |
| Milestones | **M0, M1, M1b complete.** Next: **M1c** (HLS transcode), then M2 (search & filter UI) |
| Gates | typecheck · lint · **351 tests** · 153 of them re-run 20× (`npm run check`) |
| CI | `.github/workflows/check.yml` — four gates on Ubuntu, plus a Windows bundle + boot smoke test |
| Node | 24 LTS. **Not 25** — EOL 1 June 2026 and excluded by several dev dependencies |

What works today: source folders, recursive scan with parallel probing, drag-and-drop and
dialog import, catalogue with FTS search, HTTP/Range playback with resume, hiding and age
limits. No metadata, artwork, subtitles, playlists, grouping, skins, gamepad or LAN server yet.

M1b delivered `src/main/concurrency/` and `src/main/idempotency/` — a bounded pool, per-host
rate gate, classified retry, idempotency keys, single-flight, a two-layer response cache and a
per-row transactional apply. Nothing uses the idempotency half yet; M3's providers will.

---

## 3. Documents, and which ones you may edit

Two kinds, and conflating them breaks both.

**Living** — update every milestone: `README.md`, `docs/ARCHITECTURE.md`,
`docs/ASSUMPTIONS.md`, `docs/PROCESS.md`, `docs/OPEN-ACTIONS.md`.

**Point-in-time — never edit**: `docs/PRA-*.md`, `docs/*-SCOPE.md`, `docs/AAR-*.md`,
`docs/sanity-tests/*`. Their value is being an honest account of what was known at the time. A
record that gets tidied is not a record. When one turns out to be wrong, it is superseded, and
the correction goes in the AAR that found it plus `ASSUMPTIONS.md §H`.

`docs/sanity-tests/**` is excluded from lint for exactly this reason — see `eslint.config.js`,
where the rationale is written out.

Start with `docs/OPEN-ACTIONS.md`. It is the index of everything carried out of a review, and
it exists because closed AARs are where actions go to die.

---

## 4. Unverified on Windows — check these first

Everything below was written in the cloud session and has **never executed on Windows**. Each
is small; verifying them is a sensible first task and closes the blind spot that prompted this
handoff.

| File | What is unverified |
|---|---|
| `scripts/fetch-ffmpeg.mjs` | Rewritten after it crashed the terminal. Now tries `tar -xf` (bsdtar, Windows 10 1803+) and falls back to `Expand-Archive` with `$ProgressPreference='SilentlyContinue'`, capturing output instead of inheriting. **Neither branch has run on Windows.** |
| `scripts/bench.mjs` | Cross-platform launcher replacing the POSIX-only script. `shell: true` on win32 so `npx` resolves `npx.cmd`. |
| `tests/bench/scan.bench.test.ts` | `.exe` suffix on the bundled-binary lookup; `--dir` mode. The `--dir` guard that prevents deleting a real media folder was tested on Linux only — **re-verify before pointing it at anything you care about.** |

### Outstanding change the bridge could not make

`.github/workflows/check.yml` is protected from remote writes. One step still needs adding
after `npm test` in the `check` job:

```yaml
      - run: npm run test:concurrency
```

Without it CI runs the suites once. Concurrency defects are non-deterministic, so once is not
evidence. Takes ~15 s.

---

## 5. Traps already paid for

Each cost real time. Full detail in `docs/ASSUMPTIONS.md` and the AARs.

**Build and environment**

- `npm ci --ignore-scripts` is the fast, correct install. `--ignore-scripts` skips the ~100 MB
  Electron binary and the ffmpeg fetch; neither is needed to typecheck, lint or test.
- **No `npm rebuild better-sqlite3`.** It ships prebuilt binaries. Running rebuild wastes a
  minute and prints an alarming gyp failure that means nothing.
- Never put `node_modules` on a network-attached path. 16,343 files; >70 min there vs 9 s local.
- **Node 24 LTS, and point PATH at nvm's real binary, never its shim.** This machine has a
  standalone Node 25 (EOL 2026-06-01, excluded by `package.json`'s `engines`) in the
  *system*-level PATH, which outranks nvm's user-level entries — so a fresh terminal resolves
  `node` to 25 regardless of what nvm reports, until that is fixed with admin elevation.
  Prepend `…\nvm\installs\v24.21.0` — **not** `…\nvm\.shim` or `…\nvm\.nodejs`, which are
  736 KB proxies rather than real Node. Vitest forks its workers via `process.execPath`; through
  the proxy the worker IPC never connects, and `tests/renderer/useAsync.test.tsx` silently does
  not run at all — reported as an "unhandled error" rather than a failure, with the suite
  quietly dropping from 428 tests to 425 and taking 36 minutes instead of 23 seconds. A test
  file that vanishes without failing is the same class of bug as AAR-M1c D3; check the test
  *count*, not just the absence of red.

**Runtime**

- The preload **must** be CommonJS (`out/preload/index.cjs`). Sandboxed preloads cannot be ESM.
  Getting this wrong produces a blank window with no error — M0 lost a session to it.
- FTS5 needs **both** `content=''` and `contentless_delete=1`, and columns read back NULL, so
  every search query joins back to `media`.
- Electron 42+ no longer downloads its binary in `postinstall`; `scripts/ensure-electron.mjs`
  runs before `dev`, `start` and `build`.
- Chromium has **no Matroska demuxer at all** — a plain H.264+AAC `.mkv` will not play. This is
  the whole reason M1c exists, and it makes remux the common path, not an edge case.

**Invariants that must not be broken**

- **Restrictions (§23) are enforced in the query layer**, never in the UI, and nothing in any
  cache can change what a query returns. `tests/idempotency/restrictions-cache.test.ts` guards
  this with a positive control.
- **One definition per wire shape**, declared in `@shared/types` and re-exported.
- **No provider fetches for itself** — everything goes through `ProviderClient.request()`, or it
  bypasses cache, deduplication and rate limiting at once (M3).
- **A scan never deletes a row.** Missing files are flagged. An unplugged drive must not destroy
  a library.
- Move detection requires the other copy to be **gone from disk**, not merely hash-equal.
  Duplicates are normal; treating one as a move made the original vanish (AAR-M1 D-a).

---

## 6. M1c

**Scope**: on-demand remux and transcode for MKV and HEVC, a segment cache, and the player
fallback path. The design decisions were made in `ASSUMPTIONS.md A2` and are load-bearing:

- HLS, not fragmented MP4 over a pipe. A fragmented MP4 off a pipe has no index and the browser
  seeks by byte offset, so "restart ffmpeg with `-ss`" cannot answer the request the player
  actually makes.
- Served over the same `http://127.0.0.1` path as direct playback, so local and LAN (M9) share
  one code path.
- The common real case is MKV + H.264 + AC-3: container remux plus audio-only transcode, both
  cheap. Full video transcode is the exception.

**Carried actions it owns** (OPEN-ACTIONS #2, #3, #7):

1. **Size the transcode pool against the probe pool** — not independently. Transcoding is far
   heavier than probing and competes for the same cores; sized separately, a scan during
   playback starves the player.
2. **Fix `src/main/ffmpeg.ts`** so `probeFile` is testable outside Electron. It currently
   resolves its binary via `app.getAppPath()`, which is why the benchmark had to reimplement
   the probe call.
3. **Run `npm run bench -- --dir` against a real library.** Every performance number so far
   comes from 2-second generated clips, whose probe cost is unrealistically cheap. This is the
   first input to M1c's PRA, not a separate task.

**Known risk for its register**: M1c's correctness gate is real media and real playback, not
deterministic tests. That is slow, subjective, and exactly where the Windows blind spot lives.
Budget for manual verification and say so in the PRA's entry criteria.

**Measured context worth carrying in**: past a pool of ~2, a scan is bound by the single JS
main thread at 15.25 ms/file, not by core count — 28 cores deliver 3.06×. Transcode is a
different shape (long-running, subprocess-dominated) so do not assume the same ceiling; measure
it.

---

## 7. First moves

1. `git log --oneline -5` and `npm run check` — confirm the tree is green on Windows.
2. Add the `test:concurrency` step to `check.yml` (§4).
3. Verify the three unverified files in §4: `npm run fetch:ffmpeg`, then `npm run bench`.
4. `npm run bench -- --dir "<a few hundred real files>" --sizes 1,2,4,8` — the benchmark does a
   full cold scan per pool size, so use a subfolder rather than the whole library.
5. Write `docs/PRA-M1c.md` per PROCESS.md step 1, with §4's verification results and the
   benchmark as measured facts.
6. Freeze `docs/M1c-SCOPE.md`, then build.

Do not skip step 5. The last two phases each had a falsification criterion fire, and both times
the criterion was what turned a disappointing number into a finding rather than a quiet
adjustment.

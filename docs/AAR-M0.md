# After Action Review — M0 (Scaffold)

Reviewed 2026-09-13, immediately after M0 was declared complete and before M1 started.
Scope: everything committed to `D:\Projects\Que` during the M0 pass, assessed against
[ARCHITECTURE.md](ARCHITECTURE.md) §22 and the correction list in
[ASSUMPTIONS.md](ASSUMPTIONS.md) §G.

**Verdict: M0 delivered its scope, but shipped one serious defect, three process gaps,
and two documentation contradictions. All are fixed or documented below.**

The single most important finding is that M0 was declared "built and verified" on the
strength of a green typecheck, lint and 46 tests — **none of which exercised the running
application**. Every defect found since (blank window, runaway effect) was in exactly the
territory those gates did not cover.

---

## 1. Did the output match the plan?

### Scope: delivered, but wider than planned

The plan's M0 was:

> electron-vite + TS + React, window, preload bridge, SQLite + migrations, IPC contract,
> ffmpeg fetch script, lint/typecheck

What shipped also included the provider registry, the `que://` protocol handler, the full
search module, the group repository, and the entire hiding/age-limit feature (§23).

**Assessment: justified, but unacknowledged at the time.** The §23 addition was a
deliberate, reasoned call — it is a query-layer concern and the query chokepoint was being
built, so deferring it would have meant revisiting every query written in between. The
provider registry and `que://` were smaller judgement calls that made the shell coherent.

The problem is not the scope itself but that **the milestone table was edited to match what
was built**, rather than the deviation being recorded. That makes the plan unfalsifiable: a
milestone that expands to fit its output can never be missed. From M1 on, the milestone
definition is frozen at the start of the pass and deviations are recorded here instead.

### Corrections from ASSUMPTIONS.md §G: 8 of 12 landed, 4 correctly deferred

| # | Correction | Status |
|---|---|---|
| 1 | FTS `content=''` **and** `contentless_delete=1`; DELETE+INSERT; join to `media` | ✅ done |
| 2 | SQLite ≥ 3.45 documented as a hard minimum | ✅ done — asserted at startup in `connection.ts`, not just documented |
| 3 | Search debounce 120 ms → 60 ms | ✅ done |
| 4 | Mandatory `quote()` helper for FTS input | ✅ done, with 6 hostile-input tests |
| 5 | Playback over `http://127.0.0.1`, HLS for transcodes | ⏸ M1 as planned |
| 6 | `que://` reduced to artwork / subtitles / skins | ✅ done |
| 7 | `registerSchemesAsPrivileged` with `stream: true` | ✅ done |
| 8 | CSP gains `media-src http://127.0.0.1:*` | ✅ done |
| 9 | Remux as the common path | ⏸ M1 as planned |
| 10 | README: VS Build Tools demoted to troubleshooting | ✅ done |
| 11 | `sharp` → Electron `nativeImage` | ⚠️ **doc contradiction — see D3** |
| 12 | Skin sanitizer positive control | ⏸ M10 as planned |

---

## 2. Defects found

### D1 — `useAsync` re-ran on every render — 4,559 IPC calls in 300 ms · **Severity: high · FIXED**

`useAsync`'s dependency array was `[fn, deps, nonce]`. Every caller passes an inline arrow
and an inline `[]`, both freshly allocated each render. So the effect re-ran on every
render, resolved, set state, and rendered again — an unbounded loop.

Measured, not estimated. A reproduction of the shipped hook under jsdom:

```
expected 1, received 4559        (invocations in 300 ms, single hook)
```

Three of these hooks mount in the shell, so the running app was issuing roughly
**45,000 IPC round-trips per second**, each one a Zod parse plus a SQLite query, from the
moment the window opened. It was invisible because the results were identical and the UI
looked correct.

**Root cause is instructive.** The original code was `[...deps, nonce]` with an
`eslint-disable` comment for `react-hooks/exhaustive-deps`. I removed the disable comment
and "fixed" the dependency array to satisfy the linter — except the rule was never
installed, so I was appeasing a linter that wasn't running, and traded a correct
implementation for a broken one. A cosmetic change to silence imagined tooling introduced
the worst defect in the pass.

**Fix:** `fn` is held in a ref; the deps array is spread. Three regression tests added in
`tests/renderer/useAsync.test.tsx` covering single-invocation, correct re-run on real
dependency change, and rejection handling.

### D2 — ESM preload under `sandbox: true` · **Severity: high · FIXED (previous turn)**

`"type": "module"` made electron-vite emit `out/preload/index.mjs`, which cannot load in a
sandboxed renderer — Electron's docs are explicit that "ESM cannot be used in sandboxed
preload scripts". `window.que` was never defined and the app rendered a blank window.

Worth recording here because of **what the sanity check missed**: ASSUMPTIONS.md tested the
skin sandbox, FTS semantics, provider endpoints and native-module packaging — all deep
design risks — and never tested that the application starts. The review was
sophisticated in the places where being wrong was interesting, and absent in the place
where being wrong was fatal.

**Fix:** preload pinned to CJS output (`index.cjs`); sandbox retained. Plus `preload-error`,
`did-fail-load`, `render-process-gone` and renderer-console logging, an error boundary, a
`window.que` presence check, and auto-opened DevTools — so no failure can present as a
blank window again.

### D3 — Documentation contradicts itself on `sharp` · **Severity: low · OPEN (M7)**

ASSUMPTIONS.md §E and correction #11 say to drop `sharp` for Electron's `nativeImage`.
ARCHITECTURE.md §12.4 and the §17 security checklist still specify `sharp`. A reader
following the architecture would add a heavy native dependency the review explicitly
rejected.

Left open deliberately: the hero-upload pipeline is M7 work, and rewriting §12.4 now would
be editing a section nobody is about to implement. Recorded here so it isn't lost.

### D4 — Dropping a folder is silently skipped · **Severity: low · OPEN (M1)**

`library:import` rejects anything failing `statSync(p).isFile()`, and counts it in
`skipped`. Dropping a folder — the obvious gesture for a media library — reports
"skipped 1 unsupported" and does nothing. Folds into M1's recursive walk.

### D5 — Deprecated `console-message` signature · **Severity: trivial · FIXED (previous turn)**

Diagnostic listener used the deprecated positional form. Migrated to the object form.

---

## 3. Process gaps

### P1 — **Nothing is under version control** · **Severity: high · OPEN**

`D:\Projects\Que` is not a git repository. Forty-eight files of hand-verified work exist in
exactly one place, with no history, no diffs, and no way to revert a bad change. Every fix
in this session overwrote its predecessor with no recoverable trail.

This is the highest-impact gap in the review. It should be closed **before** M1 adds a
filesystem scanner that writes to the user's real media folders.

### P2 — No CI · **Severity: medium · OPEN**

`npm run check` exists and passes; nothing runs it automatically. Every gate in this
project is currently "the author remembered". The renderer tests added today only help if
something runs them.

### P3 — The verification gates did not cover the running app · **Severity: high · PARTIALLY CLOSED**

Typecheck, lint and 46 tests were treated as sufficient evidence to declare M0 complete.
They covered the database layer thoroughly and the application not at all:

| Layer | M0 coverage |
|---|---|
| SQL schema, migrations, FTS, filters, restrictions | 46 tests |
| IPC validation, handlers | none |
| Preload bridge | none |
| Renderer | none |
| Does it start? | none |

Both high-severity defects lived in the untested rows. **Closed for the renderer** (jsdom +
Testing Library now wired in, 3 tests). **Still open** for IPC handlers and for any form of
smoke test that the app boots.

### P4 — Missing lint rules that target the defect class · **Severity: medium · FIXED**

`eslint-plugin-react-hooks` was not installed, so `react-hooks/exhaustive-deps` — the rule
that exists precisely to catch D1 — was absent, and the `eslint-disable` comment referring
to it was inert. Now installed, wired to `src/renderer` and `tests/renderer`, and confirmed
firing against a deliberately broken probe component.

---

## 4. Downstream impact on M1 and later

| Finding | Impact if left alone |
|---|---|
| **D1** (runaway effect) | M1 adds scan progress events and a much larger library list. The same hook pattern under a real workload would have made the UI unusable and buried the cause in noise. Fixing it now is the difference between a subtle CPU burn and a visibly broken app. |
| **P1** (no git) | M1's scanner is the first code that walks and will eventually **write to** the user's real media folders. Shipping that with no ability to diff or revert is the single largest risk carried into the next pass. **Blocking.** |
| **P3** (no IPC/boot tests) | M1 roughly doubles the IPC surface (`library:scan`, progress events, the streaming server). Untested handler wiring scales badly: each new channel is another thing only a manual click can verify. |
| **D4** (folder drops) | Folds naturally into M1's recursive walk — no extra cost if done together, a second pass over the same code if not. |
| **D3** (`sharp`) | None until M7. Recorded. |
| Scope discipline | M1 has a genuinely large surface (scanner, ffprobe, move detection, streaming server, HLS). Without a frozen definition it will absorb M2 and M3 work and "complete" while unfinished. |

---

## 5. What changed as a result of this review

| Change | File |
|---|---|
| `useAsync` rewritten: `fn` in a ref, deps spread | `src/renderer/src/app/App.tsx` |
| 3 regression tests (single-invocation, real dep change, rejection) | `tests/renderer/useAsync.test.tsx` |
| jsdom + Testing Library wired into vitest; `.tsx` tests included | `vitest.config.ts`, `tsconfig.web.json`, `package.json` |
| `eslint-plugin-react-hooks` installed and scoped to renderer code | `eslint.config.js`, `package.json` |
| This review | `docs/AAR-M0.md` |

Gates after remediation: **typecheck clean · lint clean · 49 tests passing**.

---

## 6. Actions carried into M1

1. **`git init`, commit the M0 tree, and commit per milestone from here.** Blocking — do it before the scanner is written. *(P1)*
2. **Freeze the M1 definition before starting**, and record any deviation in the M1 AAR rather than editing the milestone. *(scope discipline)*
3. **Add IPC handler tests** covering Zod rejection of malformed arguments and at least one round-trip per channel family. *(P3)*
4. **Add a boot smoke test** — launch the packaged main process headlessly and assert the window loads and `app:info` answers. This is the gate that would have caught D2 in seconds. *(P3)*
5. **Handle folder drops** as part of the recursive walk. *(D4)*
6. **Add CI** running `npm run check` — cheap once git exists. *(P2)*
7. Reconcile `sharp` → `nativeImage` in ARCHITECTURE §12.4 and §17 when M7 is planned. *(D3)*

---

## 7. What went right

Worth recording, because these are the practices that caught things rather than missed them.

- **The empirical sanity check earned its keep.** The FTS finding (A1) would have been a
  silent, unfixable search index; it was caught before a line of code depended on it.
- **The type system caught a security hole.** `search:global` originally queried `media`
  directly, bypassing the §23 restriction clauses. Adding fields to `MediaSummary` broke the
  handler at compile time, which is how it was found.
- **The tests caught an architecture smell.** The repo layer reaching into Electron via
  `settings` only surfaced because tests exercised the repos without Electron present. The
  resulting dependency inversion is better design, and it came from testability pressure.
- **Failure diagnostics were added at the right moment** — immediately after a failure mode
  that cost real time — rather than deferred to a "polish" milestone.
- **Every external claim was verified against a primary source.** Electron's ESM matrix,
  the removed postinstall, Node 25's EOL date, and the `console-message` signature were all
  checked rather than recalled, and each check changed the outcome.

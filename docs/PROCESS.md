# Que — Development Process

Every milestone runs the same loop.

```
1. Assumptions, risks & integration assessment      ─┐
2. Initial downstream consideration review           ├─ before a line is written
   ── Scope freeze ──                                │
3. Initial living documentation entry               ─┘

4. Implementation  →  gates

5. After-action review                              ─┐
6. Post downstream consideration review              ├─ before the next phase starts
7. Report summary                                    │
8. Remaining usage check                            ─┘
```

Steps 1–3 and 5–8 are the numbered workflow. The **scope freeze** and the **gates** are the
two additions to it, and they are there because each one caught something a previous
milestone would otherwise have shipped quietly — see the standing rules at the end.

---

## The eight steps

### 1. Assumptions, risks & integration assessment

Written to `docs/PRA-<phase>.md`, before any code exists.

A PRA is not a plan — the plan is `ARCHITECTURE.md §22`. It is an argument about whether that
plan survives contact with what is now known.

**Inputs.** Every open item from the previous AAR, every unanswered open question from the
previous PRA, every relevant entry in `ASSUMPTIONS.md`, every architecture section the phase
touches. Listed explicitly, so a reader can tell what was considered and what was not.

**What changed since the plan was written.** The plan predates all the code. State the deltas.

**Measured facts.** Numbers, with the method that produced them. Where the design rests on a
claim about a third party — a rate limit, an API contract, a runtime behaviour — the claim is
checked against a primary source and cited, or labelled an assumption and entered in the
register.

> Prefer an executable demonstration over an assertion. A dependency-free harness that
> produces a table of numbers is cheap, is a design document that cannot lie, and frequently
> changes the design. Every time this project has run one, the result was not what was
> expected. `docs/sanity-tests/idempotency.mjs` inverted an instruction that sounded obviously
> right, and did it before any code existed.

**Corrections to the brief.** If the stated requirement rests on a premise that does not hold,
say so here. Correcting a brief is cheap in a PRA and expensive in an AAR.

**Design.** The mechanism, at the level of interfaces and invariants. Not code.

**Risk register.** Each risk gets an ID, a severity, a *detection method*, and a mitigation. A
risk with no detection method is a risk we will hear about from a bug report.

**Entry criteria.** What must be true before the phase starts. If one is unmet, say so and
name the compensating control.

**Falsification.** What evidence, discovered mid-phase, would mean the design is wrong and the
phase should stop. Written in advance, while it is still cheap to be honest.

> This section is load-bearing, not ceremony. M1b's fired twice, and both firings were useful.
> The pool returned 1.98× against a predicted 8×; the first investigation concluded "CPU-bound,
> ceiling is the core count", which a 28-core machine then falsified in turn. The eventual
> answer — a scan is bound by the single JS main thread past a pool of ~2 — corrected a number
> two milestones had been reasoning from. Without the criterion on paper, the likely outcome
> each time was adjusting the threshold and moving on.
>
> The sharper lesson is in the second firing: **a conclusion drawn from one machine is a
> hypothesis, not a finding.** A 2-core box cannot distinguish "CPU-bound" from any other
> bottleneck, because every candidate predicts about 2× there.

### 2. Initial downstream consideration review

A table with a row per later milestone: what this phase gives it, what it constrains, what it
would cost to defer. This is what makes the assessment plan-wide rather than a design doc for
one phase.

It lives in the PRA as its own section (`§6` by convention) rather than as a separate
document. Steps 1 and 2 ask genuinely different questions — *what could go wrong in this
phase* versus *what does this phase do to every later one* — but they are answered by one
person in one sitting from one set of facts, and splitting the artifact means maintaining the
same table twice.

### Scope freeze

`docs/<phase>-SCOPE.md`: numbered, testable items, plus explicit out-of-scope, entry actions
and exit criteria. Copied from the PRA and **not edited during the phase**.

This is not optional. It is the mechanism that makes step 5 able to report "8 of 9, one
partial" instead of quietly redefining done, which is exactly what M0 did before the freeze
existed.

### 3. Initial living documentation entry

The **contract**, not the description. Specifically:

- the section heading is created, so later work has somewhere to land;
- the invariants other code must obey are stated (for M1b: *no provider fetches for itself*);
- a `status: building` marker names the phase.

**No measurements, no claims about how it behaves, no predictions.** Those go in the PRA,
which is explicitly a speculative document and is read as one. The living docs describe what
exists; if they describe intent, they are wrong the moment implementation deviates — and it
deviates. Written against intent, `ARCHITECTURE §10.5` would today claim the cache reuses
`http_cache`, that ffprobe is I/O-bound, and that the pool gives 8×. All three are false.

### 4. Implementation

Build what is frozen. Nothing else.

**Gates before the phase can close:** typecheck clean · lint clean · full test suite ·
concurrency suites under `--repeats=20` (`npm run check` runs all four) · plus any
phase-specific exit criterion named in the scope doc. CI (`.github/workflows/check.yml`) runs
the same four on every push, plus a Windows bundle and the boot smoke test.

**The tree you gate must be the tree that ships.** A gate run against a partial checkout
proves nothing about the repository. This is not hypothetical: M1b's lint passed locally and
failed in CI on its first run, because the container copy had been assembled from source files
and was missing `docs/sanity-tests/` entirely — four files `eslint .` had therefore never
seen. Before running gates, verify the working tree matches the repository:

```bash
diff -rq --exclude=node_modules --exclude=out --exclude=dist \
         --exclude=.git --exclude=package-lock.json <repo> <working copy>
```

Anything reported as *"Only in \<repo\>"* is a file the gates are not covering.

Every guard ships with a verified control. A test that has never been seen to fail proves
nothing — this applies to the process too: the `--repeats` harness was only trusted after a
deliberately flaky test was shown to pass a single run and fail under repetition.

The same test applies to **silencing** a gate. Excluding a file from lint, skipping a test,
loosening a threshold — each is sometimes correct and each is the easiest possible way to get
green. The question to answer in the commit, in writing: *would this gate ever have prevented
a defect that reaches a user?* `docs/sanity-tests/**` is excluded from lint because those files
are frozen records nothing imports, run directly, whose output is itself the check — and the
exclusion was verified not to be a blanket by confirming lint still errors on a planted
violation under `src/`. A failure under `src/` or `tests/` is never resolved this way.

### 5. After-action review

Written to `docs/AAR-<phase>.md`.

1. **Scope table** — every frozen item, delivered / partial / not delivered. A partial is
   reported as a partial. The scope is never edited to match the output.
2. **Defects found in the review**, each with severity and disposition (fixed now, or carried
   with the phase that owns it).
3. **Falsification outcome** — if a criterion from PRA §Falsification fired, what the
   investigation concluded and what changed as a result.
4. **Process findings** — where the method failed, kept separate from where the code failed.
5. **Downstream impact** (this is step 6, below).
6. **What changed as a result**, with files, and the gate results.
7. **Actions carried forward**, numbered, each tagged with the finding that produced it.
8. **What went right** — specifically what to repeat, not encouragement.

### 6. Post downstream consideration review

The same table as step 2, re-answered with what the phase actually taught. It lives as the
downstream-impact section of the AAR.

Two obligations, because this is the step most likely to evaporate into a list nobody reads:

- **A finding that changes a later milestone is written into that milestone**, not only into
  the AAR — into `ARCHITECTURE §22`, or carried explicitly into the next PRA's Inputs. An
  action that exists only in a closed AAR will not be found when it matters.
- **`OPEN-ACTIONS.md` is reconciled.** New actions added, closed ones struck through with how
  they were closed. AARs are frozen, so an action raised in M1 and closed in M3 leaves no trace
  in the document that raised it, and the next PRA gathers items from *the previous* AAR only —
  which loses anything deferred twice. That table is the index; the AARs stay the account.
- **Living docs are reconciled to as-built here.** The `status: building` markers from step 3
  come off, measurements and deviations go in, and the staleness checklist below is walked.

### 7. Report summary

A comprehensive but readable summary — what was built, what was found, what it cost, what is
open. Delivered in conversation, not as a file: the AAR is the durable record, and a second
document saying the same thing in a friendlier voice is a second document to keep in sync.

### 8. Remaining usage check

Report remaining session context and, where visible, account usage, so the next phase can be
sized against what is actually left rather than started and abandoned halfway.

---

## Working in the cloud workspace

Implementation happens in an ephemeral Linux container, not on the Windows machine. There are
two filesystems in play and they perform about three orders of magnitude apart.

**The rule: `node_modules` never lives on the attached folder.** `node_modules` is 16,343 files
across 357 packages. On the attached mount every one of those is a network round trip; on the
container's local disk it is a local write. Measured, same tree, same command:

| | Attached mount | Local disk |
|---|---|---|
| `npm install` | **>70 min, killed unfinished** | **9 s** |

That single mistake cost more than the entire rest of the M1b build. It is not a subtle
performance question — it is the difference between a workable pass and an unworkable one.

### The recipe

```bash
# 1. Copy the repo to local disk, excluding node_modules.
tar cf - --exclude=node_modules . | (cd ~/que && tar xf -)

# 2. Install. 9 s cold, and it is all that is needed.
cd ~/que && npm ci --ignore-scripts --no-audit --no-fund

# 3. Gates. 23 s.
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json \
  && npx eslint . && npx vitest run
```

Thirty-two seconds from nothing to a verified tree. Three things about it are deliberate:

- **`npm ci`, not `npm install`.** `ci` is deterministic and, more importantly, **never rewrites
  the lockfile**. `npm install` on Linux regenerates `package-lock.json`, and committing that
  back over the Windows-resolved one is a trap worth avoiding entirely. `package-lock.json` is
  never committed back from the container.
- **`--ignore-scripts`.** Skips the ~100 MB Electron binary download and the ffmpeg fetch,
  neither of which a typecheck/lint/test run needs. The app is never launched here.
- **No `npm rebuild better-sqlite3`.** Verified unnecessary: better-sqlite3 13 ships its
  prebuilt binary inside the npm package, so it works straight after `npm ci --ignore-scripts`.
  Running `rebuild` anyway wastes a minute and prints an alarming gyp failure that is not a
  failure at all.

### Syncing back

Derive the file list mechanically, never from memory:

```bash
diff -rq --exclude=node_modules --exclude=out --exclude=dist \
         --exclude=.git --exclude=package-lock.json ~/que <attached>/que
```

Hand-listing files to copy back is how one gets missed, and a missed file is a phase that
typechecks in the container and fails on the machine.

### Don't install when nothing needs installing

Only step 4 needs a working tree. Steps 1–3 and 5–8 — assessment, freeze, doc stub, review,
report — are reading and writing. A dependency-free harness (`docs/sanity-tests/`) is
deliberately dependency-free so that step 1 never waits on an install. When a pass does need
one, start it in the background at the beginning of step 1; by step 4 it has been ready for
half an hour.

---

## Living documents, and keeping them honest

Two kinds of document, and conflating them is how both become useless.

| | Living | Point-in-time |
|---|---|---|
| Files | `README.md`, `ARCHITECTURE.md`, `ASSUMPTIONS.md`, `PROCESS.md`, `OPEN-ACTIONS.md`, `HANDOFF.md` | `PRA-*.md`, `*-SCOPE.md`, `AAR-*.md`, `sanity-tests/*` |
| Describes | Que as it is now | what was known, or decided, at one moment |
| Edited | every milestone | **never** — a record that gets tidied is not a record |

A point-in-time document that turns out to be wrong is not corrected. It is superseded, and
the correction is recorded where it belongs: in the AAR that found it, and in
`ASSUMPTIONS.md §H`.

### Staleness checklist — walk this at step 6, every phase

| Doc | Check |
|---|---|
| `README.md` | **Status block** — milestones complete, test count, what works today, what's next. Goes stale fastest and is the first thing anyone reads. |
| | **Command reference** — any script added, removed or changed in `package.json`. Milestone tags on commands that don't exist yet still point at the right milestone. |
| | **Troubleshooting** — a new failure surface built this phase (a new banner, a new error, a new slow path) needs a row. |
| | **Documentation index** — new docs listed, under the right heading. |
| `ARCHITECTURE.md` | The section this phase touched, reconciled to as-built. **§22 milestone table** — ticks, splits, reordering. Any rule the phase established that future code must follow. |
| `ASSUMPTIONS.md` | **§H** — anything the phase overturned, with what changed as a result. New harnesses added to the test-artifacts table. |
| `OPEN-ACTIONS.md` | **Every phase.** New actions in, closed ones struck through with how. This is the one that silently rots if skipped, because nothing else references it. |
| `PROCESS.md` | Only when the process itself changed. A standing rule earned by a defect goes in the table below. |

---

## Standing rules

Each came out of a specific failure and applies to every phase.

| Rule | Origin |
|---|---|
| Freeze the scope in writing before starting; check the result against it line by line. | AAR-M0 — the milestone was edited to match what was built |
| A test that has never been seen to fail proves nothing. Every guard ships with a verified control. | AAR-M0 — a sandbox test passed because its control never ran |
| One definition per wire shape, declared in `@shared/types` and re-exported. | AAR-M1 D1 |
| Validation and dispatch are one function, so tests exercise the path that actually runs. | AAR-M1 P1 → AAR-M1b |
| Remediation ships with tests, or it is not remediation. | AAR-M1 D2 |
| Measure before deciding. "Feels slow" is not a finding; `43.5 ms/file, 98% of cold scan` is. | AAR-M1 D3 |
| Measure the floor as well as the ceiling — otherwise you cannot tell whose time you are optimising. | AAR-M1b §3 |
| Write the test that describes the ugly case, not the polite one. | AAR-M1b D2 — a timeout that signalled but never released |
| Check third-party claims against primary sources. Every check so far has changed an outcome. | M0 — Electron postinstall, ESM/sandbox matrix, Node 25 EOL |
| A lint rule that is not installed is not a lint rule. Disabling comments for absent rules are silently inert. | M0 — `useAsync`, 4,559 invocations in 300 ms |
| No mutable module-scope state in a layer that can be instantiated twice. | AAR-M1b D5 |

---

## Sequence

```
PRA-<phase>.md  →  <phase>-SCOPE.md  →  doc stub  →  build  →  gates  →  AAR-<phase>.md
      ▲                                                                        │
      └──────────── open actions and unanswered questions feed forward ────────┘
```

A phase does not begin until its PRA is written, and does not end until its AAR is. Both are
committed to `docs/`.

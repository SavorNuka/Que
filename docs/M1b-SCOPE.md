# M1b — Frozen Scope

Frozen 2026-09-13 from [PRA-M1b.md](PRA-M1b.md) §11. **Not edited during the phase.**
AAR-M1b checks the output against this list line by line.

**M1b is concurrency & idempotency only.** HLS transcoding moves to M1c (PRA-M1b §7).

---

## In scope

| # | Item |
|---|---|
| 1 | **Bounded concurrency pool** — configurable size, error isolation (one rejection does not sink the batch), ordered results, cancellation, injected clock. A shared utility in `src/main/concurrency/`, not scanner-local. |
| 2 | **Rate gate** — per-host minimum interval + token bucket, applied at dispatch, independent of pool size. |
| 3 | **Retry** — classified-transient errors only, exponential backoff with jitter, capped attempts, routed back through the gate. |
| 4 | **Idempotency key builder** — pure, versioned (`v1:`), normalising; covers origin identity and every response-varying parameter. |
| 5 | **Single-flight layer** — cache check and in-flight check both before any `await`; in-flight cleared in `finally`; a caller that aborts detaches without cancelling its joiners. |
| 6 | **Two-layer cache** — in-memory map + `http_cache`, with the outcome policy and TTLs from PRA-M1b §5.5. |
| 7 | **Scanner uses the pool for ffprobe**, with existing cancellation preserved. |
| 8 | **Tests**, each with a verified negative control where it guards something: (a) concurrent duplicates collapse to one call · (b) distinct resources never collide, shared resources do share · (c) a response-varying parameter changes the key · (d) a transient failure does not poison the key · (e) abort detaches the caller without cancelling joiners · (f) a never-settling request times out and clears · (g) a hidden row stays refused with a warm cache · (h) per-row application is transactional and idempotent on re-run |
| 9 | **IPC handler round-trip tests** — the unmet half of M1 scope item 8 (AAR-M1 P1). |
| 10 | **ARCHITECTURE updates** — §7 rate gate in the provider contract · §8 key schema and TTL policy · §22 M1b/M1c split · the one-definition-per-wire-shape rule (AAR-M1 D1). |

## Out of scope

HLS transcoding (→ M1c) · any actual provider implementation (→ M3) · distributed or
cross-process idempotency (→ revisit at M9) · file watching · a user-facing "re-match" action
(→ M3; the invalidation primitive is built here).

---

## Entry actions

1. `git add -A && git commit` the AAR-M1 remediation. M1b must not start on an uncommitted tree.

## Exit criteria

- Typecheck clean · lint clean · all tests passing · concurrency tests passing under
  `vitest --repeat=20` (compensating control for absent CI — PRA-M1b §10).
- A measured before/after on a real cold scan, reported in AAR-M1b. **Prediction on record:
  ~14.5 min → ~2–3 min at 20,000 files.** A miss is reported as a miss.
- `docs/sanity-tests/idempotency.mjs` re-runs and its table is reproduced in AAR-M1b.

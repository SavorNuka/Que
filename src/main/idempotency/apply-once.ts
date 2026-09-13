import type { Db } from '../db/connection';

/**
 * Per-row idempotent application (PRA-M1b §5.6).
 *
 * The brief's "idempotency per row rather than per operation" does not stop at
 * the fetch. When a metadata pass writes 5,000 rows, cancelling it halfway
 * must leave 2,500 complete rows and 2,500 untouched ones — never a row with
 * its title updated and its artwork missing. That is what makes a pass safe to
 * re-run, which is what makes it resumable.
 *
 * Two properties:
 *
 *  - **Atomic per row.** The write and its ledger entry commit together, so a
 *    crash between them is impossible.
 *  - **A no-op on re-run.** Re-applying the same key writes nothing and
 *    reports `false`, so a resumed pass skips what it already did instead of
 *    re-deriving it.
 *
 * `apply` must be synchronous. better-sqlite3 transactions are synchronous —
 * awaiting inside one would commit at an arbitrary point. The shape this
 * enforces is the right one anyway: fetch first (slow, retryable, cancellable),
 * then apply (fast, atomic).
 */

export interface ApplyOnceResult {
  applied: boolean;
  /** When the work was first applied — the earlier time on a re-run. */
  appliedAt: number;
}

export function applyOnce(
  db: Db,
  key: string,
  mediaId: number | null,
  apply: () => void,
  now: number = Date.now()
): ApplyOnceResult {
  const run = db.transaction((): ApplyOnceResult => {
    const existing = db.prepare(`SELECT applied_at FROM applied_ops WHERE key = ?`).get(key) as
      | { applied_at: number }
      | undefined;

    if (existing) return { applied: false, appliedAt: existing.applied_at };

    apply();

    db.prepare(`INSERT INTO applied_ops (key, media_id, applied_at) VALUES (?, ?, ?)`).run(
      key,
      mediaId,
      now
    );

    return { applied: true, appliedAt: now };
  });

  return run();
}

export function hasApplied(db: Db, key: string): boolean {
  return db.prepare(`SELECT 1 FROM applied_ops WHERE key = ?`).get(key) !== undefined;
}

/** Forget one application so it will run again. */
export function forgetApplied(db: Db, key: string): number {
  return db.prepare(`DELETE FROM applied_ops WHERE key = ?`).run(key).changes;
}

/**
 * Forget everything applied to one row — the ledger half of "re-match this
 * item". Invalidating the cache alone is not enough: without this, the fetch
 * would repeat and the apply would still be skipped.
 */
export function forgetAppliedForMedia(db: Db, mediaId: number): number {
  return db.prepare(`DELETE FROM applied_ops WHERE media_id = ?`).run(mediaId).changes;
}

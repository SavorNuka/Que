import type { Db } from '../db/connection';
import type { KeyDescriptor } from './key';

/**
 * The response cache — two layers with two different lifetimes.
 *
 * | layer     | lifetime | why it exists                                       |
 * |-----------|----------|-----------------------------------------------------|
 * | memory    | process  | serves a hit with zero I/O; the layer single-flight  |
 * |           |          | checks before deciding to execute                   |
 * | SQLite    | forever  | a second scan does not re-spend the rate budget      |
 *
 * Harness M-5: on a 5,000-track library, deduplicating takes MusicBrainz calls
 * from 15,000 to 5,520 — 250 minutes down to 92 at the published 1 req/s. The
 * persistent layer is what stops the next scan paying that again.
 *
 * Both layers are synchronous. better-sqlite3 is a synchronous driver, which
 * is exactly what this design wants: `get` runs between the caller arriving and
 * the in-flight registration with no `await` in between, so the check-then-act
 * window (harness M-1) is not merely small — it does not exist.
 */

export type CacheOutcome = 'success' | 'negative';

export interface CacheHit<T> {
  value: T | null;
  outcome: CacheOutcome;
  fetchedAt: number;
  expiresAt: number | null;
  /** Carried so an entry can be traced back to who answered (PRA-M1b R4). */
  descriptor: KeyDescriptor;
}

export interface CacheWrite {
  descriptor: KeyDescriptor;
  outcome: CacheOutcome;
  value: unknown;
  now: number;
  /** null means "until explicitly invalidated". */
  expiresAt: number | null;
}

export interface ProviderCache {
  get<T>(key: string, now: number): CacheHit<T> | null;
  set(write: CacheWrite): void;
  /** Drop every entry for one resource — the "re-match this item" primitive. */
  invalidateOrigin(origin: string): number;
  invalidateKey(key: string): number;
  purgeExpired(now: number): number;
  size(): number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * TTLs by outcome (PRA-M1b §5.5).
 *
 * A success does not expire: the answer to "which album is this" does not
 * change, and a wrong one is corrected by invalidation rather than by waiting.
 * A definitive negative does expire, because "MusicBrainz has never heard of
 * this B-side" is true only until someone adds it.
 *
 * Transient failures appear nowhere in this table. A failure to ask is not an
 * answer and is never stored — harness M-4.
 */
export interface CachePolicy {
  successTtlMs: number | null;
  negativeTtlMs: number | null;
}

export const DEFAULT_POLICY: CachePolicy = {
  successTtlMs: null,
  negativeTtlMs: 30 * DAY_MS,
};

export function expiryFor(
  outcome: CacheOutcome,
  now: number,
  policy: CachePolicy = DEFAULT_POLICY
): number | null {
  const ttl = outcome === 'success' ? policy.successTtlMs : policy.negativeTtlMs;
  return ttl === null ? null : now + ttl;
}

interface MemoryRow {
  body: string;
  outcome: CacheOutcome;
  fetchedAt: number;
  expiresAt: number | null;
  descriptor: KeyDescriptor;
}

export class MemoryCache implements ProviderCache {
  #rows = new Map<string, MemoryRow>();
  #limit: number;

  constructor(limit = 20_000) {
    this.#limit = limit;
  }

  get<T>(key: string, now: number): CacheHit<T> | null {
    const row = this.#rows.get(key);
    if (!row) return null;

    if (row.expiresAt !== null && row.expiresAt <= now) {
      this.#rows.delete(key);
      return null;
    }

    // Re-insert to refresh recency for the LRU bound.
    this.#rows.delete(key);
    this.#rows.set(key, row);

    return {
      value: JSON.parse(row.body) as T,
      outcome: row.outcome,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      descriptor: row.descriptor,
    };
  }

  set(write: CacheWrite): void {
    this.#rows.delete(write.descriptor.key);
    this.#rows.set(write.descriptor.key, {
      body: JSON.stringify(write.value ?? null),
      outcome: write.outcome,
      fetchedAt: write.now,
      expiresAt: write.expiresAt,
      descriptor: write.descriptor,
    });

    while (this.#rows.size > this.#limit) {
      const oldest = this.#rows.keys().next();
      if (oldest.done) break;
      this.#rows.delete(oldest.value);
    }
  }

  invalidateOrigin(origin: string): number {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.descriptor.origin === origin) {
        this.#rows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  invalidateKey(key: string): number {
    return this.#rows.delete(key) ? 1 : 0;
  }

  purgeExpired(now: number): number {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.expiresAt !== null && row.expiresAt <= now) {
        this.#rows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.#rows.size;
  }
}

interface CacheRow {
  key: string;
  body: string;
  outcome: CacheOutcome;
  fetched_at: number;
  expires_at: number | null;
  provider: string;
  capability: string;
  origin: string;
}

export class SqliteCache implements ProviderCache {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get<T>(key: string, now: number): CacheHit<T> | null {
    const row = this.#db
      .prepare(
        `SELECT key, body, outcome, fetched_at, expires_at, provider, capability, origin
           FROM provider_cache WHERE key = ?`
      )
      .get(key) as CacheRow | undefined;

    if (!row) return null;

    if (row.expires_at !== null && row.expires_at <= now) {
      this.#db.prepare(`DELETE FROM provider_cache WHERE key = ?`).run(key);
      return null;
    }

    return {
      value: JSON.parse(row.body) as T,
      outcome: row.outcome,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      descriptor: {
        key: row.key,
        provider: row.provider,
        capability: row.capability,
        origin: row.origin,
      },
    };
  }

  set(write: CacheWrite): void {
    this.#db
      .prepare(
        `INSERT INTO provider_cache (key, provider, capability, origin, outcome, body, fetched_at, expires_at)
         VALUES (@key, @provider, @capability, @origin, @outcome, @body, @fetchedAt, @expiresAt)
         ON CONFLICT(key) DO UPDATE SET
           outcome    = excluded.outcome,
           body       = excluded.body,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at`
      )
      .run({
        key: write.descriptor.key,
        provider: write.descriptor.provider,
        capability: write.descriptor.capability,
        origin: write.descriptor.origin,
        outcome: write.outcome,
        body: JSON.stringify(write.value ?? null),
        fetchedAt: write.now,
        expiresAt: write.expiresAt,
      });
  }

  invalidateOrigin(origin: string): number {
    return this.#db.prepare(`DELETE FROM provider_cache WHERE origin = ?`).run(origin).changes;
  }

  invalidateKey(key: string): number {
    return this.#db.prepare(`DELETE FROM provider_cache WHERE key = ?`).run(key).changes;
  }

  purgeExpired(now: number): number {
    return this.#db
      .prepare(`DELETE FROM provider_cache WHERE expires_at IS NOT NULL AND expires_at <= ?`)
      .run(now).changes;
  }

  size(): number {
    return (this.#db.prepare(`SELECT COUNT(*) AS n FROM provider_cache`).get() as { n: number }).n;
  }
}

/**
 * Memory in front of SQLite.
 *
 * A hit in the slow layer promotes into the fast one carrying its full
 * descriptor and expiry, so a promoted entry is indistinguishable from a
 * freshly written one — including to `invalidateOrigin`, which would otherwise
 * leave a stale promotion behind after a re-match.
 */
export class LayeredCache implements ProviderCache {
  #fast: ProviderCache;
  #slow: ProviderCache;

  constructor(fast: ProviderCache, slow: ProviderCache) {
    this.#fast = fast;
    this.#slow = slow;
  }

  get<T>(key: string, now: number): CacheHit<T> | null {
    const hot = this.#fast.get<T>(key, now);
    if (hot) return hot;

    const cold = this.#slow.get<T>(key, now);
    if (!cold) return null;

    this.#fast.set({
      descriptor: cold.descriptor,
      outcome: cold.outcome,
      value: cold.value,
      now: cold.fetchedAt,
      expiresAt: cold.expiresAt,
    });

    return cold;
  }

  set(write: CacheWrite): void {
    this.#fast.set(write);
    this.#slow.set(write);
  }

  invalidateOrigin(origin: string): number {
    this.#fast.invalidateOrigin(origin);
    return this.#slow.invalidateOrigin(origin);
  }

  invalidateKey(key: string): number {
    this.#fast.invalidateKey(key);
    return this.#slow.invalidateKey(key);
  }

  purgeExpired(now: number): number {
    this.#fast.purgeExpired(now);
    return this.#slow.purgeExpired(now);
  }

  size(): number {
    return this.#slow.size();
  }
}

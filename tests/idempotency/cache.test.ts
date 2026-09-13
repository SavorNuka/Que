import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/main/db/connection';
import {
  DAY_MS,
  DEFAULT_POLICY,
  LayeredCache,
  MemoryCache,
  SqliteCache,
  expiryFor,
} from '../../src/main/idempotency/cache';
import { describeKey } from '../../src/main/idempotency/key';
import { freshDb } from '../helpers/db';

const descriptor = (id: string, capability = 'music-metadata'): ReturnType<typeof describeKey> =>
  describeKey({ provider: 'musicbrainz', capability, origin: { kind: 'release', id } });

describe('cache policy', () => {
  /**
   * PRA-M1b §5.5. The three outcomes have three lifetimes, and the one that
   * matters most is the one absent from this table: a transient failure is
   * never written at all (harness M-4).
   */
  it('keeps a success until it is explicitly invalidated', () => {
    expect(expiryFor('success', 1000)).toBeNull();
  });

  it('expires a definitive negative, so a later-added release is found', () => {
    expect(expiryFor('negative', 1000)).toBe(1000 + 30 * DAY_MS);
    expect(DEFAULT_POLICY.negativeTtlMs).toBe(30 * DAY_MS);
  });

  it('accepts a policy override', () => {
    expect(expiryFor('success', 0, { successTtlMs: 60_000, negativeTtlMs: null })).toBe(60_000);
    expect(expiryFor('negative', 0, { successTtlMs: null, negativeTtlMs: null })).toBeNull();
  });
});

describe('MemoryCache', () => {
  const make = (): { cache: MemoryCache } => ({ cache: new MemoryCache() });

  it('returns a miss for an unknown key', () => {
    const { cache } = make();
    expect(cache.get('nope', 0)).toBeNull();
  });

  it('round-trips a value', () => {
    const { cache } = make();
    const d = descriptor('mbid-1');
    cache.set({ descriptor: d, outcome: 'success', value: { title: 'Kid A' }, now: 100, expiresAt: null });

    const hit = cache.get<{ title: string }>(d.key, 200);
    expect(hit?.value).toEqual({ title: 'Kid A' });
    expect(hit?.outcome).toBe('success');
    expect(hit?.fetchedAt).toBe(100);
  });

  it('stores a negative as a null value rather than as a miss', () => {
    const { cache } = make();
    const d = descriptor('mbid-2');
    cache.set({ descriptor: d, outcome: 'negative', value: null, now: 0, expiresAt: 1000 });

    const hit = cache.get(d.key, 500);
    expect(hit).not.toBeNull();
    expect(hit?.outcome).toBe('negative');
    expect(hit?.value).toBeNull();
  });

  it('treats an expired entry as a miss and removes it', () => {
    const { cache } = make();
    const d = descriptor('mbid-3');
    cache.set({ descriptor: d, outcome: 'negative', value: null, now: 0, expiresAt: 1000 });

    expect(cache.get(d.key, 999)).not.toBeNull();
    expect(cache.get(d.key, 1000)).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('overwrites rather than duplicating', () => {
    const { cache } = make();
    const d = descriptor('mbid-4');
    cache.set({ descriptor: d, outcome: 'success', value: 'first', now: 0, expiresAt: null });
    cache.set({ descriptor: d, outcome: 'success', value: 'second', now: 10, expiresAt: null });

    expect(cache.size()).toBe(1);
    expect(cache.get<string>(d.key, 20)?.value).toBe('second');
  });

  /**
   * PRA-M1b R4 — "re-match this item". Every variant for the resource must go,
   * across providers, capabilities and parameters, or the correction only half
   * applies and the user sees the old artwork with the new title.
   */
  it('invalidates every entry for one resource at once', () => {
    const { cache } = make();
    const metadata = describeKey({
      provider: 'musicbrainz',
      capability: 'music-metadata',
      origin: { kind: 'release', id: 'mbid-5' },
    });
    const artwork = describeKey({
      provider: 'coverartarchive',
      capability: 'music-artwork',
      origin: { kind: 'release', id: 'mbid-5' },
    });
    const other = descriptor('mbid-6');

    for (const d of [metadata, artwork, other]) {
      cache.set({ descriptor: d, outcome: 'success', value: 1, now: 0, expiresAt: null });
    }

    expect(cache.invalidateOrigin(metadata.origin)).toBe(2);
    expect(cache.get(metadata.key, 0)).toBeNull();
    expect(cache.get(artwork.key, 0)).toBeNull();
    expect(cache.get(other.key, 0)).not.toBeNull();
  });

  it('purges expired entries in bulk', () => {
    const { cache } = make();
    cache.set({ descriptor: descriptor('a'), outcome: 'negative', value: null, now: 0, expiresAt: 100 });
    cache.set({ descriptor: descriptor('b'), outcome: 'negative', value: null, now: 0, expiresAt: 5000 });
    cache.set({ descriptor: descriptor('c'), outcome: 'success', value: 1, now: 0, expiresAt: null });

    expect(cache.purgeExpired(1000)).toBe(1);
    expect(cache.size()).toBe(2);
  });
});

describe('MemoryCache — bounded', () => {
  it('evicts least-recently-used entries past its limit', () => {
    const cache = new MemoryCache(3);
    for (const id of ['a', 'b', 'c']) {
      cache.set({ descriptor: descriptor(id), outcome: 'success', value: id, now: 0, expiresAt: null });
    }

    // Touch 'a' so 'b' becomes the least recent.
    cache.get(descriptor('a').key, 0);
    cache.set({ descriptor: descriptor('d'), outcome: 'success', value: 'd', now: 0, expiresAt: null });

    expect(cache.size()).toBe(3);
    expect(cache.get(descriptor('a').key, 0)).not.toBeNull();
    expect(cache.get(descriptor('b').key, 0)).toBeNull();
  });
});

describe('SqliteCache', () => {
  let db: Db;
  let cache: SqliteCache;

  beforeEach(() => {
    db = freshDb();
    cache = new SqliteCache(db);
  });
  afterEach(() => db.close());

  it('survives being reopened — this is the point of the layer', () => {
    const d = descriptor('mbid-persist');
    cache.set({ descriptor: d, outcome: 'success', value: { title: 'OK Computer' }, now: 100, expiresAt: null });

    const reopened = new SqliteCache(db);
    expect(reopened.get<{ title: string }>(d.key, 9999)?.value).toEqual({ title: 'OK Computer' });
  });

  it('round-trips the descriptor, not just the value', () => {
    const d = describeKey({
      provider: 'coverartarchive',
      capability: 'music-artwork',
      origin: { kind: 'release', id: 'mbid-7' },
    });
    cache.set({ descriptor: d, outcome: 'success', value: 1, now: 0, expiresAt: null });

    expect(cache.get(d.key, 0)?.descriptor).toEqual(d);
  });

  it('removes an expired row on read rather than leaving it to grow', () => {
    const d = descriptor('mbid-8');
    cache.set({ descriptor: d, outcome: 'negative', value: null, now: 0, expiresAt: 100 });

    expect(cache.get(d.key, 200)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM provider_cache').get()).toEqual({ n: 0 });
  });

  it('rejects an outcome the policy does not define', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO provider_cache (key, provider, capability, origin, outcome, body, fetched_at)
           VALUES ('k','p','c','o','transient','null',0)`
        )
        .run()
    ).toThrow();
  });

  it('replaced http_cache, which was keyed by URL and could not express this', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('provider_cache');
    expect(names).not.toContain('http_cache');
  });
});

describe('LayeredCache', () => {
  let db: Db;
  let fast: MemoryCache;
  let slow: SqliteCache;
  let cache: LayeredCache;

  beforeEach(() => {
    db = freshDb();
    fast = new MemoryCache();
    slow = new SqliteCache(db);
    cache = new LayeredCache(fast, slow);
  });
  afterEach(() => db.close());

  it('writes through to both layers', () => {
    const d = descriptor('mbid-9');
    cache.set({ descriptor: d, outcome: 'success', value: 1, now: 0, expiresAt: null });

    expect(fast.get(d.key, 0)).not.toBeNull();
    expect(slow.get(d.key, 0)).not.toBeNull();
  });

  it('promotes a slow hit into the fast layer, so the next read costs no I/O', () => {
    const d = descriptor('mbid-10');
    slow.set({ descriptor: d, outcome: 'success', value: 'x', now: 50, expiresAt: null });

    expect(fast.get(d.key, 0)).toBeNull();
    expect(cache.get<string>(d.key, 100)?.value).toBe('x');
    expect(fast.get<string>(d.key, 100)?.value).toBe('x');
  });

  it('promotes with the expiry intact, not as an immortal entry', () => {
    const d = descriptor('mbid-11');
    slow.set({ descriptor: d, outcome: 'negative', value: null, now: 0, expiresAt: 1000 });

    expect(cache.get(d.key, 500)).not.toBeNull();
    expect(fast.get(d.key, 1000)).toBeNull();
  });

  /**
   * The bug this guards: if a promotion lost its origin, invalidateOrigin would
   * clear SQLite and leave the stale answer sitting in memory, so "re-match"
   * would appear to do nothing until a restart.
   */
  it('invalidating a resource also clears its promoted copies', () => {
    const d = descriptor('mbid-12');
    slow.set({ descriptor: d, outcome: 'success', value: 'stale', now: 0, expiresAt: null });
    cache.get(d.key, 0); // promote

    cache.invalidateOrigin(d.origin);

    expect(fast.get(d.key, 0)).toBeNull();
    expect(cache.get(d.key, 0)).toBeNull();
  });
});

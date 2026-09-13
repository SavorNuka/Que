import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/main/db/connection';
import { LayeredCache, MemoryCache, SqliteCache } from '../../src/main/idempotency/cache';
import { describeKey } from '../../src/main/idempotency/key';
import * as mediaRepo from '../../src/main/db/repos/media';
import { reindexMedia } from '../../src/main/db/search';
import * as restrictions from '../../src/main/restrictions';
import { MediaServer } from '../../src/main/server/server';
import { freshDb } from '../helpers/db';

/**
 * PRA-M1b R5 — the invariant this phase must not break.
 *
 * Provider responses supply the ratings that §23 restrictions act on, and this
 * phase adds a cache in front of those responses. The danger is not that a
 * cached answer is stale; it is that a cache becomes a second source of truth
 * and something starts reading it instead of the database. Restrictions are
 * enforced in the query layer against the row, and a warm cache is not a path
 * around them.
 *
 * Stated as a property: **nothing in the cache can change what a query
 * returns.** These tests warm the cache with metadata that says the item is
 * harmless, and assert the query layer, the FTS search and the streaming
 * server all still refuse it.
 */

const UNRESTRICTED = {
  enabled: false,
  maxAge: 18,
  allowUnrated: true,
  blockExplicit: false,
  pinSet: false,
  unlockMinutes: 30,
};

const CHILD_SAFE = { ...UNRESTRICTED, enabled: true, maxAge: 13, allowUnrated: true };

describe('restrictions are not affected by a warm provider cache', () => {
  let db: Db;
  let cache: LayeredCache;

  const addMedia = (opts: { title: string; hidden?: boolean; ageMin?: number }): number => {
    const info = db
      .prepare(
        `INSERT INTO media (kind, path, file_name, ext, added_at, title, sort_title, hidden, age_min)
         VALUES ('video', ?, 'x.mp4', '.mp4', ?, ?, ?, ?, ?)`
      )
      .run(
        `/m/${opts.title}.mp4`,
        Date.now(),
        opts.title,
        opts.title.toLowerCase(),
        opts.hidden ? 1 : 0,
        opts.ageMin ?? null
      );
    const id = Number(info.lastInsertRowid);
    return id;
  };

  /** Cache a cheerful provider answer for the item — the tempting shortcut. */
  const warmCache = (id: number, payload: Record<string, unknown>): void => {
    const descriptor = describeKey({
      provider: 'tmdb',
      capability: 'movie-metadata',
      origin: { kind: 'movie', id: `local-${String(id)}` },
    });
    cache.set({ descriptor, outcome: 'success', value: payload, now: Date.now(), expiresAt: null });
  };

  beforeEach(() => {
    db = freshDb();
    cache = new LayeredCache(new MemoryCache(), new SqliteCache(db));
    restrictions.configure(UNRESTRICTED, null);
  });

  afterEach(() => {
    restrictions.configure(UNRESTRICTED, null);
    db.close();
  });

  it('keeps a hidden item out of the list even with a cached "certificate: G"', () => {
    const id = addMedia({ title: 'hidden film', hidden: true });
    warmCache(id, { certificate: 'G', ageMin: 0, adult: false });

    restrictions.configure(CHILD_SAFE, null);
    const page = mediaRepo.list(db, { match: 'all' }, { key: 'title', dir: 'asc' }, null);

    expect(page.items.map((m) => m.id)).not.toContain(id);
  });

  it('keeps an over-age item out of the list even with a cached low rating', () => {
    const id = addMedia({ title: 'over age film', ageMin: 18 });
    warmCache(id, { certificate: 'PG', ageMin: 8 });

    restrictions.configure(CHILD_SAFE, null);
    const page = mediaRepo.list(db, { match: 'all' }, { key: 'title', dir: 'asc' }, null);

    expect(page.items.map((m) => m.id)).not.toContain(id);
  });

  it('keeps a restricted item out of search results too', () => {
    const id = addMedia({ title: 'restricted', ageMin: 18 });
    reindexMedia(db, id);
    warmCache(id, { certificate: 'U' });

    restrictions.configure(CHILD_SAFE, null);
    expect(mediaRepo.searchRanked(db, 'restricted', 50).map((m) => m.id)).not.toContain(id);
  });

  it('refuses to stream a restricted item even with a warm cache', async () => {
    const id = addMedia({ title: 'streamable', ageMin: 18 });
    warmCache(id, { certificate: 'U' });

    const server = new MediaServer(() => db);
    const status = await server.start(0);

    try {
      restrictions.configure(CHILD_SAFE, null);
      const res = await fetch(`http://127.0.0.1:${String(status.port)}/stream/${String(id)}?t=${status.token ?? ''}`);
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  /**
   * The positive control. Without it, every assertion above would also pass if
   * `list` simply returned nothing, or if the cache write silently failed and
   * there was no warm cache to be a path around in the first place.
   */
  it('POSITIVE CONTROL: the same item IS returned when restrictions are off, and the cache really is warm', () => {
    const id = addMedia({ title: 'ordinary film', ageMin: 18 });
    warmCache(id, { certificate: 'U' });

    const descriptor = describeKey({
      provider: 'tmdb',
      capability: 'movie-metadata',
      origin: { kind: 'movie', id: `local-${String(id)}` },
    });
    expect(cache.get(descriptor.key, Date.now())).not.toBeNull();

    const page = mediaRepo.list(db, { match: 'all' }, { key: 'title', dir: 'asc' }, null);
    expect(page.items.map((m) => m.id)).toContain(id);
  });
});

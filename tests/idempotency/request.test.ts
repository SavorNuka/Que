import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manualClock } from '../../src/main/concurrency/clock';
import { RateGateRegistry } from '../../src/main/concurrency/rate-gate';
import { HttpError, MalformedResponseError } from '../../src/main/concurrency/retry';
import type { Db } from '../../src/main/db/connection';
import { LayeredCache, MemoryCache, SqliteCache } from '../../src/main/idempotency/cache';
import { ProviderClient } from '../../src/main/idempotency/request';
import { freshDb } from '../helpers/db';

/**
 * The whole path, end to end: key → cache → single-flight → gate → retry →
 * cache write. These are the harness scenarios (docs/sanity-tests/idempotency.mjs)
 * run against the real implementation rather than a model of it.
 *
 * PRA-M1b §4 C1: no provider we use offers an idempotency contract, so for
 * this purpose Que IS the server. Everything asserted here is a guarantee we
 * make ourselves and must therefore test ourselves.
 */

interface Fixture {
  client: ProviderClient;
  db: Db;
  clock: ReturnType<typeof manualClock>;
  close: () => void;
}

/**
 * `test.host` is ungated. Spacing is proven in rate-gate.test.ts against the
 * published limits; mixing it in here would only make these assertions about
 * deduplication harder to read.
 */
function fixture(): Fixture {
  const clock = manualClock(1_000_000);
  const db = freshDb();
  const cache = new LayeredCache(new MemoryCache(), new SqliteCache(db));
  const gates = new RateGateRegistry({
    clock,
    limits: { 'test.host': { minIntervalMs: 0 } },
  });

  const client = new ProviderClient({
    cache,
    gates,
    clock,
    retry: { attempts: 3, baseMs: 1000, jitter: 0 },
  });

  return { client, db, clock, close: () => db.close() };
}

describe('ProviderClient — concurrent duplicates (harness M-1)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => f.close());

  it('makes ONE call for twelve tracks asking about one album', async () => {
    let calls = 0;

    const ask = (): Promise<{ value: { title: string } | null; source: string }> =>
      f.client
        .request({
          provider: 'musicbrainz',
          capability: 'music-metadata',
          host: 'test.host',
          origin: { kind: 'release', id: 'mbid-kid-a' },
          execute: async () => {
            calls++;
            await f.clock.sleep(50);
            return { title: 'Kid A' };
          },
        })
        .then((r) => ({ value: r.value, source: r.source }));

    const all = Promise.all(Array.from({ length: 12 }, ask));
    await f.clock.advance(1000);
    const results = await all;

    expect(calls).toBe(1);
    expect(results.every((r) => r.value?.title === 'Kid A')).toBe(true);
    expect(results.filter((r) => r.source === 'network')).toHaveLength(1);
    expect(results.filter((r) => r.source === 'coalesced')).toHaveLength(11);
  });

  it('serves the thirteenth from cache without executing anything', async () => {
    let calls = 0;
    const ask = (): Promise<{ source: string }> =>
      f.client.request({
        provider: 'musicbrainz',
        capability: 'music-metadata',
        host: 'test.host',
        origin: { kind: 'release', id: 'mbid-kid-a' },
        execute: () => {
          calls++;
          return Promise.resolve({ title: 'Kid A' });
        },
      });

    await ask();
    const second = await ask();

    expect(calls).toBe(1);
    expect(second.source).toBe('cache');
  });
});

describe('ProviderClient — distinct resources (harness M-2)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => f.close());

  /**
   * The failure this prevents, measured: one key for twelve rows gave 1 call,
   * 1 distinct result, and 1 of 12 rows correct. Eleven rows silently received
   * another row's data.
   */
  it('gives twelve different recordings twelve different answers', async () => {
    let calls = 0;

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        f.client.request<{ id: number }>({
          provider: 'musicbrainz',
          capability: 'music-metadata',
          host: 'test.host',
          origin: { kind: 'recording', id: `mbid-track-${String(i)}` },
          execute: () => {
            calls++;
            return Promise.resolve({ id: i });
          },
        })
      )
    );

    expect(calls).toBe(12);
    expect(results.map((r) => r.value?.id)).toEqual([...Array(12).keys()]);
  });
});

describe('ProviderClient — parameters that vary the response (harness M-3)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => f.close());

  it('does not serve the English subtitles for a Spanish request', async () => {
    const ask = (language: string): Promise<{ value: { language: string } | null }> =>
      f.client.request<{ language: string }>({
        provider: 'opensubtitles-v3',
        capability: 'subtitles',
        host: 'test.host',
        origin: { kind: 'movie', id: 'tt0111161' },
        params: { language },
        execute: () => Promise.resolve({ language }),
      });

    expect((await ask('en')).value?.language).toBe('en');
    expect((await ask('es')).value?.language).toBe('es');
  });
});

describe('ProviderClient — failure handling (harness M-4, §5.5)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => f.close());

  it('retries a transient failure and does not cache the failure', async () => {
    let calls = 0;

    const promise = f.client.request({
      provider: 'cinemeta',
      capability: 'movie-metadata',
      host: 'test.host',
      origin: { kind: 'movie', id: 'tt0111161' },
      execute: () => {
        calls++;
        return calls === 1 ? Promise.reject(new HttpError(503)) : Promise.resolve({ title: 'The Shawshank Redemption' });
      },
    });

    await f.clock.advance(5000);
    const result = await promise;

    expect(calls).toBe(2);
    expect(result.outcome).toBe('success');
  });

  it('leaves the key usable after giving up, rather than poisoning it', async () => {
    let calls = 0;
    const ask = (): Promise<unknown> =>
      f.client.request({
        provider: 'cinemeta',
        capability: 'movie-metadata',
        host: 'test.host',
        origin: { kind: 'movie', id: 'tt0111161' },
        execute: () => {
          calls++;
          return calls <= 3 ? Promise.reject(new HttpError(503)) : Promise.resolve({ ok: true });
        },
      });

    const first = ask().catch(() => 'failed');
    await f.clock.advance(20_000);
    expect(await first).toBe('failed');
    expect(calls).toBe(3);

    const second = ask();
    await f.clock.advance(20_000);
    await expect(second).resolves.toMatchObject({ outcome: 'success' });
  });

  it('caches a definitive negative so we stop asking every scan', async () => {
    let calls = 0;
    const ask = (): Promise<{ outcome: string; source: string }> =>
      f.client.request({
        provider: 'musicbrainz',
        capability: 'music-metadata',
        host: 'test.host',
        origin: { kind: 'recording', natural: { title: 'an obscure b-side' } },
        execute: () => {
          calls++;
          return Promise.reject(new HttpError(404));
        },
      });

    const first = await ask();
    const second = await ask();

    expect(calls).toBe(1);
    expect(first.outcome).toBe('negative');
    expect(second.source).toBe('cache');
    expect(second.outcome).toBe('negative');
  });

  it('treats a null result as a definitive negative too', async () => {
    const result = await f.client.request({
      provider: 'musicbrainz',
      capability: 'music-metadata',
      host: 'test.host',
      origin: { kind: 'recording', id: 'nothing-here' },
      execute: () => Promise.resolve(null),
    });

    expect(result.outcome).toBe('negative');
    expect(result.value).toBeNull();
  });

  it('lets a negative expire so a later-added release is eventually found', async () => {
    let calls = 0;
    const ask = (): Promise<{ outcome: string }> =>
      f.client.request({
        provider: 'musicbrainz',
        capability: 'music-metadata',
        host: 'test.host',
        origin: { kind: 'recording', id: 'added-later' },
        execute: () => {
          calls++;
          return calls === 1 ? Promise.resolve(null) : Promise.resolve({ found: true });
        },
      });

    await ask();
    await f.clock.advance(31 * 24 * 60 * 60 * 1000);
    const later = await ask();

    expect(calls).toBe(2);
    expect(later.outcome).toBe('success');
  });

  it('does not retry or cache a malformed response', async () => {
    let calls = 0;
    const ask = (): Promise<unknown> =>
      f.client.request({
        provider: 'musicbrainz',
        capability: 'music-metadata',
        host: 'test.host',
        origin: { kind: 'release', id: 'mbid-bad' },
        execute: () => {
          calls++;
          return Promise.reject(new MalformedResponseError('not JSON'));
        },
      });

    await expect(ask()).rejects.toThrow('not JSON');
    await expect(ask()).rejects.toThrow('not JSON');
    expect(calls).toBe(2); // asked again — never cached, never retried within a call
  });
});

describe('ProviderClient — persistence and invalidation', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => f.close());

  /**
   * Harness M-5: this is what turns 250 minutes of MusicBrainz calls into 92,
   * and then into nothing at all on the next scan.
   */
  it('survives a restart — a second scan does not re-spend the rate budget', async () => {
    let calls = 0;
    const req = {
      provider: 'musicbrainz',
      capability: 'music-metadata',
      host: 'test.host',
      origin: { kind: 'release' as const, id: 'mbid-persist' },
      execute: () => {
        calls++;
        return Promise.resolve({ title: 'OK Computer' });
      },
    };

    await f.client.request(req);

    // A new process: new memory cache, new in-flight map, same database.
    const restarted = new ProviderClient({
      cache: new LayeredCache(new MemoryCache(), new SqliteCache(f.db)),
      gates: new RateGateRegistry({ clock: f.clock }),
      clock: f.clock,
    });

    const result = await restarted.request(req);
    expect(calls).toBe(1);
    expect(result.source).toBe('cache');
    expect(result.value).toEqual({ title: 'OK Computer' });
  });

  it('re-matching an item clears every variant, then asks again', async () => {
    let calls = 0;
    const origin = { kind: 'movie' as const, id: 'tt0111161' };

    const ask = (capability: string, params?: Record<string, unknown>): Promise<unknown> =>
      f.client.request({
        provider: 'tmdb',
        capability,
        host: 'test.host',
        origin,
        params,
        execute: () => {
          calls++;
          return Promise.resolve({ n: calls });
        },
      });

    await ask('movie-metadata');
    await ask('movie-artwork');
    await ask('subtitles', { language: 'es' });
    expect(calls).toBe(3);

    expect(f.client.invalidate(origin)).toBe(3);

    await ask('movie-metadata');
    await ask('movie-artwork');
    await ask('subtitles', { language: 'es' });
    expect(calls).toBe(6);
  });

  it('reports what it did, so a scan can explain where the time went', async () => {
    await f.client.request({
      provider: 'musicbrainz',
      capability: 'music-metadata',
      host: 'test.host',
      origin: { kind: 'release', id: 'a' },
      execute: () => Promise.resolve({}),
    });
    await f.client.request({
      provider: 'musicbrainz',
      capability: 'music-metadata',
      host: 'test.host',
      origin: { kind: 'release', id: 'a' },
      execute: () => Promise.resolve({}),
    });

    const stats = f.client.stats();
    expect(stats.requests).toBe(2);
    expect(stats.networkCalls).toBe(1);
    expect(stats.cacheHits).toBe(1);
  });
});

describe('ProviderClient — cancellation', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => f.close());

  it('one caller abandoning does not cancel the others (R7)', async () => {
    let calls = 0;
    const controller = new AbortController();

    const ask = (signal?: AbortSignal): Promise<unknown> =>
      f.client.request(
        {
          provider: 'musicbrainz',
          capability: 'music-metadata',
          host: 'test.host',
          origin: { kind: 'release', id: 'shared' },
          execute: async () => {
            calls++;
            await f.clock.sleep(5000);
            return { title: 'Kid A' };
          },
        },
        { signal }
      );

    const leaving = ask(controller.signal).catch(() => 'gone');
    const staying = ask();

    await f.clock.tick();
    controller.abort();
    expect(await leaving).toBe('gone');

    await f.clock.advance(6000);
    await expect(staying).resolves.toMatchObject({ value: { title: 'Kid A' } });
    expect(calls).toBe(1);
  });
});

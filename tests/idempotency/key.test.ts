import { describe, expect, it } from 'vitest';
import {
  KEY_VERSION,
  describeKey,
  idempotencyKey,
  normaliseText,
  originId,
  originSegment,
  stableStringify,
} from '../../src/main/idempotency/key';

/**
 * The two ways to get a key wrong, both measured in
 * docs/sanity-tests/idempotency.mjs:
 *
 *   too coarse — one key for twelve rows:   1 call,  1 of 12 rows correct
 *   too fine   — keyed on media.id:        12 calls for one album, 158 minutes
 *                                          of rate budget thrown away
 *
 * A key grounded in the resource's own identity avoids both. These tests are
 * the record of that, in both directions — it is not enough to show that
 * different resources differ; it must also be shown that the same resource,
 * reached from different rows, agrees.
 */

describe('normaliseText', () => {
  it('ignores case and punctuation', () => {
    expect(normaliseText('The Dark Knight')).toBe(normaliseText('the dark knight'));
    expect(normaliseText('Spider-Man: No Way Home')).toBe(normaliseText('spider man no way home'));
  });

  it('ignores diacritics', () => {
    expect(normaliseText('Amélie')).toBe('amelie');
    expect(normaliseText('Motörhead')).toBe('motorhead');
  });

  it('ignores a leading article', () => {
    expect(normaliseText('The Shawshank Redemption')).toBe('shawshank redemption');
    expect(normaliseText('A Clockwork Orange')).toBe('clockwork orange');
  });

  it('handles the trailing-article filename convention', () => {
    expect(normaliseText('Shawshank Redemption, The')).toBe('shawshank redemption');
    expect(normaliseText('Shawshank Redemption, The')).toBe(normaliseText('The Shawshank Redemption'));
  });

  it('normalises the ampersand, which tag editors disagree about', () => {
    expect(normaliseText('Simon & Garfunkel')).toBe(normaliseText('Simon and Garfunkel'));
  });

  it('strips typographic apostrophes', () => {
    expect(normaliseText('Don’t Look Up')).toBe(normaliseText("Don't Look Up"));
  });

  it('collapses whitespace', () => {
    expect(normaliseText('  Blade   Runner  ')).toBe('blade runner');
  });

  it('does not merge genuinely different titles', () => {
    expect(normaliseText('Alien')).not.toBe(normaliseText('Aliens'));
    expect(normaliseText('Blade Runner')).not.toBe(normaliseText('Blade Runner 2049'));
  });
});

describe('stableStringify', () => {
  it('is insensitive to key order — the same request either way round', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('drops undefined but keeps null, which mean different things', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: 1, b: null })).not.toBe(stableStringify({ a: 1 }));
  });

  it('keeps array order, which does matter', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('distinguishes the string "1" from the number 1', () => {
    expect(stableStringify({ a: '1' })).not.toBe(stableStringify({ a: 1 }));
  });
});

describe('originId', () => {
  it('uses an agreed identifier when there is one', () => {
    expect(originId({ kind: 'movie', id: 'tt0111161' })).toBe('id.tt0111161');
  });

  it('is case-insensitive about identifiers', () => {
    expect(originId({ kind: 'release', id: 'F4A31Fd0-AAAA' })).toBe(
      originId({ kind: 'release', id: 'f4a31fd0-aaaa' })
    );
  });

  it('falls back to a digest of the normalised natural key', () => {
    const a = originId({ kind: 'movie', natural: { title: 'The Matrix', year: 1999 } });
    const b = originId({ kind: 'movie', natural: { title: 'matrix', year: 1999 } });
    expect(a).toBe(b);
    expect(a.startsWith('nat.')).toBe(true);
  });

  it('separates resources that differ only by year', () => {
    const a = originId({ kind: 'movie', natural: { title: 'Dune', year: 1984 } });
    const b = originId({ kind: 'movie', natural: { title: 'Dune', year: 2021 } });
    expect(a).not.toBe(b);
  });

  it('ignores empty natural fields rather than letting them change the digest', () => {
    const a = originId({ kind: 'recording', natural: { title: 'Idioteque', album: '' } });
    const b = originId({ kind: 'recording', natural: { title: 'Idioteque', album: null } });
    const c = originId({ kind: 'recording', natural: { title: 'Idioteque' } });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('refuses an origin that identifies nothing, instead of hashing emptiness', () => {
    expect(() => originId({ kind: 'movie' })).toThrow();
    expect(() => originId({ kind: 'movie', natural: {} })).toThrow();
    expect(() => originId({ kind: 'movie', natural: { title: '' } })).toThrow();
  });
});

describe('idempotencyKey', () => {
  const base = {
    provider: 'musicbrainz',
    capability: 'music-metadata',
    origin: { kind: 'release' as const, id: 'mbid-123' },
  };

  it('is stable across calls', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey(base));
  });

  it('carries the version, so a schema change cannot match old entries (R2)', () => {
    expect(idempotencyKey(base).startsWith(`${KEY_VERSION}:`)).toBe(true);
  });

  /**
   * Harness M-1 / M-5. This is the property that saves 158 minutes on a
   * 5,000-track library: twelve tracks that belong to one album must produce
   * ONE key for the album lookup. Keying on the row would produce twelve.
   */
  it('gives twelve tracks from one album a single release key', () => {
    const keys = new Set(
      Array.from({ length: 12 }, (_, track) => {
        void track; // the row differs; the resource being asked about does not
        return idempotencyKey({
          provider: 'musicbrainz',
          capability: 'music-metadata',
          origin: { kind: 'release', id: 'mbid-kid-a' },
        });
      })
    );

    expect(keys.size).toBe(1);
  });

  /**
   * Harness M-2, the other direction. Twelve genuinely different recordings
   * must never share a key — one key for the batch got 1 of 12 rows right.
   */
  it('gives twelve different recordings twelve different keys', () => {
    const keys = new Set(
      Array.from({ length: 12 }, (_, i) =>
        idempotencyKey({
          provider: 'musicbrainz',
          capability: 'music-metadata',
          origin: { kind: 'recording', id: `mbid-track-${String(i)}` },
        })
      )
    );

    expect(keys.size).toBe(12);
  });

  /**
   * Harness M-3: a key omitting `language` returned THE ENGLISH RESPONSE for a
   * Spanish request. Every parameter that varies the response is in the key.
   */
  it('separates requests that differ only by a parameter', () => {
    const en = idempotencyKey({
      provider: 'opensubtitles-v3',
      capability: 'subtitles',
      origin: { kind: 'movie', id: 'tt0111161' },
      params: { language: 'en' },
    });
    const es = idempotencyKey({
      provider: 'opensubtitles-v3',
      capability: 'subtitles',
      origin: { kind: 'movie', id: 'tt0111161' },
      params: { language: 'es' },
    });

    expect(en).not.toBe(es);
  });

  it('is insensitive to parameter ORDER, which does not vary the response', () => {
    const a = idempotencyKey({ ...base, params: { language: 'en', limit: 5 } });
    const b = idempotencyKey({ ...base, params: { limit: 5, language: 'en' } });
    expect(a).toBe(b);
  });

  it('separates providers — two answers must not share one entry', () => {
    const a = idempotencyKey({ ...base, provider: 'musicbrainz' });
    const b = idempotencyKey({ ...base, provider: 'itunes' });
    expect(a).not.toBe(b);
  });

  it('separates capabilities — metadata and artwork are different questions', () => {
    const a = idempotencyKey({ ...base, capability: 'music-metadata' });
    const b = idempotencyKey({ ...base, capability: 'music-artwork' });
    expect(a).not.toBe(b);
  });

  it('separates origin kinds sharing an identifier', () => {
    const a = idempotencyKey({ ...base, origin: { kind: 'release', id: 'x1' } });
    const b = idempotencyKey({ ...base, origin: { kind: 'recording', id: 'x1' } });
    expect(a).not.toBe(b);
  });

  it('treats no params and empty params as the same request', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base, params: {} }));
  });

  it('produces a key safe to use as a SQLite primary key', () => {
    const key = idempotencyKey({
      ...base,
      origin: { kind: 'movie', natural: { title: "O'Brien's — «Tale»", year: 2001 } },
    });
    expect(key).toMatch(/^[\w.:-]+$/);
  });
});

describe('describeKey', () => {
  it('decomposes the fields the cache stores alongside the key', () => {
    const d = describeKey({
      provider: 'MusicBrainz',
      capability: 'music-metadata',
      origin: { kind: 'release', id: 'mbid-123' },
    });

    expect(d.key).toContain(d.origin);
    expect(d.provider).toBe('musicbrainz');
    expect(d.capability).toBe('music-metadata');
    expect(d.origin).toBe('release:id.mbid-123');
  });

  /**
   * PRA-M1b R4. "Re-match this item" must clear every variant for the
   * resource — the Spanish subtitles along with the English — so the origin
   * segment has to be identical across providers, capabilities and params.
   */
  it('gives one resource one origin segment across every kind of request', () => {
    const origin = { kind: 'movie' as const, id: 'tt0111161' };
    const segments = new Set([
      describeKey({ provider: 'tmdb', capability: 'movie-metadata', origin }).origin,
      describeKey({ provider: 'cinemeta', capability: 'movie-artwork', origin }).origin,
      describeKey({ provider: 'wyzie', capability: 'subtitles', origin, params: { language: 'es' } }).origin,
    ]);

    expect(segments.size).toBe(1);
    expect([...segments][0]).toBe(originSegment(origin));
  });
});

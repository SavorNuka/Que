import { beforeEach, describe, expect, it } from 'vitest';
import type { RestrictionSettings } from '@shared/types';

/**
 * §23. The property under test is not "the UI hides things" — it is that the
 * query layer cannot be asked to return them. Every read path gets the same
 * clauses, including the ones a careless caller would reach for first:
 * a direct id lookup, and the search box.
 */

const BASE: RestrictionSettings = {
  enabled: false,
  maxAge: 18,
  allowUnrated: true,
  blockExplicit: false,
  pinSet: false,
  unlockMinutes: 30,
};

import { freshDb } from './helpers/db';
import * as media from '../src/main/db/repos/media';
import * as restrictions from '../src/main/restrictions';

type Db = ReturnType<typeof freshDb>;

/** Restriction state is injected, so tests configure it directly — no mocks. */
function apply(patch: Partial<RestrictionSettings> = {}): void {
  restrictions.configure({ ...BASE, ...patch }, null);
}

function seed(db: Db): { g: number; pg13: number; r: number; unrated: number; hidden: number } {
  const mk = (title: string, ageMin: number | null, hidden = false): number => {
    const id = media.insert(db, {
      kind: 'video',
      path: `/m/${title}.mp4`,
      fileName: `${title}.mp4`,
      ext: '.mp4',
      title,
    });
    db.prepare('UPDATE media SET age_min = ?, hidden = ? WHERE id = ?').run(
      ageMin,
      hidden ? 1 : 0,
      id
    );
    return id;
  };
  return {
    g: mk('Paddington', 0),
    pg13: mk('Jurassic Park', 13),
    r: mk('Alien', 17),
    unrated: mk('Home Video', null),
    hidden: mk('Hidden Thing', 0, true),
  };
}

function ids(db: Db): number[] {
  return media
    .list(db, { match: 'all' }, { key: 'title', dir: 'asc' }, null)
    .items.map((i) => i.id);
}

beforeEach(() => {
  apply();
  restrictions.lock();
});

describe('restrictions off', () => {
  it('returns everything, including hidden items', () => {
    const db = freshDb();
    const s = seed(db);
    expect(ids(db)).toHaveLength(5);
    expect(ids(db)).toContain(s.hidden);
    db.close();
  });
});

describe('restrictions on', () => {
  it('hides hidden items from listings', () => {
    const db = freshDb();
    const s = seed(db);
    apply({ enabled: true });
    expect(ids(db)).not.toContain(s.hidden);
    db.close();
  });

  it('applies the age limit', () => {
    const db = freshDb();
    const s = seed(db);
    apply({ enabled: true, maxAge: 13 });

    const visible = ids(db);
    expect(visible).toContain(s.g);
    expect(visible).toContain(s.pg13);
    expect(visible).not.toContain(s.r);
    db.close();
  });

  it('can exclude unrated items', () => {
    const db = freshDb();
    const s = seed(db);
    apply({ enabled: true, maxAge: 13 });

    expect(ids(db)).toContain(s.unrated);
    apply({ enabled: true, maxAge: 13, allowUnrated: false });
    expect(ids(db)).not.toContain(s.unrated);
    db.close();
  });

  /** The obvious bypass: ask for the row by id instead of listing. */
  it('blocks direct id lookup of a restricted item', () => {
    const db = freshDb();
    const s = seed(db);
    apply({ enabled: true, maxAge: 13 });

    expect(() => media.get(db, s.r)).toThrow();
    expect(() => media.get(db, s.hidden)).toThrow();
    expect(media.get(db, s.g).title).toBe('Paddington');
    db.close();
  });

  /** The second obvious bypass: search for it by name. */
  it('blocks restricted items from search results', () => {
    const db = freshDb();
    const s = seed(db);
    apply({ enabled: true, maxAge: 13 });

    expect(media.searchRanked(db, 'alien', 50).map((m) => m.id)).not.toContain(s.r);
    expect(media.searchRanked(db, 'hidden', 50).map((m) => m.id)).not.toContain(s.hidden);
    expect(media.searchRanked(db, 'paddington', 50).map((m) => m.id)).toContain(s.g);
    db.close();
  });

  /**
   * A match:'any' filter ORs the user's clauses together. The restriction
   * clauses must stay ANDed on the outside, or an OR filter would widen
   * straight past the limit.
   */
  it('is not widened by a match:any filter', () => {
    const db = freshDb();
    const s = seed(db);
    apply({ enabled: true, maxAge: 13 });

    const page = media.list(
      db,
      { match: 'any', kind: 'video', years: [1900, 2100], rating: { unrated: true } },
      { key: 'title', dir: 'asc' },
      null
    );
    expect(page.items.map((i) => i.id)).not.toContain(s.r);
    expect(page.items.map((i) => i.id)).not.toContain(s.hidden);
    db.close();
  });

  it('blocks explicit audio when asked to', () => {
    const db = freshDb();
    const id = media.insert(db, {
      kind: 'audio',
      path: '/a.mp3',
      fileName: 'a.mp3',
      ext: '.mp3',
      title: 'Loud Song',
    });
    db.prepare('UPDATE media SET explicit = 1 WHERE id = ?').run(id);

    apply({ enabled: true });
    expect(ids(db)).toContain(id);
    apply({ enabled: true, blockExplicit: true });
    expect(ids(db)).not.toContain(id);
    db.close();
  });

  it('restores everything once unlocked, and re-locks on demand', () => {
    const db = freshDb();
    const s = seed(db);
    apply({ enabled: true, maxAge: 13 });
    expect(ids(db)).not.toContain(s.r);

    expect(restrictions.unlock('')).toBe(true); // no PIN set
    expect(ids(db)).toContain(s.r);
    expect(ids(db)).toContain(s.hidden);

    restrictions.lock();
    expect(ids(db)).not.toContain(s.r);
    db.close();
  });
});

describe('PIN', () => {
  it('verifies the right PIN and rejects the wrong one', () => {
    const record = restrictions.createPinRecord('4821');
    expect(restrictions.verifyPin('4821', record)).toBe(true);
    expect(restrictions.verifyPin('4822', record)).toBe(false);
    expect(restrictions.verifyPin('4821', null)).toBe(false);
  });

  it('stores a salted hash, never the PIN itself', () => {
    const record = restrictions.createPinRecord('4821');
    expect(JSON.stringify(record)).not.toContain('4821');
    const second = restrictions.createPinRecord('4821');
    expect(second.hash).not.toBe(record.hash); // distinct salts
  });
});

describe('rating normalisation', () => {
  it.each([
    ['G', 0],
    ['PG', 8],
    ['PG-13', 13],
    ['R', 17],
    ['NC-17', 18],
    ['TV-MA', 17],
    ['TV-Y7', 7],
    ['15', 15],
    ['18', 18],
  ])('maps %s to %i', (label, age) => {
    expect(restrictions.ratingToAge(label)).toBe(age);
  });

  it.each(['NR', 'Unrated', 'Not Rated', '', null, undefined, 'nonsense'])(
    'treats %s as unrated',
    (label) => {
      expect(restrictions.ratingToAge(label)).toBeNull();
    }
  );
});

import { describe, expect, it } from 'vitest';
import { quote, reindexMedia, searchMediaIds, toMatchQuery } from '../src/main/db/search';
import * as media from '../src/main/db/repos/media';
import { freshDb } from './helpers/db';
import type { Db } from '../src/main/db/connection';

function seed(db: Db): Record<string, number> {
  const ids: Record<string, number> = {};
  ids['alien'] = media.insert(db, {
    kind: 'video',
    path: '/m/Alien.mkv',
    fileName: 'Alien.mkv',
    ext: '.mkv',
  });
  ids['prometheus'] = media.insert(db, {
    kind: 'video',
    path: '/m/Prometheus.mp4',
    fileName: 'Prometheus.mp4',
    ext: '.mp4',
  });
  db.prepare('UPDATE media SET overview = ? WHERE id = ?').run(
    'an alien origin story',
    ids['prometheus']
  );
  reindexMedia(db, ids['prometheus']!);
  return ids;
}

describe('FTS input handling', () => {
  it('quotes embedded double quotes', () => {
    expect(quote('say "hi"')).toBe('"say ""hi"""');
  });

  it('builds a prefixed AND query', () => {
    expect(toMatchQuery('blade run')).toBe('"blade" AND "run"*');
  });

  it('returns null for input with nothing searchable', () => {
    expect(toMatchQuery('   ')).toBeNull();
    expect(toMatchQuery('!!!')).toBeNull();
  });

  /**
   * ASSUMPTIONS.md C: unquoted user input is a live crash. Typing this into
   * the search box must return results or nothing — never throw.
   */
  it.each(['alien OR (', 'NEAR("a"', '*', '"unclosed', 'a AND AND b', ')))'])(
    'survives hostile input: %s',
    (input) => {
      const db = freshDb();
      seed(db);
      expect(() => searchMediaIds(db, input)).not.toThrow();
      db.close();
    }
  );
});

describe('search ranking and indexing', () => {
  it('ranks a title match above an overview match', () => {
    const db = freshDb();
    const ids = seed(db);
    const results = searchMediaIds(db, 'alien');
    expect(results[0]).toBe(ids['alien']);
    expect(results).toContain(ids['prometheus']);
    db.close();
  });

  it('folds diacritics and stems', () => {
    const db = freshDb();
    const id = media.insert(db, {
      kind: 'video',
      path: '/m/Amelie.mkv',
      fileName: 'Amelie.mkv',
      ext: '.mkv',
      title: 'Amélie running',
    });
    expect(searchMediaIds(db, 'amelie')).toContain(id);
    expect(searchMediaIds(db, 'run')).toContain(id);
    db.close();
  });

  /**
   * ASSUMPTIONS.md A1: a contentless FTS5 table rejects UPDATE and rejects
   * DELETE without contentless_delete=1. Reindex must therefore work by
   * DELETE + INSERT, and must not accumulate duplicates.
   */
  it('reindexes in place without duplicating rows', () => {
    const db = freshDb();
    const id = media.insert(db, {
      kind: 'video',
      path: '/m/x.mkv',
      fileName: 'x.mkv',
      ext: '.mkv',
      title: 'Original Title',
    });
    expect(searchMediaIds(db, 'original')).toEqual([id]);

    db.prepare('UPDATE media SET title = ? WHERE id = ?').run('Replaced Title', id);
    reindexMedia(db, id);

    expect(searchMediaIds(db, 'original')).toEqual([]);
    expect(searchMediaIds(db, 'replaced')).toEqual([id]);
    expect(
      (db.prepare('SELECT count(*) c FROM media_fts WHERE rowid = ?').get(id) as { c: number }).c
    ).toBe(1);
    db.close();
  });

  it('indexes user-authored custom fields alongside provider metadata', () => {
    const db = freshDb();
    const id = media.insert(db, {
      kind: 'video',
      path: '/m/y.mkv',
      fileName: 'y.mkv',
      ext: '.mkv',
      title: 'Untitled',
    });
    media.setFields(db, id, { note: 'borrowed from Dermot' });
    expect(searchMediaIds(db, 'dermot')).toEqual([id]);
    db.close();
  });
});

describe('library listing', () => {
  it('paginates by keyset without overlap or gaps', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      media.insert(db, {
        kind: 'audio',
        path: `/m/track-${i}.mp3`,
        fileName: `track-${i}.mp3`,
        ext: '.mp3',
        title: `Track ${String(i).padStart(2, '0')}`,
      });
    }
    const seen = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ReturnType<typeof media.list> = media.list(
        db,
        { match: 'all' },
        { key: 'title', dir: 'asc' },
        cursor
      );
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.cursor;
      pages++;
    } while (cursor && pages < 20);

    expect(seen.size).toBe(10);
    db.close();
  });

  it('filters by rating and by group membership', () => {
    const db = freshDb();
    const a = media.insert(db, { kind: 'audio', path: '/a.mp3', fileName: 'a.mp3', ext: '.mp3' });
    const b = media.insert(db, { kind: 'audio', path: '/b.mp3', fileName: 'b.mp3', ext: '.mp3' });
    media.setRating(db, a, 9);
    media.setRating(db, b, 3);

    const now = Date.now();
    db.prepare(
      `INSERT INTO groups (id,type,kind,name,origin,created_at,updated_at)
       VALUES (1,'album','audio','Test','manual',?,?)`
    ).run(now, now);
    db.prepare('INSERT INTO group_items (group_id,media_id,position) VALUES (1,?,1.0)').run(a);

    const highlyRated = media.list(db, { match: 'all', rating: { min: 8 } }, { key: 'title', dir: 'asc' }, null);
    expect(highlyRated.items.map((i) => i.id)).toEqual([a]);

    const inGroup = media.list(db, { match: 'all', groupId: 1 }, { key: 'title', dir: 'asc' }, null);
    expect(inGroup.items.map((i) => i.id)).toEqual([a]);

    const ungrouped = media.list(db, { match: 'all', inAnyGroup: false }, { key: 'title', dir: 'asc' }, null);
    expect(ungrouped.items.map((i) => i.id)).toEqual([b]);
    db.close();
  });
});

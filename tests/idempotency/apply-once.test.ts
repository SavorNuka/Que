import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/main/db/connection';
import {
  applyOnce,
  forgetApplied,
  forgetAppliedForMedia,
  hasApplied,
} from '../../src/main/idempotency/apply-once';
import { freshDb } from '../helpers/db';

/**
 * PRA-M1b §5.6 / R10. "Idempotency per row" does not stop at the fetch.
 *
 * The failure this prevents: a metadata pass over 5,000 rows is cancelled
 * halfway, and what is left is not 2,500 finished rows but 2,500 finished rows
 * plus one with a new title and no artwork. Re-running then either duplicates
 * work or skips it, and nobody can tell which rows are trustworthy.
 */

describe('applyOnce', () => {
  let db: Db;

  const addMedia = (title: string): number => {
    const info = db
      .prepare(
        `INSERT INTO media (kind, path, file_name, ext, added_at, title, sort_title)
         VALUES ('audio', ?, 'x.flac', '.flac', ?, ?, ?)`
      )
      .run(`/m/${title}.flac`, Date.now(), title, title.toLowerCase());
    return Number(info.lastInsertRowid);
  };

  const titleOf = (id: number): string =>
    (db.prepare('SELECT title FROM media WHERE id = ?').get(id) as { title: string }).title;

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('applies the first time', () => {
    const id = addMedia('untitled');
    const result = applyOnce(db, 'v1:mb:meta:release:id.x:none', id, () => {
      db.prepare('UPDATE media SET title = ? WHERE id = ?').run('Kid A', id);
    }, 1000);

    expect(result.applied).toBe(true);
    expect(result.appliedAt).toBe(1000);
    expect(titleOf(id)).toBe('Kid A');
  });

  it('is a no-op on re-run, and reports the ORIGINAL time', () => {
    const id = addMedia('untitled');
    const key = 'v1:mb:meta:release:id.x:none';
    let applications = 0;

    const apply = (): void => {
      applications++;
      db.prepare('UPDATE media SET title = ? WHERE id = ?').run(`pass ${String(applications)}`, id);
    };

    applyOnce(db, key, id, apply, 1000);
    const second = applyOnce(db, key, id, apply, 2000);

    expect(applications).toBe(1);
    expect(second.applied).toBe(false);
    expect(second.appliedAt).toBe(1000);
    expect(titleOf(id)).toBe('pass 1');
  });

  it('treats different keys as different work on the same row', () => {
    const id = addMedia('untitled');
    applyOnce(db, 'key:metadata', id, () => {
      db.prepare('UPDATE media SET title = ? WHERE id = ?').run('Kid A', id);
    });
    applyOnce(db, 'key:artwork', id, () => {
      db.prepare('UPDATE media SET year = ? WHERE id = ?').run(2000, id);
    });

    expect(titleOf(id)).toBe('Kid A');
    expect(db.prepare('SELECT year FROM media WHERE id = ?').get(id)).toEqual({ year: 2000 });
  });

  /**
   * The atomic half. If the write and the ledger entry did not commit together,
   * a crash between them would leave a row that looks applied and is not, or
   * one that is applied and will be applied again.
   */
  it('writes nothing at all when the apply throws', () => {
    const id = addMedia('untitled');
    const key = 'key:boom';

    expect(() =>
      applyOnce(db, key, id, () => {
        db.prepare('UPDATE media SET title = ? WHERE id = ?').run('half-written', id);
        throw new Error('provider data was nonsense');
      })
    ).toThrow('provider data was nonsense');

    expect(titleOf(id)).toBe('untitled');
    expect(hasApplied(db, key)).toBe(false);
  });

  it('leaves a failed row retryable while completed rows stay done', () => {
    const ids = [addMedia('a'), addMedia('b'), addMedia('c')];
    const applied: number[] = [];

    for (const [index, id] of ids.entries()) {
      const key = `batch:row-${String(id)}`;
      try {
        applyOnce(db, key, id, () => {
          if (index === 1) throw new Error('bad row');
          db.prepare('UPDATE media SET title = ? WHERE id = ?').run('done', id);
          applied.push(id);
        });
      } catch {
        // Counted by the caller; the point is that it does not poison the rest.
      }
    }

    expect(applied).toEqual([ids[0], ids[2]]);
    expect(hasApplied(db, `batch:row-${String(ids[0])}`)).toBe(true);
    expect(hasApplied(db, `batch:row-${String(ids[1])}`)).toBe(false);
    expect(hasApplied(db, `batch:row-${String(ids[2])}`)).toBe(true);
  });

  /**
   * A cancelled pass re-run from the start does the remaining work only. This
   * is what makes the metadata phase resumable rather than all-or-nothing.
   */
  it('resumes a cancelled pass without redoing what finished', () => {
    const ids = Array.from({ length: 6 }, (_, i) => addMedia(`t${String(i)}`));
    let cancelAfter = 3;
    let calls = 0;

    const pass = (): void => {
      for (const id of ids) {
        if (cancelAfter-- <= 0) return;
        applyOnce(db, `pass:${String(id)}`, id, () => {
          calls++;
          db.prepare('UPDATE media SET title = ? WHERE id = ?').run('done', id);
        });
      }
    };

    pass();
    expect(calls).toBe(3);

    cancelAfter = 100;
    pass();
    expect(calls).toBe(6); // three more, not nine
  });

  it('accepts a null media id for work that is not row-scoped', () => {
    expect(applyOnce(db, 'global:something', null, () => undefined).applied).toBe(true);
  });
});

describe('forgetting an application', () => {
  let db: Db;

  const addMedia = (): number => {
    const info = db
      .prepare(
        `INSERT INTO media (kind, path, file_name, ext, added_at)
         VALUES ('audio', ?, 'x.flac', '.flac', ?)`
      )
      .run(`/m/${Math.random().toString(36).slice(2)}.flac`, Date.now());
    return Number(info.lastInsertRowid);
  };

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('lets one operation run again', () => {
    applyOnce(db, 'k', null, () => undefined);
    expect(forgetApplied(db, 'k')).toBe(1);
    expect(applyOnce(db, 'k', null, () => undefined).applied).toBe(true);
  });

  /**
   * PRA-M1b R4, the half that is easy to miss. "Re-match this item" has to
   * clear the ledger as well as the cache — otherwise the fetch repeats,
   * costs rate budget, and the apply is still skipped.
   */
  it('clears every operation for one row', () => {
    const id = addMedia();
    const other = addMedia();
    applyOnce(db, 'meta', id, () => undefined);
    applyOnce(db, 'artwork', id, () => undefined);
    applyOnce(db, 'meta-other', other, () => undefined);

    expect(forgetAppliedForMedia(db, id)).toBe(2);
    expect(hasApplied(db, 'meta')).toBe(false);
    expect(hasApplied(db, 'artwork')).toBe(false);
    expect(hasApplied(db, 'meta-other')).toBe(true);
  });

  it('forgets a row automatically when the media row is deleted', () => {
    const id = addMedia();
    applyOnce(db, 'meta', id, () => undefined);

    db.prepare('DELETE FROM media WHERE id = ?').run(id);
    expect(hasApplied(db, 'meta')).toBe(false);
  });
});

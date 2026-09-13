import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers/db';

describe('schema', () => {
  it('applies cleanly and enforces foreign keys', () => {
    const db = freshDb();
    expect(() =>
      db.prepare('INSERT INTO group_items (group_id, media_id, position) VALUES (99, 99, 1.0)').run()
    ).toThrow();
    db.close();
  });

  it('allows exactly one source per media kind', () => {
    const db = freshDb();
    const set = db.prepare(
      `INSERT INTO sources (kind, path) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET path = excluded.path`
    );
    set.run('video', 'D:\\Movies');
    set.run('video', 'D:\\Films');
    set.run('audio', 'D:\\Music');

    const rows = db.prepare('SELECT kind, path FROM sources ORDER BY kind').all() as {
      kind: string;
      path: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'video')?.path).toBe('D:\\Films');
    db.close();
  });

  it('cascades media deletion into memberships and metadata', () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO media (id, kind, path, file_name, ext, added_at) VALUES (1,'audio','/a.flac','a.flac','flac',?)`
    ).run(now);
    db.prepare(`INSERT INTO audio_meta (media_id, album) VALUES (1,'Kid A')`).run();
    db.prepare(
      `INSERT INTO groups (id,type,kind,name,origin,created_at,updated_at) VALUES (1,'album','audio','Kid A','derived',?,?)`
    ).run(now, now);
    db.prepare(`INSERT INTO group_items (group_id,media_id,position) VALUES (1,1,1.0)`).run();

    db.prepare('DELETE FROM media WHERE id = 1').run();

    expect((db.prepare('SELECT count(*) c FROM audio_meta').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM group_items').get() as { c: number }).c).toBe(0);
    // The group itself survives — it is structure, not membership.
    expect((db.prepare('SELECT count(*) c FROM groups').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('lets group dedupe_key be null many times but unique when set', () => {
    const db = freshDb();
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO groups (type,kind,name,dedupe_key,origin,created_at,updated_at)
       VALUES ('album','audio',?,?,'derived',?,?)`
    );
    ins.run('A', null, now, now);
    ins.run('B', null, now, now);
    ins.run('C', 'radiohead|kid a|2000', now, now);
    expect(() => ins.run('D', 'radiohead|kid a|2000', now, now)).toThrow();
    db.close();
  });
});

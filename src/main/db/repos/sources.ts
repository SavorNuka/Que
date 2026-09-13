import type { MediaKind, Source } from '@shared/types';
import type { Db } from '../connection';

interface Row {
  id: number;
  kind: MediaKind;
  path: string;
  enabled: number;
  last_scan_at: number | null;
}

const toSource = (r: Row): Source => ({
  id: r.id,
  kind: r.kind,
  path: r.path,
  enabled: r.enabled === 1,
  lastScanAt: r.last_scan_at,
});

export function getAll(db: Db): Source[] {
  return (db.prepare('SELECT * FROM sources ORDER BY kind').all() as Row[]).map(toSource);
}

/** One path per kind — UNIQUE(kind) in the schema makes this an upsert. */
export function set(db: Db, kind: MediaKind, path: string): Source {
  db.prepare(
    `INSERT INTO sources (kind, path, enabled) VALUES (?, ?, 1)
     ON CONFLICT(kind) DO UPDATE SET path = excluded.path, enabled = 1`
  ).run(kind, path);
  const row = db.prepare('SELECT * FROM sources WHERE kind = ?').get(kind) as Row;
  return toSource(row);
}

export function markScanned(db: Db, kind: MediaKind): void {
  db.prepare('UPDATE sources SET last_scan_at = ? WHERE kind = ?').run(Date.now(), kind);
}

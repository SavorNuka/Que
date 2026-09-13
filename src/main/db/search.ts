import type { Db } from './connection';

/**
 * FTS5 input handling.
 *
 * ASSUMPTIONS.md C: raw user input is NOT a valid FTS5 query. Typing
 * `alien OR (` into the search box throws "fts5: syntax error" and takes the
 * query down with it. Every string that reaches a MATCH clause goes through
 * quote() — no exceptions, no "this one is safe".
 */

/** Wrap a token as an FTS5 string literal, escaping embedded quotes. */
export function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Turn a user's raw search box contents into a safe FTS5 MATCH expression.
 * Every token is quoted; the final token gets a prefix wildcard so results
 * appear while typing. Returns null when there is nothing searchable.
 */
export function toMatchQuery(raw: string, { prefixLast = true } = {}): string | null {
  const tokens = raw
    .normalize('NFKC')
    .split(/[\s]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}'’&._-]/gu, ''))
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  return tokens
    .map((t, i) => (prefixLast && i === tokens.length - 1 ? `${quote(t)}*` : quote(t)))
    .join(' AND ');
}

/** bm25 weights, column order as declared in 001_init.sql. */
export const BM25_WEIGHTS = [10.0, 2.0, 6.0, 4.0, 6.0, 1.0, 1.0] as const;
export const BM25 = `bm25(media_fts, ${BM25_WEIGHTS.join(', ')})`;

interface IndexRow {
  rowid: number;
  title: string;
  overview: string;
  artist: string;
  album: string;
  seriesTitle: string;
  genres: string;
  custom: string;
}

function gather(db: Db, mediaId: number): IndexRow | null {
  const row = db
    .prepare(
      `SELECT m.id            AS rowid,
              COALESCE(m.title, m.file_name) AS title,
              COALESCE(m.overview, '')      AS overview,
              COALESCE(a.artist, '')        AS artist,
              COALESCE(a.album, '')         AS album,
              COALESCE(v.series_title, '')  AS seriesTitle,
              COALESCE(m.genres, '')        AS genres
         FROM media m
         LEFT JOIN audio_meta a ON a.media_id = m.id
         LEFT JOIN video_meta v ON v.media_id = m.id
        WHERE m.id = ?`
    )
    .get(mediaId) as Omit<IndexRow, 'custom'> | undefined;

  if (!row) return null;

  const custom = (
    db.prepare(`SELECT value FROM media_fields WHERE media_id = ?`).all(mediaId) as {
      value: string | null;
    }[]
  )
    .map((r) => r.value ?? '')
    .join(' ');

  return { ...row, custom };
}

/**
 * Re-index one media row.
 *
 * ASSUMPTIONS.md A1: a contentless FTS5 table rejects UPDATE, and rejects
 * DELETE unless contentless_delete=1 is declared alongside content=''.
 * So reindex is always DELETE followed by INSERT.
 */
export function reindexMedia(db: Db, mediaId: number): void {
  const row = gather(db, mediaId);
  db.prepare(`DELETE FROM media_fts WHERE rowid = ?`).run(mediaId);
  if (!row) return;
  db.prepare(
    `INSERT INTO media_fts (rowid, title, overview, artist, album, series_title, genres, custom)
     VALUES (@rowid, @title, @overview, @artist, @album, @seriesTitle, @genres, @custom)`
  ).run(row);
}

export function removeFromIndex(db: Db, mediaId: number): void {
  db.prepare(`DELETE FROM media_fts WHERE rowid = ?`).run(mediaId);
}

export function rebuildIndex(db: Db): number {
  const ids = db.prepare(`SELECT id FROM media`).all() as { id: number }[];
  const run = db.transaction(() => {
    db.exec(`DELETE FROM media_fts`);
    for (const { id } of ids) reindexMedia(db, id);
  });
  run();
  return ids.length;
}

/**
 * Ranked media ids for a query.
 *
 * Contentless FTS columns read back as NULL, so callers must join to `media`
 * for anything displayable — this deliberately returns ids only.
 */
export function searchMediaIds(db: Db, raw: string, limit = 50): number[] {
  const match = toMatchQuery(raw);
  if (!match) return [];
  const rows = db
    .prepare(
      `SELECT rowid AS id FROM media_fts
        WHERE media_fts MATCH ?
        ORDER BY ${BM25}
        LIMIT ?`
    )
    .all(match, limit) as { id: number }[];
  return rows.map((r) => r.id);
}

import type {
  FilterSpec,
  MediaDetail,
  MediaKind,
  MediaSummary,
  Page,
  SortSpec,
} from '@shared/types';
import type { Db } from '../connection';
import { reindexMedia, searchMediaIds } from '../search';
import { mediaClauses } from '../../restrictions';

const PAGE_SIZE = 120;

interface MediaRow {
  id: number;
  kind: MediaKind;
  path: string;
  file_name: string;
  ext: string;
  size_bytes: number | null;
  duration_ms: number | null;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  needs_remux: number;
  remux_reason: MediaDetail['remuxReason'];
  title: string | null;
  sort_title: string | null;
  year: number | null;
  overview: string | null;
  genres: string | null;
  trailer_yt_id: string | null;
  user_rating: number | null;
  thumb_path: string | null;
  thumb_source: MediaDetail['thumbSource'];
  provider: MediaDetail['provider'];
  provider_id: string | null;
  imdb_id: string | null;
  added_at: number;
  last_played_at: number | null;
  play_count: number;
  resume_ms: number | null;
  missing: number;
  hidden: number;
  age_min: number | null;
  explicit: number;
}

function toSummary(r: MediaRow): MediaSummary {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title ?? r.file_name,
    sortTitle: r.sort_title,
    year: r.year,
    durationMs: r.duration_ms,
    userRating: r.user_rating,
    thumbPath: r.thumb_path,
    playCount: r.play_count,
    lastPlayedAt: r.last_played_at,
    resumeMs: r.resume_ms,
    missing: r.missing === 1,
    hidden: r.hidden === 1,
    ageMin: r.age_min,
    explicit: r.explicit === 1,
  };
}

/** Column expression and direction for each sort key, with a stable id tiebreak. */
const SORT_COLUMNS: Record<SortSpec['key'], string> = {
  title: 'COALESCE(m.sort_title, m.title, m.file_name)',
  year: 'm.year',
  rating: 'm.user_rating',
  added: 'm.added_at',
  played: 'm.last_played_at',
  playCount: 'm.play_count',
  duration: 'm.duration_ms',
  artist: 'a.artist',
  album: 'a.album',
};

interface Clause {
  sql: string;
  params: unknown[];
}

/**
 * The only place a library WHERE clause is generated (ARCHITECTURE §18).
 * Everything is parameterised; no value is ever interpolated into SQL.
 */
function buildClauses(db: Db, f: FilterSpec): Clause[] {
  const out: Clause[] = [];

  if (f.kind) out.push({ sql: 'm.kind = ?', params: [f.kind] });

  if (f.q) {
    const ids = searchMediaIds(db, f.q, 5000);
    if (ids.length === 0) out.push({ sql: '1 = 0', params: [] });
    else out.push({ sql: `m.id IN (${ids.map(() => '?').join(',')})`, params: ids });
  }

  if (f.years) out.push({ sql: 'm.year BETWEEN ? AND ?', params: [f.years[0], f.years[1]] });

  if (f.rating) {
    if (f.rating.unrated) out.push({ sql: 'm.user_rating IS NULL', params: [] });
    if (f.rating.min !== undefined)
      out.push({ sql: 'm.user_rating >= ?', params: [f.rating.min] });
    if (f.rating.max !== undefined)
      out.push({ sql: 'm.user_rating <= ?', params: [f.rating.max] });
  }

  if (f.genres?.length) {
    out.push({
      sql: `m.id IN (SELECT media_id FROM media_genres WHERE genre IN (${f.genres
        .map(() => '?')
        .join(',')}))`,
      params: f.genres,
    });
  }

  if (f.groupId !== undefined)
    out.push({
      sql: 'm.id IN (SELECT media_id FROM group_items WHERE group_id = ?)',
      params: [f.groupId],
    });

  if (f.groupType)
    out.push({
      sql: `m.id IN (SELECT gi.media_id FROM group_items gi
                       JOIN groups g ON g.id = gi.group_id
                      WHERE g.type = ? AND g.deleted_at IS NULL)`,
      params: [f.groupType],
    });

  if (f.inAnyGroup !== undefined)
    out.push({
      sql: `${f.inAnyGroup ? '' : 'NOT '}EXISTS (SELECT 1 FROM group_items WHERE media_id = m.id)`,
      params: [],
    });

  if (f.playlistId !== undefined)
    out.push({
      sql: 'm.id IN (SELECT media_id FROM playlist_items WHERE playlist_id = ?)',
      params: [f.playlistId],
    });

  if (f.watched === 'yes') out.push({ sql: 'm.play_count > 0', params: [] });
  if (f.watched === 'no') out.push({ sql: 'm.play_count = 0', params: [] });
  if (f.watched === 'in-progress')
    out.push({ sql: 'm.resume_ms IS NOT NULL AND m.resume_ms > 0', params: [] });

  if (f.hasArtwork !== undefined)
    out.push({ sql: `m.thumb_path IS ${f.hasArtwork ? 'NOT ' : ''}NULL`, params: [] });

  if (f.hasSubs !== undefined)
    out.push({
      sql: `${f.hasSubs ? '' : 'NOT '}EXISTS (SELECT 1 FROM subtitle_cache WHERE media_id = m.id)`,
      params: [],
    });

  if (f.hasLyrics !== undefined)
    out.push({
      sql: `${f.hasLyrics ? '' : 'NOT '}EXISTS (SELECT 1 FROM lyrics_cache WHERE media_id = m.id)`,
      params: [],
    });

  if (f.needsRemux !== undefined)
    out.push({ sql: 'm.needs_remux = ?', params: [f.needsRemux ? 1 : 0] });

  if (f.containers?.length)
    out.push({
      sql: `m.container IN (${f.containers.map(() => '?').join(',')})`,
      params: f.containers,
    });

  if (f.codecs?.length)
    out.push({
      sql: `(m.video_codec IN (${f.codecs.map(() => '?').join(',')})
             OR m.audio_codec IN (${f.codecs.map(() => '?').join(',')}))`,
      params: [...f.codecs, ...f.codecs],
    });

  if (f.duration)
    out.push({
      sql: 'm.duration_ms BETWEEN ? AND ?',
      params: [f.duration[0] * 60_000, f.duration[1] * 60_000],
    });

  if (f.addedWithin) {
    const n = parseInt(f.addedWithin, 10);
    const unit = f.addedWithin.slice(-1);
    const ms = n * (unit === 'd' ? 86_400_000 : unit === 'm' ? 2_592_000_000 : 31_536_000_000);
    out.push({ sql: 'm.added_at >= ?', params: [Date.now() - ms] });
  }

  out.push({ sql: 'm.missing = ?', params: [f.missing ? 1 : 0] });

  return out;
}

export function list(db: Db, filter: FilterSpec, sort: SortSpec, cursor: string | null): Page<MediaSummary> {
  const clauses = buildClauses(db, filter);
  const joiner = filter.match === 'any' && clauses.length > 1 ? ' OR ' : ' AND ';
  const userWhere = clauses.length ? `(${clauses.map((c) => `(${c.sql})`).join(joiner)})` : '';

  /**
   * §23: restriction clauses are ALWAYS ANDed, never folded into the user's
   * match:'any' group — otherwise an OR filter would widen past the limit.
   * They come from main-process state, never from the FilterSpec, so the
   * renderer cannot ask for hidden or over-age rows.
   */
  const restrictions = mediaClauses();
  const allSql = [userWhere, ...restrictions.map((r) => `(${r.sql})`)].filter(Boolean);
  const where = allSql.length ? `WHERE ${allSql.join(' AND ')}` : '';
  const params = [...clauses.flatMap((c) => c.params), ...restrictions.flatMap((r) => r.params)];

  const col = SORT_COLUMNS[sort.key];
  const dir = sort.dir === 'desc' ? 'DESC' : 'ASC';
  const cmp = sort.dir === 'desc' ? '<' : '>';

  // Keyset pagination: (sort_key, id) tuple comparison, never OFFSET.
  let keyset = '';
  const keyParams: unknown[] = [];
  if (cursor) {
    // Cursors are produced by this function, but they arrive back over IPC, so
    // a malformed one must degrade to "first page" rather than throw.
    const sep = cursor.lastIndexOf('|');
    const rawKey = sep === -1 ? '' : cursor.slice(0, sep);
    const parsedId = parseInt(sep === -1 ? '' : cursor.slice(sep + 1), 10);
    if (Number.isInteger(parsedId)) {
      keyset = `${where ? 'AND' : 'WHERE'} (${col}, m.id) ${cmp} (?, ?)`;
      keyParams.push(rawKey === '' ? null : rawKey, parsedId);
    }
  }

  const rows = db
    .prepare(
      `SELECT m.* FROM media m
         LEFT JOIN audio_meta a ON a.media_id = m.id
       ${where} ${keyset}
       ORDER BY ${col} ${dir}, m.id ${dir}
       LIMIT ?`
    )
    .all(...params, ...keyParams, PAGE_SIZE + 1) as MediaRow[];

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page[page.length - 1];

  const total = cursor
    ? null
    : (
        db
          .prepare(
            `SELECT count(*) AS c FROM media m LEFT JOIN audio_meta a ON a.media_id = m.id ${where}`
          )
          .get(...params) as { c: number }
      ).c;

  let nextCursor: string | null = null;
  if (hasMore && last) {
    const keyRow = db.prepare(`SELECT ${col} AS k FROM media m
                                 LEFT JOIN audio_meta a ON a.media_id = m.id
                                WHERE m.id = ?`).get(last.id) as { k: string | number | null };
    nextCursor = `${keyRow.k ?? ''}|${last.id}`;
  }

  return { items: page.map(toSummary), cursor: nextCursor, total };
}

/**
 * Ranked search returning full summaries.
 *
 * Lives here rather than in the IPC layer so it goes through the same
 * restriction clauses as every other read (§23) — a search box is otherwise
 * the easiest way around a filtered list.
 */
export function searchRanked(db: Db, q: string, limit: number): MediaSummary[] {
  const ids = searchMediaIds(db, q, limit);
  if (ids.length === 0) return [];

  const restrictions = mediaClauses();
  const guard = restrictions.map((c) => ` AND (${c.sql})`).join('');
  const rows = db
    .prepare(
      `SELECT m.* FROM media m
        WHERE m.id IN (${ids.map(() => '?').join(',')})${guard}`
    )
    .all(...ids, ...restrictions.flatMap((c) => c.params)) as MediaRow[];

  // Preserve bm25 order, which the IN clause does not.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((i) => byId.get(i))
    .filter((r): r is MediaRow => r !== undefined)
    .map(toSummary);
}

export function get(db: Db, id: number): MediaDetail {
  // A direct id lookup is the obvious way around a filtered list, so it gets
  // the same clauses (§23).
  const restrictions = mediaClauses();
  const guard = restrictions.map((c) => ` AND (${c.sql})`).join('');
  const r = db
    .prepare(`SELECT m.* FROM media m WHERE m.id = ?${guard}`)
    .get(id, ...restrictions.flatMap((c) => c.params)) as MediaRow | undefined;
  if (!r) throw new Error(`No media with id ${id}`);

  const audio = db.prepare('SELECT * FROM audio_meta WHERE media_id = ?').get(id) as
    | Record<string, never>
    | undefined;
  const video = db.prepare('SELECT * FROM video_meta WHERE media_id = ?').get(id) as
    | Record<string, never>
    | undefined;
  const fieldRows = db
    .prepare('SELECT key, value FROM media_fields WHERE media_id = ?')
    .all(id) as { key: string; value: string | null }[];

  return {
    ...toSummary(r),
    path: r.path,
    fileName: r.file_name,
    ext: r.ext,
    sizeBytes: r.size_bytes,
    container: r.container,
    videoCodec: r.video_codec,
    audioCodec: r.audio_codec,
    width: r.width,
    height: r.height,
    needsRemux: r.needs_remux === 1,
    remuxReason: r.remux_reason,
    overview: r.overview,
    genres: r.genres ? (JSON.parse(r.genres) as string[]) : [],
    trailerYtId: r.trailer_yt_id,
    thumbSource: r.thumb_source,
    provider: r.provider,
    providerId: r.provider_id,
    imdbId: r.imdb_id,
    addedAt: r.added_at,
    fields: Object.fromEntries(fieldRows.map((f) => [f.key, f.value ?? ''])),
    audio: audio
      ? {
          artist: audio['artist'] ?? null,
          albumArtist: audio['album_artist'] ?? null,
          album: audio['album'] ?? null,
          trackNo: audio['track_no'] ?? null,
          discNo: audio['disc_no'] ?? null,
          genre: audio['genre'] ?? null,
          mbRecordingId: audio['mb_recording_id'] ?? null,
          mbReleaseId: audio['mb_release_id'] ?? null,
          mbReleaseGroupId: audio['mb_release_group_id'] ?? null,
        }
      : null,
    video: video
      ? {
          tagline: video['tagline'] ?? null,
          runtimeMin: video['runtime_min'] ?? null,
          contentRating: video['content_rating'] ?? null,
          backdropPath: video['backdrop_path'] ?? null,
          tmdbId: video['tmdb_id'] ?? null,
          isEpisode: video['is_episode'] === 1,
          season: video['season'] ?? null,
          episode: video['episode'] ?? null,
          seriesTitle: video['series_title'] ?? null,
        }
      : null,
  };
}

export function setRating(db: Db, id: number, rating: number | null): void {
  db.prepare('UPDATE media SET user_rating = ? WHERE id = ?').run(rating, id);
}

/** §23. Hiding is a plain flag; unhiding requires an unlocked session, which
 *  the IPC layer checks before calling here. */
export function setHidden(db: Db, id: number, hidden: boolean): void {
  db.prepare('UPDATE media SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
}

export function setAgeRating(db: Db, id: number, ageMin: number | null): void {
  db.prepare('UPDATE media SET age_min = ? WHERE id = ?').run(ageMin, id);
}

/**
 * Playback position, written back every few seconds and on pause.
 * Positions inside the first or last 5% are treated as "not partway through",
 * so a title you just started or just finished doesn't sit in Continue Watching.
 */
export function setProgress(db: Db, id: number, positionMs: number): void {
  const row = db.prepare('SELECT duration_ms FROM media WHERE id = ?').get(id) as
    | { duration_ms: number | null }
    | undefined;
  if (!row) return;

  const duration = row.duration_ms;
  const trivial =
    duration !== null && duration > 0 && (positionMs < duration * 0.05 || positionMs > duration * 0.95);

  db.prepare('UPDATE media SET resume_ms = ?, last_played_at = ? WHERE id = ?').run(
    trivial ? null : positionMs,
    Date.now(),
    id
  );
}

export function markFinished(db: Db, id: number): void {
  db.prepare(
    'UPDATE media SET play_count = play_count + 1, resume_ms = NULL, last_played_at = ? WHERE id = ?'
  ).run(Date.now(), id);
}

export function setFields(db: Db, id: number, patch: Record<string, string | null>): MediaDetail {
  const upsert = db.prepare(
    `INSERT INTO media_fields (media_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(media_id, key) DO UPDATE SET value = excluded.value`
  );
  const del = db.prepare('DELETE FROM media_fields WHERE media_id = ? AND key = ?');

  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) del.run(id, key);
      else upsert.run(id, key, value);
    }
    reindexMedia(db, id);
  })();

  return get(db, id);
}

export interface InsertMedia {
  kind: MediaKind;
  path: string;
  fileName: string;
  ext: string;
  sizeBytes?: number | null;
  mtimeMs?: number | null;
  title?: string | null;
}

/** Returns the row id. Existing paths are left untouched. */
export function insert(db: Db, m: InsertMedia): number {
  const existing = db.prepare('SELECT id FROM media WHERE path = ?').get(m.path) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const title = m.title ?? m.fileName.replace(/\.[^.]+$/, '');
  const info = db
    .prepare(
      `INSERT INTO media (kind, path, file_name, ext, size_bytes, mtime_ms, title, sort_title, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.kind,
      m.path,
      m.fileName,
      m.ext,
      m.sizeBytes ?? null,
      m.mtimeMs ?? null,
      title,
      title.toLowerCase().replace(/^(the|a|an)\s+/i, ''),
      Date.now()
    );
  const id = Number(info.lastInsertRowid);
  reindexMedia(db, id);
  return id;
}

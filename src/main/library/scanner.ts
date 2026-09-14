import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename } from 'node:path';
import type { MediaKind, ScanResult } from '@shared/types';
import { Pool } from '../concurrency';
import type { Db } from '../db/connection';
import { reindexMedia } from '../db/search';
import type { ConcurrencyBudget } from '../transcode/budget';
import { quickHash } from './hash';
import { probeFile, type ProbeResult } from './probe';
import { kindForExtension, walkMedia, type WalkEntry } from './walk';
import type { EventMap } from '@shared/ipc-contract';

/**
 * Library scanning.
 *
 * The rules that matter, in order of how annoying getting them wrong would be:
 *
 *  1. **A file that moved keeps its history.** Reorganising a media folder is
 *     normal. Matching on quick-hash means ratings, play counts and group
 *     membership follow the file instead of being silently reset.
 *  2. **A file that vanished is flagged, not deleted.** An unplugged drive must
 *     not destroy a library.
 *  3. **A rescan is cheap.** Unchanged files (same size and mtime, already
 *     probed) skip both hashing and ffprobe entirely.
 *  4. **One bad file cannot stop a scan.** Every per-file failure is counted
 *     and reported, never thrown.
 *  5. **Probing runs concurrently.** AAR-M1 D3 measured a cold scan at 98%
 *     ffprobe wait, serial — 43.5 ms/file, ~14.5 min at 20,000 files, with our
 *     own code accounting for the other 2%. Probes now go through a bounded
 *     pool while row bookkeeping stays serial, because the bookkeeping is the
 *     2% and SQLite writes here are synchronous anyway.
 */

/**
 * Wire shapes live in @shared/types and are re-exported here rather than
 * redeclared. AAR-M1 D1: ScanResult and ServerStatus were each defined twice,
 * once in main and once in shared. They were structurally identical so nothing
 * complained, but two definitions of one wire shape drift the moment someone
 * edits the nearer one.
 */
export type { ScanResult };

/** Progress events use the contract's shape (EventMap['scan:progress']). */
export type ScanProgress = EventMap['scan:progress'];

export interface ScanOptions {
  /** Re-probe everything, ignoring the size/mtime fast path. */
  full?: boolean;
  onProgress?: (p: ScanProgress) => void;
  isCancelled?: () => boolean;
  /** Injectable so tests don't need an ffprobe binary. */
  probe?: (path: string, ext: string) => Promise<ProbeResult>;
  /**
   * How many probes may run at once. Defaults to the machine's parallelism,
   * capped — ffprobe is a subprocess per file, so this is a process count, and
   * past a point the disk becomes the limit rather than the CPU (PRA-M1b §12
   * falsification 1).
   */
  concurrency?: number;
  /**
   * When supplied, the probe pool shrinks while an active transcode holds
   * cores from this budget and grows back once it releases them (PRA-M1c
   * §5.4). Omitted, a scan sizes itself exactly as before M1c.
   */
  budget?: ConcurrencyBudget;
}

/** ffprobe is one subprocess per file; 8 is plenty and 1 is the old behaviour. */
export function defaultProbeConcurrency(): number {
  return Math.min(8, Math.max(2, availableParallelism()));
}

/**
 * Builds the probe pool and, if a shared budget was supplied, wires it to
 * resize as transcode jobs reserve and release cores. `release()` must be
 * called once the pool has drained, or the subscription outlives the scan.
 */
/** Exported for its own test (PRA-M1c §9 item 11g) — not part of the public scan API. */
export function createProbePool(options: {
  concurrency?: number;
  isCancelled?: () => boolean;
  budget?: ConcurrencyBudget;
}): { pool: Pool; release: () => void } {
  const target = Math.max(1, options.concurrency ?? defaultProbeConcurrency());
  const { budget } = options;
  const initialSize = budget ? Math.max(1, Math.min(target, budget.available)) : target;

  const pool = new Pool({ size: initialSize, isCancelled: options.isCancelled });

  const unsubscribe = budget?.onChange(() => {
    pool.resize(Math.max(1, Math.min(target, budget.available)));
  });

  return { pool, release: () => unsubscribe?.() };
}

interface ExistingRow {
  id: number;
  path: string;
  size_bytes: number | null;
  mtime_ms: number | null;
  probed_at: number | null;
  missing: number;
}

/** Strip a filename down to something worth showing before metadata arrives. */
export function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sortTitle(title: string): string {
  return title.toLowerCase().replace(/^(the|a|an)\s+/, '');
}

export async function scanSource(
  db: Db,
  source: { id: number; kind: MediaKind; path: string },
  options: ScanOptions = {}
): Promise<ScanResult> {
  const started = Date.now();
  const { full = false, onProgress, isCancelled, probe = probeFile } = options;

  /**
   * Scan marker — a strictly increasing stamp, not just the clock.
   *
   * Files seen by this scan get `seen_at = marker`; anything left below it is
   * missing. Using Date.now() directly breaks when two scans land in the same
   * millisecond (trivial in tests, and reachable on Windows where the clock
   * granularity can be ~15 ms) — the previous scan's stamp is then not less
   * than this one's, and nothing is ever flagged. Deriving the marker from the
   * highest stamp already present makes it monotonic regardless of the clock,
   * including across a daylight-saving change or an NTP correction.
   */
  const previous = db
    .prepare(`SELECT MAX(seen_at) AS m FROM media WHERE source_id = ?`)
    .get(source.id) as { m: number | null };
  const marker = Math.max(started, (previous.m ?? 0) + 1);

  const result: ScanResult = {
    kind: source.kind,
    scanned: 0,
    added: 0,
    updated: 0,
    moved: 0,
    missing: 0,
    unchanged: 0,
    failed: 0,
    errors: [],
    cancelled: false,
    durationMs: 0,
  };

  const byPath = db.prepare(
    `SELECT id, path, size_bytes, mtime_ms, probed_at, missing FROM media WHERE path = ?`
  );
  /**
   * Move candidates, not merely hash matches.
   *
   * Two identical files in a library are common and legitimate — the same
   * track on an album and a compilation, a film kept in two places. Matching
   * on hash alone would treat the second one as a move of the first and make
   * the first vanish from the catalogue. A move is only a move when the other
   * copy is no longer where we last saw it.
   */
  const byHash = db.prepare(
    `SELECT id, path, size_bytes, mtime_ms, probed_at, missing
       FROM media WHERE quick_hash = ? AND kind = ?`
  );
  const touchSeen = db.prepare(`UPDATE media SET seen_at = ?, missing = 0 WHERE id = ?`);
  const insertRow = db.prepare(
    `INSERT INTO media (kind, path, file_name, ext, size_bytes, mtime_ms, quick_hash,
                        title, sort_title, added_at, seen_at, source_id)
     VALUES (@kind, @path, @fileName, @ext, @sizeBytes, @mtimeMs, @quickHash,
             @title, @sortTitle, @addedAt, @seenAt, @sourceId)`
  );
  const relocate = db.prepare(
    `UPDATE media SET path = ?, file_name = ?, size_bytes = ?, mtime_ms = ?,
                      missing = 0, seen_at = ?, source_id = ?
       WHERE id = ?`
  );
  const applyProbe = db.prepare(
    `UPDATE media SET duration_ms = @durationMs, container = @container,
                      video_codec = @videoCodec, audio_codec = @audioCodec,
                      width = @width, height = @height,
                      needs_remux = @needsRemux, remux_reason = @remuxReason,
                      probed_at = @probedAt
       WHERE id = @id`
  );

  const noteError = (path: string, e: unknown): void => {
    result.failed++;
    const message = e instanceof Error ? e.message : String(e);
    // Keep the report bounded; a broken drive would otherwise produce
    // thousands of identical lines.
    if (result.errors.length < 50) result.errors.push({ path, message });
  };

  /**
   * Stage A — serial. Resolve the row: fast path, hash, insert, relocate.
   *
   * Kept serial deliberately. It is the 2% of a cold scan, every step of it is
   * a synchronous SQLite write, and doing it in walk order means the move
   * detection in the `byHash` lookup sees a stable picture. Returns the id that
   * still needs a probe, or null when the fast path already handled the file.
   */
  const resolveRow = async (entry: WalkEntry): Promise<number | null> => {
    result.scanned++;

    const existing = byPath.get(entry.path) as ExistingRow | undefined;

    // Fast path: same size, same mtime, already probed. Nothing to do but
    // mark it seen. This is what makes a rescan of 10,000 files quick.
    if (
      !full &&
      existing &&
      existing.size_bytes === entry.sizeBytes &&
      existing.mtime_ms === entry.mtimeMs &&
      existing.probed_at !== null
    ) {
      touchSeen.run(marker, existing.id);
      result.unchanged++;
      return null;
    }

    const hash = await quickHash(entry.path, entry.sizeBytes);
    let id: number;

    if (existing) {
      id = existing.id;
      relocate.run(
        entry.path,
        basename(entry.path),
        entry.sizeBytes,
        entry.mtimeMs,
        marker,
        source.id,
        id
      );
      db.prepare(`UPDATE media SET quick_hash = ? WHERE id = ?`).run(hash, id);
      result.updated++;
    } else {
      // No row at this path. Before inserting, look for the same content
      // somewhere else — that is a move, and it must keep its history.
      const candidates = byHash.all(hash, entry.kind) as ExistingRow[];
      const moved = candidates.find(
        (c) => c.path !== entry.path && (c.missing === 1 || !existsSync(c.path))
      );

      if (moved) {
        id = moved.id;
        relocate.run(
          entry.path,
          basename(entry.path),
          entry.sizeBytes,
          entry.mtimeMs,
          marker,
          source.id,
          id
        );
        result.moved++;
      } else {
        const title = titleFromFileName(basename(entry.path));
        const info = insertRow.run({
          kind: entry.kind,
          path: entry.path,
          fileName: basename(entry.path),
          ext: entry.ext,
          sizeBytes: entry.sizeBytes,
          mtimeMs: entry.mtimeMs,
          quickHash: hash,
          title,
          sortTitle: sortTitle(title),
          addedAt: Date.now(),
          seenAt: marker,
          sourceId: source.id,
        });
        id = Number(info.lastInsertRowid);
        result.added++;
      }
    }

    // The row exists before the probe is attempted, which is what makes a
    // probe failure cost the technical detail and never the catalogue entry.
    return id;
  };

  /**
   * Stage B — pooled. The probe, and the write that applies it.
   *
   * The write runs in the settle callback rather than inside the task: it is a
   * synchronous SQLite statement on the single JS thread, so it cannot
   * interleave with another write, and keeping it out of the task means the
   * pool's concurrency bounds subprocesses rather than transactions.
   */
  const { pool, release: releasePool } = createProbePool({
    concurrency: options.concurrency,
    isCancelled,
    budget: options.budget,
  });

  const applyProbeResult = (id: number, p: ProbeResult): void => {
    applyProbe.run({
      id,
      durationMs: p.durationMs,
      container: p.container,
      videoCodec: p.videoCodec,
      audioCodec: p.audioCodec,
      width: p.width,
      height: p.height,
      needsRemux: p.needsRemux ? 1 : 0,
      remuxReason: p.remuxReason,
      probedAt: Date.now(),
    });
  };

  for await (const entry of walkMedia(source.path, {
    isCancelled,
    onError: (path, error) => noteError(path, error),
  })) {
    if (isCancelled?.()) break;

    let id: number | null = null;
    try {
      id = await resolveRow(entry);
    } catch (e) {
      noteError(entry.path, e);
    }

    if (id !== null) {
      const rowId = id;
      // submit() resolves when there is room in the queue, not when the probe
      // finishes — that is the backpressure that stops a walk of 20,000 files
      // buffering 20,000 pending probes.
      await pool.submit(
        () => probe(entry.path, entry.ext),
        (settled) => {
          if (settled.ok) applyProbeResult(rowId, settled.value);
          // A cancellation is not a failure. Without this guard, cancelling a
          // scan of 20,000 files would report 20,000 errors.
          else if (!isCancelled?.()) noteError(entry.path, settled.error);
          reindexMedia(db, rowId);
        }
      );
    }

    if (result.scanned % 25 === 0) {
      onProgress?.({
        kind: source.kind,
        scanned: result.scanned,
        added: result.added,
        updated: result.updated,
        moved: result.moved,
        current: entry.path,
        done: false,
      });
    }
  }

  // Every probe must have landed before the missing sweep runs, or a file that
  // was found would be marked gone.
  await pool.drain();
  releasePool();

  // walkMedia returns silently when cancelled, so the loop above can end
  // without ever running its own check. Ask once more here.
  if (isCancelled?.()) result.cancelled = true;

  // Anything belonging to this source that the walk didn't touch is gone.
  // Flagged, never deleted — see rule 2. Skipped after a cancellation, where
  // "not seen" means "not reached", not "not there".
  if (!result.cancelled) {
    const info = db
      .prepare(
        `UPDATE media SET missing = 1
          WHERE source_id = ? AND missing = 0 AND (seen_at IS NULL OR seen_at < ?)`
      )
      .run(source.id, marker);
    result.missing = info.changes;
  }

  db.prepare(`UPDATE sources SET last_scan_at = ? WHERE id = ?`).run(Date.now(), source.id);

  result.durationMs = Date.now() - started;
  onProgress?.({
    kind: source.kind,
    scanned: result.scanned,
    added: result.added,
    updated: result.updated,
    moved: result.moved,
    current: null,
    done: true,
  });

  return result;
}

/**
 * Import explicit paths — the drag-and-drop and file-dialog route.
 *
 * A dropped FOLDER is walked recursively rather than skipped, which is what
 * anyone dropping a season folder expects (AAR-M0 D4).
 */
export async function importPaths(
  db: Db,
  paths: string[],
  options: ScanOptions & { stat: (p: string) => Promise<{ isDirectory: boolean; size: number; mtimeMs: number } | null> }
): Promise<{ imported: number; skipped: number; failed: number }> {
  const { probe = probeFile, isCancelled } = options;
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  const entries: WalkEntry[] = [];

  for (const p of paths) {
    const st = await options.stat(p);
    if (!st) {
      skipped++;
      continue;
    }

    if (st.isDirectory) {
      for await (const entry of walkMedia(p, { isCancelled })) entries.push(entry);
      continue;
    }

    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    const kind = kindForExtension(ext);
    if (!kind) {
      skipped++;
      continue;
    }
    entries.push({ path: p, kind, ext, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) });
  }

  const byPath = db.prepare(`SELECT id FROM media WHERE path = ?`);
  const applyProbe = db.prepare(
    `UPDATE media SET duration_ms = ?, container = ?, video_codec = ?, audio_codec = ?,
                      width = ?, height = ?, needs_remux = ?, remux_reason = ?, probed_at = ?
       WHERE id = ?`
  );

  // Same split as scanSource: rows resolved serially, probes pooled. A dropped
  // season folder is a few hundred files, and the wait is all ffprobe.
  const { pool, release: releasePool } = createProbePool({
    concurrency: options.concurrency,
    isCancelled,
    budget: options.budget,
  });

  for (const entry of entries) {
    if (isCancelled?.()) break;
    try {
      const existing = byPath.get(entry.path) as { id: number } | undefined;
      if (existing) {
        skipped++;
        continue;
      }

      const hash = await quickHash(entry.path, entry.sizeBytes);
      const title = titleFromFileName(basename(entry.path));
      const info = db
        .prepare(
          `INSERT INTO media (kind, path, file_name, ext, size_bytes, mtime_ms, quick_hash,
                              title, sort_title, added_at, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entry.kind,
          entry.path,
          basename(entry.path),
          entry.ext,
          entry.sizeBytes,
          entry.mtimeMs,
          hash,
          title,
          sortTitle(title),
          Date.now(),
          Date.now()
        );
      const id = Number(info.lastInsertRowid);

      await pool.submit(
        () => probe(entry.path, entry.ext),
        (settled) => {
          if (settled.ok) {
            const p = settled.value;
            applyProbe.run(
              p.durationMs, p.container, p.videoCodec, p.audioCodec,
              p.width, p.height, p.needsRemux ? 1 : 0, p.remuxReason, Date.now(), id
            );
          }
          // A probe failure leaves the item catalogued without technical
          // detail; it still plays if the format allows.
          reindexMedia(db, id);
        }
      );

      imported++;
    } catch {
      failed++;
    }
  }

  await pool.drain();
  releasePool();

  return { imported, skipped, failed };
}

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Segment cache layout and eviction (PRA-M1c §5.5).
 *
 * `userData/transcode/<mediaId>-<fingerprint>/` for the from-start job,
 * `.../seek-<bucketSeconds>/` beneath it for a seek past the generated
 * frontier. Video bytes don't go stale the way a metadata answer does — what
 * bounds this cache is disk space, not time, so eviction is a size cap with
 * LRU by directory mtime, plus fingerprint invalidation when a rescan sees
 * the source file change.
 */

/** Cheap, already on the `media` row — a rescan that changes either invalidates the cache. */
export function fingerprint(sizeBytes: number, mtimeMs: number): string {
  return `${String(sizeBytes)}-${String(Math.round(mtimeMs))}`;
}

export function mediaDir(root: string, mediaId: number, fp: string): string {
  return join(root, `${String(mediaId)}-${fp}`);
}

/** Buckets a seek to the nearest segment boundary so repeated seeks near one spot share a job. */
export function seekBucketSeconds(startSeconds: number, hlsTimeSeconds = 6): number {
  return Math.max(0, Math.floor(startSeconds / hlsTimeSeconds) * hlsTimeSeconds);
}

export function jobDir(root: string, mediaId: number, fp: string, startSeconds = 0): string {
  const base = mediaDir(root, mediaId, fp);
  if (startSeconds <= 0) return join(base, 'full');
  return join(base, `seek-${String(seekBucketSeconds(startSeconds))}`);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Delete every cached directory for `mediaId` that does not match its
 * current fingerprint — a rescan that sees the file replaced or re-encoded
 * invalidates the stale cache rather than serving it.
 */
export function evictStaleFingerprints(root: string, mediaId: number, currentFingerprint: string): void {
  if (!existsSync(root)) return;
  const prefix = `${String(mediaId)}-`;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    if (name === `${prefix}${currentFingerprint}`) continue;
    rmSync(join(root, name), { recursive: true, force: true });
  }
}

interface CacheEntry {
  path: string;
  bytes: number;
  mtimeMs: number;
}

function directorySize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    total += name.isDirectory() ? directorySize(p) : statSync(p).size;
  }
  return total;
}

/**
 * Enforce a total-size cap across every `<mediaId>-<fingerprint>` directory,
 * evicting the least-recently-used first. `activeDirs` are never evicted —
 * deleting a directory ffmpeg is actively writing into would corrupt a live
 * job, not just waste the eviction.
 */
export function enforceSizeCap(root: string, maxBytes: number, activeDirs: ReadonlySet<string>): void {
  if (!existsSync(root)) return;

  const entries: CacheEntry[] = readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => !activeDirs.has(p))
    .map((p) => ({ path: p, bytes: directorySize(p), mtimeMs: statSync(p).mtimeMs }));

  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= maxBytes) return;

  // Oldest first.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    rmSync(entry.path, { recursive: true, force: true });
    total -= entry.bytes;
  }
}

/** Default cap — a hardcoded constant this phase; a Settings UI value is out of scope (PRA-M1c §9). */
export const DEFAULT_CACHE_CAP_BYTES = 5 * 1024 * 1024 * 1024;

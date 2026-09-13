import { opendir, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MediaKind } from '@shared/types';

/**
 * Recursive directory walking for the library scanner.
 *
 * Three things this has to get right on a real media folder:
 *
 *  - **Depth.** `Movies/Alien (1979)/Alien.mkv` and
 *    `Music/Radiohead/Kid A/01 Everything.flac` are the normal shapes, not edge
 *    cases. There is no depth limit; the walk is iterative rather than
 *    recursive so a deep tree can't blow the stack.
 *  - **Symlink cycles.** A directory symlink pointing at an ancestor makes a
 *    naive walk run forever. Directories are tracked by resolved real path, so
 *    a cycle is visited once and then skipped.
 *  - **Noise.** System and application folders are skipped outright rather than
 *    walked and filtered, because some of them (`System Volume Information`)
 *    throw on read and others (`node_modules`) are enormous.
 */

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv', '.flv',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.ogv', '.3gp',
]);

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus',
  '.wma', '.aiff', '.aif', '.alac', '.ape', '.wv', '.mka',
]);

export function kindForExtension(ext: string): MediaKind | null {
  const e = ext.toLowerCase();
  if (VIDEO_EXTENSIONS.has(e)) return 'video';
  if (AUDIO_EXTENSIONS.has(e)) return 'audio';
  return null;
}

/** Directory names skipped wherever they appear. Compared case-insensitively. */
const SKIP_DIRS = new Set([
  // Windows
  '$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws',
  'recovery', 'config.msi',
  // macOS / NAS
  '.spotlight-v100', '.trashes', '.fseventsd', '.documentrevisions-v100',
  '.temporaryitems', '@eadir', '.appledouble', '.ds_store',
  // Linux
  '.trash', '.trash-1000', 'lost+found',
  // Development and tooling noise that has no business in a media library
  'node_modules', '.git', '.svn', '.hg', '__macosx',
]);

/**
 * Files skipped by name prefix. Partial downloads and editing sidecars are
 * real files with real media extensions, and cataloguing them is worse than
 * useless — they change or vanish.
 */
const SKIP_FILE_PREFIXES = ['.', '~$', '._'];
const SKIP_FILE_SUFFIXES = ['.part', '.crdownload', '.tmp', '.!ut', '.partial'];

export interface WalkEntry {
  path: string;
  kind: MediaKind;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Called for each directory entered, so a scan can report where it is. */
  onDirectory?: (path: string) => void;
  /** Return true to stop the walk early. Checked per directory and per file. */
  isCancelled?: () => boolean;
  /** Non-fatal problems: an unreadable folder shouldn't abort a whole scan. */
  onError?: (path: string, error: Error) => void;
}

function shouldSkipDirectory(name: string): boolean {
  return SKIP_DIRS.has(name.toLowerCase());
}

function shouldSkipFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_FILE_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (SKIP_FILE_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  return false;
}

/**
 * Yields every media file under `root`, to any depth.
 *
 * An async generator rather than an array: a large library should start
 * producing rows immediately and never hold the whole listing in memory.
 */
export async function* walkMedia(
  root: string,
  options: WalkOptions = {}
): AsyncGenerator<WalkEntry> {
  const { onDirectory, isCancelled, onError } = options;

  // Resolved real paths of directories already visited — the cycle guard.
  const seen = new Set<string>();
  const queue: string[] = [root];

  while (queue.length > 0) {
    if (isCancelled?.()) return;

    const dir = queue.pop();
    if (dir === undefined) break;

    let real: string;
    try {
      real = await realpath(dir);
    } catch (e) {
      onError?.(dir, e as Error);
      continue;
    }

    if (seen.has(real)) continue;
    seen.add(real);
    onDirectory?.(dir);

    let handle;
    try {
      handle = await opendir(dir);
    } catch (e) {
      // Permission denied, drive unplugged mid-scan, a locked system folder.
      onError?.(dir, e as Error);
      continue;
    }

    try {
      for await (const entry of handle) {
        if (isCancelled?.()) return;

        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!shouldSkipDirectory(entry.name)) queue.push(full);
          continue;
        }

        // Symlinks are resolved: a link to a file is followed, a link to a
        // directory joins the queue and the cycle guard handles the rest.
        if (entry.isSymbolicLink()) {
          try {
            const target = await stat(full);
            if (target.isDirectory()) {
              queue.push(full);
              continue;
            }
          } catch (e) {
            onError?.(full, e as Error);
            continue;
          }
        } else if (!entry.isFile()) {
          continue;
        }

        if (shouldSkipFile(entry.name)) continue;

        const ext = extname(entry.name).toLowerCase();
        const kind = kindForExtension(ext);
        if (!kind) continue;

        try {
          const st = await stat(full);
          if (st.size === 0) continue; // a zero-byte file is a placeholder, not media
          yield {
            path: full,
            kind,
            ext,
            sizeBytes: st.size,
            mtimeMs: Math.round(st.mtimeMs),
          };
        } catch (e) {
          onError?.(full, e as Error);
        }
      }
    } catch (e) {
      onError?.(dir, e as Error);
    }
  }
}

/** Collect a walk into an array. Convenience for small trees and for tests. */
export async function collectMedia(root: string, options?: WalkOptions): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  for await (const entry of walkMedia(root, options)) out.push(entry);
  return out;
}

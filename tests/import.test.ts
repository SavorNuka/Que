import { stat } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/main/db/connection';
import { importPaths } from '../src/main/library/scanner';
import type { ProbeResult } from '../src/main/library/probe';
import { cleanup, makeFakeMedia, tempDir } from './helpers/media';
import { freshDb } from './helpers/db';

/**
 * Drag-and-drop and dialog import.
 *
 * AAR-M1 D2: this shipped in M1 as the fix for AAR-M0 D4 and had no test at
 * all, which is how an untested path becomes a regression later. Folder
 * recursion is the behaviour that was actually broken before, so it leads.
 */

const fakeProbe = async (): Promise<ProbeResult> => ({
  durationMs: 1000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 320,
  height: 240,
  needsRemux: false,
  remuxReason: null,
  tags: {},
});

const statFn = async (p: string): Promise<{ isDirectory: boolean; size: number; mtimeMs: number } | null> => {
  try {
    const s = await stat(p);
    return { isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
};

let db: Db;
let root: string;

const run = (paths: string[]) => importPaths(db, paths, { stat: statFn, probe: fakeProbe });
const count = (): number => (db.prepare('SELECT count(*) c FROM media').get() as { c: number }).c;

beforeEach(() => {
  db = freshDb();
  root = tempDir('que-import-');
});
afterEach(() => {
  db.close();
  cleanup(root);
});

describe('importPaths', () => {
  it('imports individual files', async () => {
    const a = makeFakeMedia(root, 'one.mp4', 4096, 'a');
    const b = makeFakeMedia(root, 'two.mp3', 4096, 'b');

    const r = await run([a, b]);

    expect(r.imported).toBe(2);
    expect(count()).toBe(2);
  });

  /** The AAR-M0 D4 fix: a dropped folder is walked, not skipped. */
  it('walks a dropped folder recursively', async () => {
    mkdirSync(join(root, 'Season 1'), { recursive: true });
    makeFakeMedia(join(root, 'Season 1'), 'S01E01.mp4', 4096, 'a');
    makeFakeMedia(join(root, 'Season 1'), 'S01E02.mp4', 4096, 'b');
    makeFakeMedia(join(root, 'Season 2', 'Extras'), 'deleted-scene.mp4', 4096, 'c');

    const r = await run([root]);

    expect(r.imported).toBe(3);
    expect(count()).toBe(3);
  });

  it('ignores non-media inside a dropped folder without counting it as skipped', async () => {
    makeFakeMedia(root, 'movie.mp4', 4096, 'a');
    writeFileSync(join(root, 'poster.jpg'), 'x');
    writeFileSync(join(root, 'notes.txt'), 'x');

    const r = await run([root]);

    expect(r.imported).toBe(1);
    // The walk filters these out, so they never become "skipped" — only a
    // file the user explicitly picked counts as skipped.
    expect(r.skipped).toBe(0);
  });

  it('skips a non-media file the user picked directly', async () => {
    const txt = join(root, 'notes.txt');
    writeFileSync(txt, 'x');

    const r = await run([txt]);

    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('skips a path that does not exist', async () => {
    const r = await run([join(root, 'nope.mp4')]);
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('does not import the same file twice', async () => {
    const a = makeFakeMedia(root, 'one.mp4', 4096, 'a');

    expect((await run([a])).imported).toBe(1);
    const second = await run([a]);

    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(count()).toBe(1);
  });

  it('records probe data and makes the item searchable', async () => {
    const a = makeFakeMedia(root, 'Blade.Runner.1982.mp4', 4096, 'a');
    await run([a]);

    const row = db.prepare('SELECT title, duration_ms, video_codec FROM media').get() as {
      title: string;
      duration_ms: number;
      video_codec: string;
    };
    expect(row.title).toBe('Blade Runner 1982');
    expect(row.duration_ms).toBe(1000);
    expect(row.video_codec).toBe('h264');

    const { searchMediaIds } = await import('../src/main/db/search');
    expect(searchMediaIds(db, 'blade')).toHaveLength(1);
  });

  it('still catalogues a file whose probe fails', async () => {
    const a = makeFakeMedia(root, 'broken.mp4', 4096, 'a');

    const r = await importPaths(db, [a], {
      stat: statFn,
      probe: async () => {
        throw new Error('ffprobe exploded');
      },
    });

    expect(r.imported).toBe(1);
    const row = db.prepare('SELECT duration_ms FROM media').get() as { duration_ms: number | null };
    expect(row.duration_ms).toBeNull();
  });

  it('leaves source_id null so a later source scan will not flag it missing', async () => {
    const a = makeFakeMedia(root, 'hand-added.mp4', 4096, 'a');
    await run([a]);

    const row = db.prepare('SELECT source_id FROM media').get() as { source_id: number | null };
    expect(row.source_id).toBeNull();
  });

  it('accepts a mix of files and folders in one drop', async () => {
    const loose = makeFakeMedia(root, 'loose.mp4', 4096, 'z');
    mkdirSync(join(root, 'folder'), { recursive: true });
    makeFakeMedia(join(root, 'folder'), 'inside.mp4', 4096, 'y');

    const r = await run([loose, join(root, 'folder')]);

    expect(r.imported).toBe(2);
  });
});

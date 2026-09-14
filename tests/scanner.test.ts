import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/main/db/connection';
import * as sourcesRepo from '../src/main/db/repos/sources';
import { createProbePool, scanSource, titleFromFileName } from '../src/main/library/scanner';
import type { ProbeResult } from '../src/main/library/probe';
import { ConcurrencyBudget } from '../src/main/transcode/budget';
import { cleanup, makeFakeMedia, tempDir } from './helpers/media';
import { freshDb } from './helpers/db';

/**
 * The scanner is tested with an injected probe rather than ffprobe: these tests
 * are about the diffing rules — added, unchanged, moved, missing — which are
 * where a mistake quietly destroys someone's ratings.
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

let db: Db;
let root: string;

function source(kind: 'video' | 'audio' = 'video'): { id: number; kind: 'video' | 'audio'; path: string } {
  const s = sourcesRepo.set(db, kind, root);
  return { id: s.id, kind, path: root };
}

const scan = (opts = {}) => scanSource(db, source(), { probe: fakeProbe, ...opts });

const rows = (): { id: number; path: string; missing: number; user_rating: number | null }[] =>
  db.prepare('SELECT id, path, missing, user_rating FROM media ORDER BY id').all() as never;

beforeEach(() => {
  db = freshDb();
  root = tempDir('que-scan-');
});
afterEach(() => {
  db.close();
  cleanup(root);
});

describe('titleFromFileName', () => {
  it.each([
    ['Blade.Runner.1982.mkv', 'Blade Runner 1982'],
    ['01_Everything_In_Its_Right_Place.flac', '01 Everything In Its Right Place'],
    ['Alien.mkv', 'Alien'],
  ])('%s -> %s', (input, expected) => {
    expect(titleFromFileName(input)).toBe(expected);
  });
});

describe('scanSource', () => {
  it('adds media found at any depth', async () => {
    makeFakeMedia(join(root, 'Alien (1979)'), 'Alien.mp4');
    makeFakeMedia(join(root, 'Series', 'Season 1'), 'S01E01.mp4');

    const r = await scan();

    expect(r.added).toBe(2);
    expect(r.scanned).toBe(2);
    expect(r.failed).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  it('records probe results', async () => {
    makeFakeMedia(root, 'movie.mp4');
    await scan();

    const row = db.prepare('SELECT duration_ms, video_codec, width, needs_remux, probed_at FROM media').get() as {
      duration_ms: number;
      video_codec: string;
      width: number;
      needs_remux: number;
      probed_at: number;
    };
    expect(row.duration_ms).toBe(1000);
    expect(row.video_codec).toBe('h264');
    expect(row.width).toBe(320);
    expect(row.needs_remux).toBe(0);
    expect(row.probed_at).toBeGreaterThan(0);
  });

  it('treats an unchanged file as unchanged on rescan', async () => {
    makeFakeMedia(root, 'movie.mp4');
    await scan();

    let probes = 0;
    await scanSource(db, source(), {
      probe: async () => {
        probes++;
        return fakeProbe();
      },
    });

    expect(probes).toBe(0); // the fast path skipped ffprobe entirely
    expect(rows()).toHaveLength(1);
  });

  it('re-probes an unchanged file when asked for a full scan', async () => {
    makeFakeMedia(root, 'movie.mp4');
    await scan();

    let probes = 0;
    const r = await scanSource(db, source(), {
      full: true,
      probe: async () => {
        probes++;
        return fakeProbe();
      },
    });

    expect(probes).toBe(1);
    expect(r.added).toBe(0);
  });

  /**
   * The rule that matters most: reorganising a folder must not reset the
   * user's ratings and play history.
   */
  it('recognises a moved file and keeps its history', async () => {
    const original = makeFakeMedia(root, 'Alien.mp4', 8192, 'z');
    await scan();

    const [before] = rows();
    db.prepare('UPDATE media SET user_rating = 9, play_count = 3 WHERE id = ?').run(before!.id);

    // Same bytes, new home.
    const movedTo = join(root, 'Alien (1979)');
    makeFakeMedia(movedTo, '.keep', 1);
    renameSync(original, join(movedTo, 'Alien.mp4'));

    const r = await scan();

    expect(r.moved).toBe(1);
    expect(r.added).toBe(0);

    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before!.id); // same row, not a new one
    expect(after[0]?.path).toContain('Alien (1979)');
    expect(after[0]?.user_rating).toBe(9);
    expect(
      (db.prepare('SELECT play_count FROM media WHERE id = ?').get(before!.id) as { play_count: number }).play_count
    ).toBe(3);
  });

  it('flags a deleted file as missing rather than deleting the row', async () => {
    makeFakeMedia(root, 'gone.mp4');
    makeFakeMedia(root, 'stays.mp4', 8192, 'b');
    await scan();
    expect(rows()).toHaveLength(2);

    rmSync(join(root, 'gone.mp4'));
    const r = await scan();

    expect(r.missing).toBe(1);
    const all = rows();
    expect(all).toHaveLength(2); // nothing deleted
    expect(all.find((x) => x.path.endsWith('gone.mp4'))?.missing).toBe(1);
    expect(all.find((x) => x.path.endsWith('stays.mp4'))?.missing).toBe(0);
  });

  it('un-flags a file that comes back', async () => {
    const path = makeFakeMedia(root, 'flaky.mp4', 8192, 'c');
    await scan();
    const backup = Buffer.alloc(8192, 'c');
    rmSync(path);
    await scan();
    expect(rows()[0]?.missing).toBe(1);

    writeFileSync(path, backup);
    await scan();
    expect(rows()[0]?.missing).toBe(0);
  });

  it('does not mark hand-imported files missing during a source scan', async () => {
    db.prepare(
      `INSERT INTO media (kind, path, file_name, ext, added_at) VALUES ('video','/elsewhere/x.mp4','x.mp4','.mp4',?)`
    ).run(Date.now());

    makeFakeMedia(root, 'in-source.mp4');
    const r = await scan();

    expect(r.missing).toBe(0);
    const external = db.prepare("SELECT missing FROM media WHERE path='/elsewhere/x.mp4'").get() as {
      missing: number;
    };
    expect(external.missing).toBe(0);
  });

  it('keeps going when one file fails to probe', async () => {
    makeFakeMedia(root, 'good.mp4');
    makeFakeMedia(root, 'bad.mp4', 8192, 'x');

    const r = await scanSource(db, source(), {
      probe: async (p) => {
        if (p.endsWith('bad.mp4')) throw new Error('ffprobe exploded');
        return fakeProbe();
      },
    });

    expect(r.added).toBe(2); // both catalogued
    expect(r.failed).toBe(1);
    expect(r.errors[0]?.message).toContain('exploded');
  });

  it('reports progress and finishes with done', async () => {
    for (let i = 0; i < 30; i++) makeFakeMedia(root, `f${i}.mp4`, 4096 + i);

    const updates: { done: boolean; scanned: number }[] = [];
    await scanSource(db, source(), { probe: fakeProbe, onProgress: (p) => updates.push(p) });

    expect(updates.length).toBeGreaterThan(1);
    expect(updates.at(-1)?.done).toBe(true);
    expect(updates.at(-1)?.scanned).toBe(30);
  });

  it('stops when cancelled and does not flag everything missing', async () => {
    for (let i = 0; i < 20; i++) makeFakeMedia(root, `f${i}.mp4`, 4096 + i);

    let seen = 0;
    const r = await scanSource(db, source(), {
      probe: fakeProbe,
      isCancelled: () => ++seen > 5,
    });

    expect(r.cancelled).toBe(true);
    // Critically: a cancelled scan must not conclude the rest of the library
    // is gone.
    expect(r.missing).toBe(0);
  });

  it('stamps last_scan_at on the source', async () => {
    makeFakeMedia(root, 'x.mp4');
    await scan();
    const s = sourcesRepo.getAll(db)[0];
    expect(s?.lastScanAt).toBeGreaterThan(0);
  });
});

/**
 * PRA-M1c §5.4 / §9 item 11g: the probe pool must shrink while a transcode
 * holds cores from the shared budget, and grow back once it releases them.
 */
describe('createProbePool — shared concurrency budget', () => {
  it('sizes itself against the budget at creation time', () => {
    const budget = new ConcurrencyBudget(8);
    budget.reserve(5); // 3 left
    const { pool, release } = createProbePool({ concurrency: 8, budget });
    expect(pool.size).toBe(3);
    release();
  });

  it('shrinks live when a transcode reserves cores after the pool exists', () => {
    const budget = new ConcurrencyBudget(8);
    const { pool, release } = createProbePool({ concurrency: 8, budget });
    expect(pool.size).toBe(8);

    const releaseTranscode = budget.reserve(5);
    expect(pool.size).toBe(3);

    releaseTranscode();
    expect(pool.size).toBe(8);
    release();
  });

  it('never shrinks below 1 even if the budget is fully claimed', () => {
    const budget = new ConcurrencyBudget(4);
    const { pool, release } = createProbePool({ concurrency: 8, budget });
    budget.reserve(4);
    budget.reserve(4);
    expect(pool.size).toBe(1);
    release();
  });

  it('is unaffected by budget changes after release() is called', () => {
    const budget = new ConcurrencyBudget(8);
    const { pool, release } = createProbePool({ concurrency: 8, budget });
    release();
    budget.reserve(6);
    expect(pool.size).toBe(8); // stale on purpose — the scan that owned it is done
  });

  it('behaves exactly as before M1c when no budget is supplied', () => {
    const { pool, release } = createProbePool({ concurrency: 5 });
    expect(pool.size).toBe(5);
    release(); // no-op, no subscription exists
  });
});

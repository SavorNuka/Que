import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectMedia, kindForExtension } from '../src/main/library/walk';
import { cleanup, makeFakeMedia, tempDir } from './helpers/media';

let root: string;

beforeEach(() => {
  root = tempDir('que-walk-');
});
afterEach(() => cleanup(root));

describe('kindForExtension', () => {
  it.each([
    ['.mkv', 'video'],
    ['.MP4', 'video'],
    ['.m2ts', 'video'],
    ['.flac', 'audio'],
    ['.OPUS', 'audio'],
  ])('%s is %s', (ext, kind) => {
    expect(kindForExtension(ext)).toBe(kind);
  });

  it.each(['.txt', '.nfo', '.jpg', '.srt', ''])('%s is not media', (ext) => {
    expect(kindForExtension(ext)).toBeNull();
  });
});

describe('walkMedia', () => {
  it('finds media at any depth', async () => {
    // The shape a real library actually has.
    makeFakeMedia(join(root, 'Alien (1979)'), 'Alien.mkv');
    makeFakeMedia(join(root, 'Blade Runner (1982)', 'Final Cut'), 'Blade Runner.mp4');
    makeFakeMedia(join(root, 'a', 'b', 'c', 'd', 'e'), 'Deep.mkv');

    const found = await collectMedia(root);
    expect(found.map((f) => f.path.split(/[\\/]/).pop()).sort()).toEqual([
      'Alien.mkv',
      'Blade Runner.mp4',
      'Deep.mkv',
    ]);
  });

  it('ignores non-media files', async () => {
    makeFakeMedia(root, 'movie.mkv');
    writeFileSync(join(root, 'movie.nfo'), 'x');
    writeFileSync(join(root, 'poster.jpg'), 'x');
    writeFileSync(join(root, 'movie.en.srt'), 'x');

    const found = await collectMedia(root);
    expect(found).toHaveLength(1);
  });

  it('skips system and noise directories', async () => {
    makeFakeMedia(join(root, '$RECYCLE.BIN'), 'deleted.mkv');
    makeFakeMedia(join(root, 'System Volume Information'), 'sys.mkv');
    makeFakeMedia(join(root, '@eaDir'), 'thumb.mkv');
    makeFakeMedia(join(root, 'node_modules', 'pkg'), 'bundled.mp4');
    makeFakeMedia(join(root, 'Real'), 'keeper.mkv');

    const found = await collectMedia(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toContain('keeper.mkv');
  });

  it('skips partial downloads and editor sidecars', async () => {
    makeFakeMedia(root, 'good.mkv');
    makeFakeMedia(root, 'downloading.mkv.part');
    makeFakeMedia(root, '.hidden.mkv');
    makeFakeMedia(root, '._resourcefork.mkv');
    makeFakeMedia(root, 'chrome.mp4.crdownload');

    const found = await collectMedia(root);
    expect(found.map((f) => f.path.split(/[\\/]/).pop())).toEqual(['good.mkv']);
  });

  it('skips zero-byte placeholders', async () => {
    writeFileSync(join(root, 'empty.mkv'), '');
    makeFakeMedia(root, 'real.mkv');

    const found = await collectMedia(root);
    expect(found).toHaveLength(1);
  });

  it('reports size and mtime for each entry', async () => {
    makeFakeMedia(root, 'sized.mkv', 12_345);
    const [entry] = await collectMedia(root);
    expect(entry?.sizeBytes).toBe(12_345);
    expect(entry?.mtimeMs).toBeGreaterThan(0);
    expect(entry?.kind).toBe('video');
    expect(entry?.ext).toBe('.mkv');
  });

  /**
   * A directory symlink pointing at an ancestor makes a naive walk run until it
   * runs out of path. This is the test that matters most in this file.
   */
  it('terminates on a symlink cycle', async () => {
    const nested = join(root, 'Series', 'Season 1');
    mkdirSync(nested, { recursive: true });
    makeFakeMedia(nested, 'S01E01.mkv');
    try {
      symlinkSync(root, join(nested, 'loop'), 'dir');
    } catch {
      return; // symlinks unavailable (unprivileged Windows) — nothing to prove
    }

    const found = await Promise.race([
      collectMedia(root),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('walk did not terminate')), 5000)),
    ]);

    expect(found).toHaveLength(1);
  });

  it('survives an unreadable directory and reports it', async () => {
    makeFakeMedia(root, 'fine.mkv');
    const errors: string[] = [];

    // A path that vanishes between listing and reading is the realistic case;
    // pointing at a non-existent root exercises the same handler.
    const found = await collectMedia(join(root, 'does-not-exist'), {
      onError: (p) => errors.push(p),
    });

    expect(found).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('stops when cancelled', async () => {
    for (let i = 0; i < 50; i++) makeFakeMedia(join(root, `dir${i}`), `file${i}.mkv`);

    let seen = 0;
    const found = await collectMedia(root, {
      isCancelled: () => seen++ > 2,
    });

    expect(found.length).toBeLessThan(50);
  });
});

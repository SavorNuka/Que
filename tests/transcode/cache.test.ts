import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_CAP_BYTES,
  enforceSizeCap,
  evictStaleFingerprints,
  fingerprint,
  jobDir,
  mediaDir,
  seekBucketSeconds,
} from '../../src/main/transcode/cache';
import { cleanup, tempDir } from '../helpers/media';

describe('fingerprint', () => {
  it('is the same for the same size/mtime', () => {
    expect(fingerprint(1000, 5000)).toBe(fingerprint(1000, 5000));
  });

  it('changes when either size or mtime changes', () => {
    const base = fingerprint(1000, 5000);
    expect(fingerprint(1001, 5000)).not.toBe(base);
    expect(fingerprint(1000, 5001)).not.toBe(base);
  });
});

describe('seekBucketSeconds', () => {
  it('rounds down to the nearest segment boundary', () => {
    expect(seekBucketSeconds(13, 6)).toBe(12);
    expect(seekBucketSeconds(6, 6)).toBe(6);
    expect(seekBucketSeconds(5, 6)).toBe(0);
  });

  it('never goes negative', () => {
    expect(seekBucketSeconds(-5)).toBe(0);
  });

  it('two seeks near the same spot bucket to the same job', () => {
    expect(seekBucketSeconds(601)).toBe(seekBucketSeconds(603));
  });
});

describe('jobDir', () => {
  it('the from-start job is a stable "full" subdirectory', () => {
    const d1 = jobDir('/root', 5, 'fp1', 0);
    const d2 = jobDir('/root', 5, 'fp1');
    expect(d1).toBe(d2);
    expect(d1.endsWith('full')).toBe(true);
  });

  it('a seek job is keyed by its bucketed offset, under the same media directory', () => {
    const seek = jobDir('/root', 5, 'fp1', 601);
    expect(seek).toContain(mediaDir('/root', 5, 'fp1'));
    expect(seek).toContain('seek-600');
  });

  it('different fingerprints for the same media never collide', () => {
    expect(mediaDir('/root', 5, 'fpA')).not.toBe(mediaDir('/root', 5, 'fpB'));
  });
});

describe('evictStaleFingerprints', () => {
  let root: string;
  beforeEach(() => {
    root = tempDir('que-cache-');
  });
  afterEach(() => cleanup(root));

  it('deletes directories for the same media id with an old fingerprint', () => {
    mkdirSync(join(root, '5-old'), { recursive: true });
    mkdirSync(join(root, '5-new'), { recursive: true });
    evictStaleFingerprints(root, 5, 'new');
    expect(existsSync(join(root, '5-old'))).toBe(false);
    expect(existsSync(join(root, '5-new'))).toBe(true);
  });

  it('never touches another media id\'s cache', () => {
    mkdirSync(join(root, '6-old'), { recursive: true });
    evictStaleFingerprints(root, 5, 'new');
    expect(existsSync(join(root, '6-old'))).toBe(true);
  });

  it('does nothing if the cache root does not exist yet', () => {
    expect(() => evictStaleFingerprints(join(root, 'missing'), 5, 'new')).not.toThrow();
  });
});

describe('enforceSizeCap', () => {
  let root: string;
  beforeEach(() => {
    root = tempDir('que-cache-');
  });
  afterEach(() => cleanup(root));

  function makeEntry(name: string, bytes: number, ageMs: number): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seg.ts'), Buffer.alloc(bytes));
    const past = new Date(Date.now() - ageMs);
    utimesSync(dir, past, past);
  }

  it('does nothing while under the cap', () => {
    makeEntry('1-a', 100, 1000);
    enforceSizeCap(root, 1_000_000, new Set());
    expect(existsSync(join(root, '1-a'))).toBe(true);
  });

  it('evicts the oldest entries first once over the cap', () => {
    makeEntry('1-old', 100, 10_000);
    makeEntry('1-new', 100, 1_000);
    enforceSizeCap(root, 150, new Set());
    expect(existsSync(join(root, '1-old'))).toBe(false);
    expect(existsSync(join(root, '1-new'))).toBe(true);
  });

  it('never evicts a directory an active job is writing into', () => {
    makeEntry('1-active', 100, 10_000);
    makeEntry('1-idle', 100, 1_000);
    enforceSizeCap(root, 50, new Set([join(root, '1-active')]));
    expect(existsSync(join(root, '1-active'))).toBe(true);
    expect(existsSync(join(root, '1-idle'))).toBe(false);
  });

  it('does nothing if the cache root does not exist yet', () => {
    expect(() => enforceSizeCap(join(root, 'missing'), 1, new Set())).not.toThrow();
  });
});

it('the default cap is a sane multi-gigabyte constant', () => {
  expect(DEFAULT_CACHE_CAP_BYTES).toBeGreaterThan(1024 * 1024 * 1024);
});

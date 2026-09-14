import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/main/db/connection';
import { MediaServer, parseRange } from '../src/main/server/server';
import * as restrictions from '../src/main/restrictions';
import { ConcurrencyBudget } from '../src/main/transcode/budget';
import { fingerprint, jobDir } from '../src/main/transcode/cache';
import { TranscodeManager, type SpawnFn } from '../src/main/transcode/manager';
import { cleanup, tempDir } from './helpers/media';
import { freshDb } from './helpers/db';

/**
 * Playback moved from que:// to HTTP specifically to get correct Range
 * handling (ASSUMPTIONS.md A2), so Range is what these tests are about — plus
 * the two properties that must hold for any client: ids only, and restriction
 * clauses apply here too.
 */

describe('parseRange', () => {
  const size = 1000;

  it('returns null when there is no header', () => {
    expect(parseRange(undefined, size)).toBeNull();
  });

  it('handles an open-ended range', () => {
    expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 });
  });

  it('handles a closed range', () => {
    expect(parseRange('bytes=0-499', size)).toEqual({ start: 0, end: 499 });
  });

  it('clamps an end beyond the file', () => {
    expect(parseRange('bytes=900-99999', size)).toEqual({ start: 900, end: 999 });
  });

  it('handles a suffix range', () => {
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
  });

  it('rejects a start past the end of the file', () => {
    expect(parseRange('bytes=5000-', size)).toBe('unsatisfiable');
  });

  it('rejects a reversed range', () => {
    expect(parseRange('bytes=500-100', size)).toBe('unsatisfiable');
  });

  it.each(['bytes=abc-def', 'items=0-10', 'bytes=0-10, 20-30', '', 'garbage'])(
    'treats %s as no range rather than throwing',
    (header) => {
      expect(() => parseRange(header, size)).not.toThrow();
    }
  );
});

describe('MediaServer', () => {
  let db: Db;
  let dir: string;
  let server: MediaServer;
  let base: string;
  let token: string;

  const CONTENT = Buffer.from('0123456789'.repeat(100)); // 1000 bytes, verifiable

  const addMedia = (opts: { needsRemux?: boolean; hidden?: boolean; ageMin?: number } = {}): number => {
    const path = join(dir, `media-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(path, CONTENT);
    const info = db
      .prepare(
        `INSERT INTO media (kind, path, file_name, ext, size_bytes, added_at, needs_remux, remux_reason, hidden, age_min)
         VALUES ('video', ?, 'x.mp4', '.mp4', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        path,
        CONTENT.length,
        Date.now(),
        opts.needsRemux ? 1 : 0,
        opts.needsRemux ? 'container' : null,
        opts.hidden ? 1 : 0,
        opts.ageMin ?? null
      );
    return Number(info.lastInsertRowid);
  };

  beforeEach(async () => {
    db = freshDb();
    dir = tempDir('que-server-');
    restrictions.configure(
      { enabled: false, maxAge: 18, allowUnrated: true, blockExplicit: false, pinSet: false, unlockMinutes: 30 },
      null
    );
    server = new MediaServer(() => db);
    const status = await server.start(0); // port 0 — let the OS choose
    base = `http://127.0.0.1:${status.port}`;
    token = status.token!;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    cleanup(dir);
  });

  it('answers /health without a token', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it('refuses a request with no token', async () => {
    const id = addMedia();
    const res = await fetch(`${base}/stream/${id}`);
    expect(res.status).toBe(401);
  });

  it('refuses a request with the wrong token', async () => {
    const id = addMedia();
    const res = await fetch(`${base}/stream/${id}?t=not-the-token`);
    expect(res.status).toBe(401);
  });

  it('serves a whole file', async () => {
    const id = addMedia();
    const res = await fetch(`${base}/stream/${id}?t=${token}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT);
  });

  /** This is the behaviour the whole HTTP decision was made for. */
  it('serves a byte range as 206 with the right bytes', async () => {
    const id = addMedia();
    const res = await fetch(`${base}/stream/${id}?t=${token}`, {
      headers: { Range: 'bytes=10-19' },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('0123456789');
  });

  it('serves an open-ended range from a seek', async () => {
    const id = addMedia();
    const res = await fetch(`${base}/stream/${id}?t=${token}`, {
      headers: { Range: 'bytes=990-' },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(await res.text()).toBe('0123456789');
  });

  it('returns 416 for a range past the end', async () => {
    const id = addMedia();
    const res = await fetch(`${base}/stream/${id}?t=${token}`, {
      headers: { Range: 'bytes=99999-' },
    });

    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('answers HEAD without a body', async () => {
    const id = addMedia();
    const res = await fetch(`${base}/stream/${id}?t=${token}`, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    expect((await res.text()).length).toBe(0);
  });

  it('rejects methods other than GET and HEAD', async () => {
    const res = await fetch(`${base}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('404s an unknown id', async () => {
    const res = await fetch(`${base}/stream/99999?t=${token}`);
    expect(res.status).toBe(404);
  });

  it('410s when the file has moved away from its recorded path', async () => {
    const id = addMedia();
    db.prepare('UPDATE media SET path = ? WHERE id = ?').run(join(dir, 'vanished.mp4'), id);

    const res = await fetch(`${base}/stream/${id}?t=${token}`);
    expect(res.status).toBe(410);
  });

  it('explains why a file needing remux will not play, instead of streaming it', async () => {
    const id = addMedia({ needsRemux: true });
    const res = await fetch(`${base}/stream/${id}?t=${token}`);

    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('needs-remux');
    expect(body.reason).toBe('container');
  });

  /**
   * §23 again. Restricted items must not merely be unlisted — they must not be
   * streamable, including to a client that already knows the id.
   */
  it('refuses to stream a hidden item when restrictions are on', async () => {
    const id = addMedia({ hidden: true });

    expect((await fetch(`${base}/stream/${id}?t=${token}`)).status).toBe(200);

    restrictions.configure(
      { enabled: true, maxAge: 18, allowUnrated: true, blockExplicit: false, pinSet: false, unlockMinutes: 30 },
      null
    );

    expect((await fetch(`${base}/stream/${id}?t=${token}`)).status).toBe(404);
  });

  it('refuses to stream an over-age item when restrictions are on', async () => {
    const id = addMedia({ ageMin: 17 });

    restrictions.configure(
      { enabled: true, maxAge: 13, allowUnrated: true, blockExplicit: false, pinSet: false, unlockMinutes: 30 },
      null
    );

    expect((await fetch(`${base}/stream/${id}?t=${token}`)).status).toBe(404);
  });

  it('mints a new token on restart, invalidating old URLs', async () => {
    const id = addMedia();
    const oldUrl = server.urlFor(id);

    await server.stop();
    const status = await server.start(0);

    const res = await fetch(oldUrl.replace(/:\d+\//, `:${status.port}/`));
    expect(res.status).toBe(401);
  });
});

describe('MediaServer port handling', () => {
  let db: Db;

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  /**
   * AAR-M1 D4: a taken port used to reject and leave playback silently broken,
   * with the reason only in a terminal.
   */
  it('falls back to another port when the configured one is taken, and says so', async () => {
    const first = new MediaServer(() => db);
    const a = await first.start(0);

    const second = new MediaServer(() => db);
    const b = await second.start(a.port);

    expect(b.running).toBe(true);
    expect(b.usedFallbackPort).toBe(true);
    expect(b.port).not.toBe(a.port);
    expect((await fetch(`http://127.0.0.1:${b.port}/health`)).status).toBe(200);

    await first.stop();
    await second.stop();
  });

  it('reports not-running before start', () => {
    const s = new MediaServer(() => db).status();
    expect(s.running).toBe(false);
    expect(s.token).toBeNull();
  });

  it('refuses to mint a URL while stopped', () => {
    expect(() => new MediaServer(() => db).urlFor(1)).toThrow();
  });
});

describe('playback progress', () => {
  let db: Db;

  const add = (durationMs: number | null): number => {
    const info = db
      .prepare(
        `INSERT INTO media (kind, path, file_name, ext, added_at, duration_ms)
         VALUES ('video', ?, 'x.mp4', '.mp4', ?, ?)`
      )
      .run(`/m/${Math.random()}.mp4`, Date.now(), durationMs);
    return Number(info.lastInsertRowid);
  };
  const row = (id: number): { resume_ms: number | null; play_count: number } =>
    db.prepare('SELECT resume_ms, play_count FROM media WHERE id = ?').get(id) as never;

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('stores a mid-file position', async () => {
    const { setProgress } = await import('../src/main/db/repos/media');
    const id = add(100_000);
    setProgress(db, id, 50_000);
    expect(row(id).resume_ms).toBe(50_000);
  });

  /** Just-started and nearly-finished are not "partway through". */
  it('ignores a position in the first 5%', async () => {
    const { setProgress } = await import('../src/main/db/repos/media');
    const id = add(100_000);
    setProgress(db, id, 2_000);
    expect(row(id).resume_ms).toBeNull();
  });

  it('ignores a position in the last 5%', async () => {
    const { setProgress } = await import('../src/main/db/repos/media');
    const id = add(100_000);
    setProgress(db, id, 99_000);
    expect(row(id).resume_ms).toBeNull();
  });

  it('stores a position for a file of unknown duration', async () => {
    const { setProgress } = await import('../src/main/db/repos/media');
    const id = add(null);
    setProgress(db, id, 30_000);
    expect(row(id).resume_ms).toBe(30_000);
  });

  it('clears resume and counts a play when finished', async () => {
    const { setProgress, markFinished } = await import('../src/main/db/repos/media');
    const id = add(100_000);
    setProgress(db, id, 50_000);
    markFinished(db, id);

    const r = row(id);
    expect(r.resume_ms).toBeNull();
    expect(r.play_count).toBe(1);
  });

  it('does nothing for an id that does not exist', async () => {
    const { setProgress } = await import('../src/main/db/repos/media');
    expect(() => setProgress(db, 9999, 1000)).not.toThrow();
  });
});

/**
 * PRA-M1c §5.8/§9 item 11b: the HLS routes carry the same token auth and
 * `mediaClauses()` restriction guard as `/stream/<id>`. A fake spawn writes a
 * playlist immediately rather than waiting on real ffmpeg — these tests are
 * about routing and the restriction guard, which `TranscodeManager` and
 * `plan.ts` already cover against real ffmpeg elsewhere.
 */
describe('MediaServer — HLS (M1c)', () => {
  class FakeProcess extends EventEmitter {
    kill(): boolean {
      this.emit('exit', null);
      return true;
    }
  }

  /** Writes a fake but structurally valid HLS output the instant it is "spawned". */
  const instantSpawn: SpawnFn = (_bin, args) => {
    const playlistPath = args[args.length - 1] ?? '';
    const dir = dirname(playlistPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      playlistPath,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:6.0,\nseg00000.ts\n#EXT-X-ENDLIST\n'
    );
    writeFileSync(join(dir, 'seg00000.ts'), Buffer.from('fake-ts-bytes'));
    return new FakeProcess() as unknown as ChildProcess;
  };

  let db: Db;
  let dir: string;
  let cacheRoot: string;
  let server: MediaServer;
  let base: string;
  let token: string;

  const CONTENT = Buffer.from('x'.repeat(1000));

  const addHlsMedia = (opts: {
    container?: string | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
    hidden?: boolean;
  }): number => {
    const path = join(dir, `media-${Math.random().toString(36).slice(2)}.mkv`);
    writeFileSync(path, CONTENT);
    const info = db
      .prepare(
        `INSERT INTO media (kind, path, file_name, ext, size_bytes, mtime_ms, added_at,
                            container, video_codec, audio_codec, needs_remux, remux_reason, hidden)
         VALUES ('video', ?, 'x.mkv', '.mkv', ?, ?, ?, ?, ?, ?, 1, 'container', ?)`
      )
      .run(
        path,
        CONTENT.length,
        1_000, // fixed mtime — the tests compute the matching fingerprint from this
        Date.now(),
        opts.container ?? 'matroska,webm',
        opts.videoCodec ?? 'h264',
        opts.audioCodec ?? 'vorbis',
        opts.hidden ? 1 : 0
      );
    return Number(info.lastInsertRowid);
  };

  beforeEach(async () => {
    db = freshDb();
    dir = tempDir('que-server-hls-');
    cacheRoot = tempDir('que-server-hls-cache-');
    restrictions.configure(
      { enabled: false, maxAge: 18, allowUnrated: true, blockExplicit: false, pinSet: false, unlockMinutes: 30 },
      null
    );
    const manager = new TranscodeManager({ cacheRoot, budget: new ConcurrencyBudget(4), spawn: instantSpawn });
    server = new MediaServer(() => db, { manager, cacheRoot });
    const status = await server.start(0);
    base = `http://127.0.0.1:${status.port}`;
    token = status.token!;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    cleanup(dir);
    cleanup(cacheRoot);
  });

  /**
   * Found only by actually launching the app and letting hls.js resolve the
   * URL client-side (PRA-M1c's own warning about this milestone, proven
   * true): a path-only `hlsUrl` resolves against the renderer's `file://`
   * page origin, not the media server's `http://127.0.0.1:<port>` origin,
   * and produces a silently broken `file:///hls/...` request. `/stream/<id>`
   * already gets this right via `urlFor()`; `hlsUrl` must match it.
   */
  it('points /stream\'s 415 body at an absolute hlsUrl, not a page-relative path', async () => {
    const id = addHlsMedia({});
    const res = await fetch(`${base}/stream/${id}?t=${token}`);
    expect(res.status).toBe(415);
    const body = (await res.json()) as { hlsUrl: string };
    expect(body.hlsUrl).toBe(`${base}/hls/${id}/playlist.m3u8?t=${token}`);
  });

  it('serves a growing playlist for a file that needs a container remux', async () => {
    const id = addHlsMedia({});
    const res = await fetch(`${base}/hls/${id}/playlist.m3u8?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('mpegurl');
    const body = await res.text();
    expect(body).toContain('#EXTM3U');
    expect(body).toContain('seg00000.ts');
  });

  it('serves the segment the playlist references', async () => {
    const id = addHlsMedia({});
    await fetch(`${base}/hls/${id}/playlist.m3u8?t=${token}`); // starts the job
    const res = await fetch(`${base}/hls/${id}/seg00000.ts?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    expect(await res.text()).toBe('fake-ts-bytes');
  });

  it('redirects to /stream when the file plays directly and needs no HLS work at all', async () => {
    const id = addHlsMedia({ container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264', audioCodec: 'aac' });
    const res = await fetch(`${base}/hls/${id}/playlist.m3u8?t=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`/stream/${id}`);
  });

  it('refuses an HLS request with no token, same as /stream', async () => {
    const id = addHlsMedia({});
    expect((await fetch(`${base}/hls/${id}/playlist.m3u8`)).status).toBe(401);
  });

  it('rejects a segment name that is not ffmpeg\'s own pattern', async () => {
    const id = addHlsMedia({});
    await fetch(`${base}/hls/${id}/playlist.m3u8?t=${token}`);
    const res = await fetch(`${base}/hls/${id}/..%2F..%2Fetc%2Fpasswd?t=${token}`);
    expect(res.status).toBe(400);
  });

  it('404s a segment for a job that was never started', async () => {
    const id = addHlsMedia({});
    const res = await fetch(`${base}/hls/${id}/seg00000.ts?t=${token}`);
    expect(res.status).toBe(404);
  });

  /**
   * R4 — the invariant PRA-M1b §6/§23 established and PRA-M1c §5.8 carries
   * forward: restrictions are enforced in the query layer, never against
   * cached bytes. A warm, already-generated cache must not become a way
   * around it. The cache here is pre-populated directly on disk — the point
   * is that even a *fully generated* job refuses, not just a not-yet-started
   * one.
   */
  it('refuses a hidden row\'s playlist and segments even with a fully warm cache', async () => {
    const id = addHlsMedia({ hidden: true });

    // Warm the cache exactly as a real job would have left it.
    const fp = fingerprint(CONTENT.length, 1_000);
    const dir2 = jobDir(cacheRoot, id, fp, 0);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'playlist.m3u8'), '#EXTM3U\n#EXTINF:6.0,\nseg00000.ts\n#EXT-X-ENDLIST\n');
    writeFileSync(join(dir2, 'seg00000.ts'), Buffer.from('warm-bytes'));

    restrictions.configure(
      { enabled: true, maxAge: 18, allowUnrated: true, blockExplicit: false, pinSet: false, unlockMinutes: 30 },
      null
    );

    expect((await fetch(`${base}/hls/${id}/playlist.m3u8?t=${token}`)).status).toBe(404);
    expect((await fetch(`${base}/hls/${id}/seg00000.ts?t=${token}`)).status).toBe(404);
  });

  it('a seek job lives at its own URL and does not collide with the from-start job', async () => {
    const id = addHlsMedia({});
    await fetch(`${base}/hls/${id}/playlist.m3u8?t=${token}`);
    const seek = await fetch(`${base}/hls/${id}/seek/120/playlist.m3u8?t=${token}`);
    expect(seek.status).toBe(200);

    const seg = await fetch(`${base}/hls/${id}/seek/120/seg00000.ts?t=${token}`);
    expect(seg.status).toBe(200);
  });

  it('sweeps a stale-fingerprint cache directory when a rescan changed the file (§9 item 11f)', async () => {
    const id = addHlsMedia({});

    const staleFp = fingerprint(CONTENT.length - 1, 999); // deliberately not the row's current fingerprint
    const staleDir = jobDir(cacheRoot, id, staleFp, 0);
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'playlist.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');

    await fetch(`${base}/hls/${id}/playlist.m3u8?t=${token}`);

    const { existsSync } = await import('node:fs');
    expect(existsSync(staleDir)).toBe(false);
  });

  it('503s with no transcode pipeline configured, rather than 404ing confusingly', async () => {
    const plainServer = new MediaServer(() => db);
    const status = await plainServer.start(0);
    const id = addHlsMedia({});
    const res = await fetch(`http://127.0.0.1:${status.port}/hls/${id}/playlist.m3u8?t=${status.token}`);
    expect(res.status).toBe(503);
    await plainServer.stop();
  });
});

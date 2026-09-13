import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/main/db/connection';
import { MediaServer, parseRange } from '../src/main/server/server';
import * as restrictions from '../src/main/restrictions';
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

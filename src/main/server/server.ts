import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { Db } from '../db/connection';
import { mediaClauses } from '../restrictions';
import { evictStaleFingerprints, fingerprint, jobDir } from '../transcode/cache';
import type { TranscodeManager } from '../transcode/manager';
import { needsHls, planTranscode } from '../transcode/plan';
import type { ServerStatus } from '@shared/types';

/**
 * Local media server.
 *
 * Playback goes through HTTP rather than the que:// protocol
 * (ASSUMPTIONS.md A2): a real server gives exact Range/206 handling, which a
 * custom protocol streaming fragmented MP4 off a pipe cannot, and it means the
 * app window and (later) other devices on the network use one code path.
 *
 * Two properties hold regardless of who is asking:
 *
 *  - **Every route resolves an integer id against SQLite.** No request supplies
 *    a filesystem path, so there is no traversal surface at all.
 *  - **Restriction clauses apply here too** (§23). A hidden or over-age item is
 *    not streamable, not merely unlisted. A network client is less trusted than
 *    the app window, not more.
 */

/** Defined once, in @shared/types — see AAR-M1 D1. */
export type { ServerStatus };

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Parse a single-range `Range` header against a known size.
 * Returns null for absent or syntactically invalid headers (serve the whole
 * file), and 'unsatisfiable' when the range is well-formed but out of bounds.
 */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart = '', rawEnd = ''] = match;

  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }

  if (start >= size || start < 0) return 'unsatisfiable';
  return { start, end };
}

interface PlayableRow {
  id: number;
  path: string;
  needs_remux: number;
  remux_reason: string | null;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  ext: string;
  size_bytes: number | null;
  mtime_ms: number | null;
}

/** ffmpeg's own `seg%05d.ts` pattern — anything else is not a segment this server wrote. */
const SEGMENT_NAME = /^seg\d+\.ts$/;

const HLS_MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

export class MediaServer {
  private server: Server | null = null;
  private token: string | null = null;
  private port = 0;
  private lanEnabled = false;
  private error: string | null = null;
  private usedFallbackPort = false;

  constructor(
    private readonly db: () => Db,
    private readonly transcode?: { manager: TranscodeManager; cacheRoot: string }
  ) {}

  status(): ServerStatus {
    return {
      running: this.server !== null,
      port: this.port,
      host: this.lanEnabled ? '0.0.0.0' : '127.0.0.1',
      lanEnabled: this.lanEnabled,
      token: this.token,
      error: this.error,
      usedFallbackPort: this.usedFallbackPort,
    };
  }

  /** Stream URL for a media id, including the session token. */
  urlFor(id: number): string {
    if (!this.server || !this.token) throw new Error('Media server is not running');
    return `http://127.0.0.1:${this.port}/stream/${id}?t=${this.token}`;
  }

  /**
   * HLS playlist URL for a media id — absolute, for the same reason
   * `urlFor` is: the renderer's page origin is `file://` (or the dev
   * server's own origin), not the media server's. A path-only string here
   * resolves client-side against the WRONG base and produces a `file://`
   * request that 404s with no useful signal (found only by actually running
   * it — PRA-M1c's own warning about this milestone, proven true).
   */
  hlsUrlFor(id: number): string {
    if (!this.server || !this.token) throw new Error('Media server is not running');
    return `http://127.0.0.1:${this.port}/hls/${id}/playlist.m3u8?t=${this.token}`;
  }

  /**
   * Start listening.
   *
   * AAR-M1 D4: a taken port used to reject, get logged to a terminal nobody is
   * reading, and leave playback silently broken. The configured port is a
   * preference, not a requirement — if it is in use, fall back to one the OS
   * picks and say so in the status, which the UI shows.
   */
  async start(port: number, lanEnabled = false): Promise<ServerStatus> {
    if (this.server) return this.status();

    // A fresh token per run: a URL from a previous session is dead on arrival.
    this.token = randomBytes(24).toString('base64url');
    this.lanEnabled = lanEnabled;
    this.error = null;
    this.usedFallbackPort = false;

    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        console.error('[server] handler error', e);
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal error');
      });
    });

    // Never leak a socket that connects and says nothing.
    server.headersTimeout = 10_000;
    server.requestTimeout = 0; // a long download is not a stalled request

    const host = lanEnabled ? '0.0.0.0' : '127.0.0.1';

    const listen = (p: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onError = (e: Error): void => reject(e);
        server.once('error', onError);
        server.listen(p, host, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });

    try {
      await listen(port);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || port === 0) {
        this.error = e instanceof Error ? e.message : String(e);
        this.token = null;
        throw e;
      }
      // Port 0 asks the OS for any free port.
      await listen(0);
      this.usedFallbackPort = true;
    }

    const address = server.address();
    this.port = typeof address === 'object' && address !== null ? address.port : port;
    this.server = server;
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.token = null;
    this.usedFallbackPort = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authorised(url: URL, req: IncomingMessage): boolean {
    if (!this.token) return false;
    const supplied = url.searchParams.get('t') ?? req.headers['x-que-token'];
    return typeof supplied === 'string' && supplied === this.token;
  }

  /** Resolve an id to a playable file, applying restriction clauses (§23). */
  private resolve(id: number): PlayableRow | null {
    const clauses = mediaClauses();
    const guard = clauses.map((c) => ` AND (${c.sql})`).join('');
    const row = this.db()
      .prepare(
        `SELECT m.id, m.path, m.needs_remux, m.remux_reason, m.container,
                m.video_codec, m.audio_codec, m.ext, m.size_bytes, m.mtime_ms
           FROM media m
          WHERE m.id = ? AND m.missing = 0${guard}`
      )
      .get(id, ...clauses.flatMap((c) => c.params)) as PlayableRow | undefined;
    return row ?? null;
  }

  /**
   * `/hls/<id>/playlist.m3u8` (or `/hls/<id>/seek/<n>/playlist.m3u8`) —
   * starts, joins, or reuses on disk a progressive HLS generation job, and
   * serves whatever the file currently contains. hls.js polls this until it
   * sees `#EXT-X-ENDLIST` (§5.2) — no separate readiness signal exists or is
   * needed.
   */
  private async handleHlsPlaylist(id: number, startSeconds: number, res: ServerResponse): Promise<void> {
    if (!this.transcode) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Transcoding is not configured on this server');
      return;
    }

    const row = this.resolve(id);
    if (!row) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (!existsSync(row.path)) {
      res.writeHead(410, { 'Content-Type': 'text/plain' });
      res.end('The file is no longer at its recorded location');
      return;
    }

    const plan = planTranscode(row.container, row.video_codec, row.audio_codec, row.ext);
    if (!needsHls(plan)) {
      // Asked for HLS on a file that plays directly — serve it the normal
      // way rather than spawning ffmpeg for nothing.
      res.writeHead(302, { Location: `/stream/${String(id)}?t=${this.token ?? ''}` });
      res.end();
      return;
    }

    const fp = fingerprint(row.size_bytes ?? 0, row.mtime_ms ?? 0);
    // A rescan that replaced or re-encoded this file changes its fingerprint;
    // sweep any cache left under the old one before (re)using the current
    // one (§9 item 11f). Cheap — a readdir plus string comparisons — and
    // correctness-critical only here, at the moment playback is next asked
    // for this file.
    evictStaleFingerprints(this.transcode.cacheRoot, id, fp);
    const job = this.transcode.manager.getOrStart({
      mediaId: id,
      fingerprint: fp,
      inputPath: row.path,
      plan,
      startSeconds: startSeconds > 0 ? startSeconds : undefined,
    });
    this.transcode.manager.touch(job.key);

    if (!existsSync(job.playlistPath)) {
      // ffmpeg has not written its first playlist revision yet — a few ms at
      // most for a copy-only job (PRA-M1c §3 M-1). The caller retries.
      res.writeHead(503, { 'Retry-After': '1' });
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': HLS_MIME['.m3u8'], 'Cache-Control': 'no-store' });
    res.end(readFileSync(job.playlistPath, 'utf8'));
  }

  /**
   * `/hls/<id>/segments/<name>` (or the `/seek/<n>/` variant) — a completed
   * `.ts` chunk, served whole. Same restriction guard as everything else: a
   * hidden or over-age row's segments refuse even once they are sitting on
   * disk (§23; PRA-M1c R4) — a warm cache must never become a way around it.
   */
  private handleHlsSegment(id: number, startSeconds: number, name: string, res: ServerResponse): void {
    if (!this.transcode) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Transcoding is not configured on this server');
      return;
    }

    if (!SEGMENT_NAME.test(name)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid segment name');
      return;
    }

    const row = this.resolve(id);
    if (!row) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const plan = planTranscode(row.container, row.video_codec, row.audio_codec, row.ext);
    if (!needsHls(plan)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const fp = fingerprint(row.size_bytes ?? 0, row.mtime_ms ?? 0);
    const dir = jobDir(this.transcode.cacheRoot, id, fp, startSeconds);
    const segmentPath = join(dir, name);

    if (!existsSync(segmentPath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    this.transcode.manager.touch(this.transcode.manager.keyFor(id, fp, startSeconds));
    res.writeHead(200, { 'Content-Type': HLS_MIME['.ts'], 'Cache-Control': 'no-store' });
    createReadStream(segmentPath).pipe(res);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!this.authorised(url, req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorised');
      return;
    }

    /**
     * The playlist and its segments must live in the same URL *directory* —
     * found only by actually running this against real hls.js (PRA-M1c's
     * own warning about this milestone, proven true twice in one session).
     * ffmpeg writes bare segment filenames into the playlist (`seg00000.ts`,
     * no path prefix, because the segments sit next to the playlist on
     * disk), and hls.js resolves those relative to the playlist's URL,
     * dropping the last path element. An earlier `/hls/<id>/segments/<name>`
     * route therefore never matched anything ffmpeg actually referenced — a
     * `/hls/<id>/segments/playlist.m3u8` URL would have worked too, but one
     * flat directory per job is simpler than keeping the segment sub-path in
     * sync with wherever the playlist happens to live.
     */
    const hlsMatch = /^\/hls\/(\d+)\/([^/]+)$/.exec(url.pathname);
    if (hlsMatch) {
      const id = Number(hlsMatch[1]);
      const name = hlsMatch[2] ?? '';
      if (name === 'playlist.m3u8') await this.handleHlsPlaylist(id, 0, res);
      else this.handleHlsSegment(id, 0, name, res);
      return;
    }

    const hlsSeekMatch = /^\/hls\/(\d+)\/seek\/(\d+)\/([^/]+)$/.exec(url.pathname);
    if (hlsSeekMatch) {
      const id = Number(hlsSeekMatch[1]);
      const startSeconds = Number(hlsSeekMatch[2]);
      const name = hlsSeekMatch[3] ?? '';
      if (name === 'playlist.m3u8') await this.handleHlsPlaylist(id, startSeconds, res);
      else this.handleHlsSegment(id, startSeconds, name, res);
      return;
    }

    const streamMatch = /^\/stream\/(\d+)$/.exec(url.pathname);
    if (!streamMatch) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const id = Number(streamMatch[1]);
    const row = this.resolve(id);

    if (!row) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (!existsSync(row.path)) {
      res.writeHead(410, { 'Content-Type': 'text/plain' });
      res.end('The file is no longer at its recorded location');
      return;
    }

    /**
     * Direct playback only serves files Chromium can demux and decode as-is.
     * Anything else goes through the HLS pipeline (M1c) — point the caller at
     * it rather than a bare error, since that endpoint is the one that
     * actually works for this file.
     */
    if (row.needs_remux === 1) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'needs-remux',
          reason: row.remux_reason,
          hlsUrl: this.transcode ? this.hlsUrlFor(id) : null,
          message: this.transcode
            ? 'This file needs remuxing or transcoding before it can play directly — use hlsUrl instead.'
            : 'This file needs remuxing or transcoding before it can play, and the transcode pipeline is not configured on this server.',
        })
      );
      return;
    }

    const size = statSync(row.path).size;
    const range = parseRange(req.headers.range, size);

    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType(row.path),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    if (range === null) {
      headers['Content-Length'] = String(size);
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(row.path).pipe(res);
      return;
    }

    headers['Content-Length'] = String(range.end - range.start + 1);
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(row.path, { start: range.start, end: range.end }).pipe(res);
  }
}

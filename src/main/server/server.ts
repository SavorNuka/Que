import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { Db } from '../db/connection';
import { mediaClauses } from '../restrictions';
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
}

export class MediaServer {
  private server: Server | null = null;
  private token: string | null = null;
  private port = 0;
  private lanEnabled = false;
  private error: string | null = null;
  private usedFallbackPort = false;

  constructor(private readonly db: () => Db) {}

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
        `SELECT m.id, m.path, m.needs_remux, m.remux_reason
           FROM media m
          WHERE m.id = ? AND m.missing = 0${guard}`
      )
      .get(id, ...clauses.flatMap((c) => c.params)) as PlayableRow | undefined;
    return row ?? null;
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
     * M1 catalogues files needing remux but does not transcode them (that is
     * M1b). Say so precisely rather than streaming bytes the browser will
     * silently fail to decode.
     */
    if (row.needs_remux === 1) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'needs-remux',
          reason: row.remux_reason,
          message:
            row.remux_reason === 'container'
              ? 'This container needs remuxing before it can play. Transcoding arrives in M1b.'
              : `This file's ${row.remux_reason === 'video-codec' ? 'video' : 'audio'} codec needs transcoding. That arrives in M1b.`,
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

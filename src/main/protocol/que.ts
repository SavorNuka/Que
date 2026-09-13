import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { app, protocol } from 'electron';
import { getDatabase } from '../db/connection';

/**
 * que:// — artwork, subtitles and skin assets only.
 *
 * ASSUMPTIONS.md A2/A6: playback does NOT go through this protocol. Media is
 * served by the local HTTP server on 127.0.0.1 (M1), which gives real Range
 * handling and lets the LAN server and the local player share one code path.
 * What is left here is small, no-Range content — exactly what a custom
 * protocol is good at.
 *
 * Everything is addressed by database id or by a path resolved *inside* a
 * known cache root. No renderer-supplied filesystem path ever reaches fs.
 */

export const QUE_SCHEME = 'que';

/**
 * MUST run before app.whenReady().
 *
 * ASSUMPTIONS.md A3: Electron's docs are explicit that <video>/<audio> buffer
 * whole responses unless the scheme declares stream:true. We keep the flag even
 * though media moved to HTTP, because subtitle tracks are fetched the same way.
 */
export function registerQueScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: QUE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** Reject anything that escapes `root` after resolution (../, symlink-ish, absolute). */
function safeJoin(root: string, candidate: string): string | null {
  const target = resolve(join(root, candidate));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

function fileResponse(path: string, status = 200): Response {
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status,
    headers: { 'Content-Type': type, 'Content-Length': String(statSync(path).size) },
  });
}

const notFound = (): Response => new Response('Not found', { status: 404 });
const badRequest = (): Response => new Response('Bad request', { status: 400 });

export function registerQueProtocol(): void {
  const userData = app.getPath('userData');
  const artworkRoot = join(userData, 'artwork');
  const subtitleRoot = join(userData, 'subtitles');
  const skinRoot = join(userData, 'skins');

  protocol.handle(QUE_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return badRequest();
    }

    // que://art/<mediaId>  |  que://art/group/<groupId>
    // que://sub/<mediaId>/<lang>
    // que://skin/<skinId>/<relative path>
    const host = url.hostname;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    try {
      if (host === 'art') {
        const db = getDatabase();
        if (parts[0] === 'group') {
          const id = Number(parts[1]);
          if (!Number.isInteger(id)) return badRequest();
          const row = db.prepare('SELECT screen FROM groups WHERE id = ?').get(id) as
            | { screen: string | null }
            | undefined;
          if (!row?.screen) return notFound();
          const hero = (JSON.parse(row.screen) as { hero?: { image?: string } }).hero?.image;
          if (!hero) return notFound();
          const p = safeJoin(artworkRoot, hero);
          return p && existsSync(p) ? fileResponse(p) : notFound();
        }
        const id = Number(parts[0]);
        if (!Number.isInteger(id)) return badRequest();
        const row = db.prepare('SELECT thumb_path FROM media WHERE id = ?').get(id) as
          | { thumb_path: string | null }
          | undefined;
        if (!row?.thumb_path) return notFound();
        const p = safeJoin(artworkRoot, row.thumb_path);
        return p && existsSync(p) ? fileResponse(p) : notFound();
      }

      if (host === 'sub') {
        const db = getDatabase();
        const id = Number(parts[0]);
        const lang = parts[1];
        if (!Number.isInteger(id) || !lang) return badRequest();
        const row = db
          .prepare(
            'SELECT file_path FROM subtitle_cache WHERE media_id = ? AND language = ? LIMIT 1'
          )
          .get(id, lang) as { file_path: string } | undefined;
        if (!row) return notFound();
        const p = safeJoin(subtitleRoot, row.file_path);
        return p && existsSync(p) ? fileResponse(p) : notFound();
      }

      if (host === 'skin') {
        const skinId = parts[0];
        const rest = parts.slice(1).join('/');
        if (!skinId || !rest) return badRequest();
        const withinSkin = safeJoin(skinRoot, skinId);
        if (!withinSkin) return badRequest();
        const p = safeJoin(withinSkin, rest);
        return p && existsSync(p) ? fileResponse(p) : notFound();
      }
    } catch (e) {
      console.error('[que://] handler error', e);
      return new Response('Internal error', { status: 500 });
    }

    return notFound();
  });
}

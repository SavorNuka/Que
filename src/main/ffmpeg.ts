import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Locating the bundled ffmpeg sidecar (ARCHITECTURE §2.1).
 *
 * In development the binaries live in resources/bin/; in a packaged app
 * electron-builder copies them next to the app under process.resourcesPath.
 */

const EXE = process.platform === 'win32' ? '.exe' : '';

function candidates(name: string): string[] {
  return [
    join(process.resourcesPath ?? '', 'bin', `${name}${EXE}`),
    join(app.getAppPath(), 'resources', 'bin', `${name}${EXE}`),
    join(process.cwd(), 'resources', 'bin', `${name}${EXE}`),
  ];
}

function find(name: string): string | null {
  for (const c of candidates(name)) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

export function ffmpegPath(): string | null {
  return find('ffmpeg');
}

export function ffprobePath(): string | null {
  return find('ffprobe');
}

export function ffmpegAvailable(): boolean {
  return ffmpegPath() !== null && ffprobePath() !== null;
}

/**
 * ffmpeg is always invoked with execFile and an argument array — never a
 * shell string (ARCHITECTURE §17).
 */
export function requireFfmpeg(): string {
  const p = ffmpegPath();
  if (!p) {
    throw new Error(
      'ffmpeg is not available. Run "npm run fetch:ffmpeg" to download it into resources/bin.'
    );
  }
  return p;
}

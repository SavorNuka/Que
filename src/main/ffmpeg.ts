import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locating the bundled ffmpeg sidecar (ARCHITECTURE §2.1).
 *
 * Search roots are injected by the Electron-aware entry point rather than
 * resolved in here. The previous version called `app.getAppPath()` eagerly
 * while building its candidate list, which throws outside a running Electron
 * app — the reason `probeFile` could not be imported by the benchmark or a
 * plain Node test, and had to be reimplemented instead (AAR-M1b D6). This
 * module now has no dependency on `electron` at all, so `probeFile` and the
 * M1c transcode spawn share one fixture-driven test suite (PRA-M1c §5.9).
 */

const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * Default matches the old third candidate: `<cwd>/resources/bin`. That is
 * what makes dev, the benchmark and tests work without any setup — the
 * packaged-app roots are supplied explicitly by `src/main/index.ts` at
 * startup, before any probe or transcode call.
 */
let searchRoots: string[] = [join(process.cwd(), 'resources', 'bin')];

export function setFfmpegSearchRoots(roots: string[]): void {
  searchRoots = roots;
}

function candidates(name: string): string[] {
  return searchRoots.map((root) => join(root, `${name}${EXE}`));
}

function find(name: string): string | null {
  for (const c of candidates(name)) {
    if (existsSync(c)) return c;
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
 * ffmpeg is always invoked with execFile/spawn and an argument array — never
 * a shell string (ARCHITECTURE §17).
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

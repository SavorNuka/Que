import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Real media files for tests that need them.
 *
 * ffprobe's answers depend on actual container and codec bytes, so fixtures
 * would be testing a mock rather than the thing. Where ffmpeg is unavailable
 * (CI runs with --ignore-scripts and no sidecar), the affected tests skip
 * rather than fail.
 */

let ffmpegChecked = false;
let ffmpegFound = false;

export function hasFfmpeg(): boolean {
  if (ffmpegChecked) return ffmpegFound;
  ffmpegChecked = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    ffmpegFound = true;
  } catch {
    ffmpegFound = false;
  }
  return ffmpegFound;
}

export function tempDir(prefix = 'que-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A one-second H.264/AAC MP4 — the "plays directly" case. */
export function makeMp4(dir: string, name = 'sample.mp4'): string {
  const out = join(dir, name);
  execFileSync(
    'ffmpeg',
    ['-y', '-v', 'error',
     '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out],
    { stdio: 'ignore' }
  );
  return out;
}

/** The same streams in a Matroska container — the "needs remux" case. */
export function makeMkv(dir: string, name = 'sample.mkv'): string {
  const out = join(dir, name);
  execFileSync(
    'ffmpeg',
    ['-y', '-v', 'error',
     '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out],
    { stdio: 'ignore' }
  );
  return out;
}

/** A one-second MP3 — the audio case. */
export function makeMp3(dir: string, name = 'track.mp3'): string {
  const out = join(dir, name);
  execFileSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', out],
    { stdio: 'ignore' }
  );
  return out;
}

/** Not media, just bytes with a media extension — used for hash and walk tests. */
export function makeFakeMedia(dir: string, name: string, sizeBytes = 4096, fill = 'a'): string {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  writeFileSync(out, Buffer.alloc(sizeBytes, fill));
  return out;
}

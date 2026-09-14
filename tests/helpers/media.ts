import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegPath, ffprobePath } from '../../src/main/ffmpeg';

/**
 * Real media files for tests that need them.
 *
 * ffprobe's answers depend on actual container and codec bytes, so fixtures
 * would be testing a mock rather than the thing. Where ffmpeg is unavailable
 * (CI runs with --ignore-scripts and no sidecar), the affected tests skip
 * rather than fail.
 *
 * Resolved through `ffmpeg.ts`'s own binary lookup (bundled `resources/bin`
 * first, PATH never) rather than a bare `execFileSync('ffmpeg', …)`. A PATH
 * lookup is exactly the gap the handoff flagged: neither binary is on PATH on
 * the Windows machine these tests actually need to run on, only bundled —
 * so these tests silently skipped there until this fix (PRA-M1c §5.9).
 */

let ffmpegChecked = false;
let resolvedFfmpeg: string | null = null;
let resolvedFfprobe: string | null = null;

function resolve(): void {
  if (ffmpegChecked) return;
  ffmpegChecked = true;
  const mpeg = ffmpegPath();
  const probe = ffprobePath();
  try {
    if (mpeg) execFileSync(mpeg, ['-version'], { stdio: 'ignore' });
    if (probe) execFileSync(probe, ['-version'], { stdio: 'ignore' });
    resolvedFfmpeg = mpeg;
    resolvedFfprobe = probe;
  } catch {
    resolvedFfmpeg = null;
    resolvedFfprobe = null;
  }
}

export function hasFfmpeg(): boolean {
  resolve();
  return resolvedFfmpeg !== null && resolvedFfprobe !== null;
}

/** The bundled ffmpeg binary path — call only after `hasFfmpeg()` is true. */
export function ffmpegBin(): string {
  resolve();
  if (!resolvedFfmpeg) throw new Error('ffmpeg is not available; guard with hasFfmpeg()');
  return resolvedFfmpeg;
}

/** The bundled ffprobe binary path — call only after `hasFfmpeg()` is true. */
export function ffprobeBin(): string {
  resolve();
  if (!resolvedFfprobe) throw new Error('ffprobe is not available; guard with hasFfmpeg()');
  return resolvedFfprobe;
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
    ffmpegBin(),
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
    ffmpegBin(),
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
    ffmpegBin(),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', out],
    { stdio: 'ignore' }
  );
  return out;
}

/**
 * MKV, H.264 video + AC-3 audio — ARCHITECTURE §2.1's named common real case.
 * Needs a container remux AND an audio transcode at once (PRA-M1c §4 C1) —
 * the fixture the per-stream planner test guards against regressing to the
 * single-`remux_reason` shortcut (R7).
 */
export function makeAc3Mkv(dir: string, name = 'ac3.mkv'): string {
  const out = join(dir, name);
  execFileSync(
    ffmpegBin(),
    ['-y', '-v', 'error',
     '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-shortest', out],
    { stdio: 'ignore' }
  );
  return out;
}

/**
 * MKV, HEVC video + AAC audio — the video-codec transcode case. No real
 * sample exists in any library available to this project (PRA-M1c §3 M-4);
 * this is a labelled-synthetic stand-in, not a substitute for one (PRA-M1c
 * §8/§10 falsification 1).
 */
export function makeHevcMkv(dir: string, name = 'hevc.mkv'): string {
  const out = join(dir, name);
  execFileSync(
    ffmpegBin(),
    ['-y', '-v', 'error',
     '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
     '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out],
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

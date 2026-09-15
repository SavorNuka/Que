import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireFfmpeg } from '../../src/main/ffmpeg';
import { cleanup, hasFfmpeg, tempDir } from '../helpers/media';

/**
 * PRA-M1c §9 item 11h / OPEN-ACTIONS #12.
 *
 * The server trusts a specific guarantee about ffmpeg's own HLS muxer: a
 * segment file is fully closed *before* its name is appended to the
 * playlist, so serving whatever the playlist currently contains (§5.2) can
 * never hand a client a still-being-written `.ts` file. AAR-M1c recorded
 * this as "not independently tested" — real ffmpeg output was observed
 * behaving correctly during the manual end-to-end run, but nothing forced
 * the actual race (reading a segment the instant it appears in the
 * playlist, while ffmpeg might still be flushing it).
 *
 * This test forces that race. `-re` on the input paces generation at
 * real time, so segments appear roughly every `hls_time` seconds rather
 * than all at once (a stream copy alone would produce the whole file in
 * milliseconds — see PRA-M1c §3 M-1 — far too fast to poll meaningfully).
 * A tight poll loop watches the playlist grow and, the instant a segment
 * name is first seen, checks whether that segment's file size is still
 * changing. If it is, the guarantee this server relies on does not hold.
 */
describe('HLS playlist readiness', () => {
  let mediaDir: string;
  let outDir: string;
  let proc: ChildProcess | null = null;

  beforeEach(() => {
    mediaDir = tempDir('que-readiness-media-');
    outDir = tempDir('que-readiness-out-');
  });

  afterEach(() => {
    proc?.kill();
    cleanup(mediaDir);
    cleanup(outDir);
  });

  it.runIf(hasFfmpeg())(
    'a segment is never listed in the playlist while its file is still being written',
    async () => {
      const playlistPath = join(outDir, 'playlist.m3u8');
      const segmentPattern = join(outDir, 'seg%05d.ts');

      proc = spawn(
        requireFfmpeg(),
        [
          '-y', '-v', 'error',
          '-re',
          '-f', 'lavfi', '-i', 'testsrc=duration=18:size=320x240:rate=24',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-force_key_frames', 'expr:gte(t,n_forced*3)',
          '-c:a', 'aac',
          '-f', 'hls',
          '-hls_time', '3',
          '-hls_playlist_type', 'event',
          '-hls_segment_filename', segmentPattern,
          playlistPath,
        ],
        { windowsHide: true }
      );

      const seen = new Set<string>();
      const violations: string[] = [];

      const scanOnce = async (): Promise<void> => {
        if (!existsSync(playlistPath)) return;
        const body = readFileSync(playlistPath, 'utf8');
        const names = [...body.matchAll(/^(seg\d+\.ts)$/gm)].map((m) => m[1]!);

        for (const name of names) {
          if (seen.has(name)) continue;
          seen.add(name);

          const segPath = join(outDir, name);
          if (!existsSync(segPath)) {
            violations.push(`${name}: listed in the playlist but its file does not exist yet`);
            continue;
          }

          const sizeAtFirstSight = statSync(segPath).size;
          await new Promise((r) => setTimeout(r, 40));
          const sizeAfter = existsSync(segPath) ? statSync(segPath).size : -1;

          if (sizeAfter !== sizeAtFirstSight) {
            violations.push(
              `${name}: size changed from ${String(sizeAtFirstSight)} to ${String(sizeAfter)} bytes after being listed — ffmpeg was still writing it`
            );
          }
        }
      };

      let polling = true;
      const poll = (async (): Promise<void> => {
        while (polling) {
          await scanOnce();
          await new Promise((r) => setTimeout(r, 15));
        }
      })();

      await new Promise<void>((resolve, reject) => {
        proc?.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${String(code)}`))));
        proc?.once('error', reject);
      });
      polling = false;
      await poll;
      // ffmpeg has exited and its playlist is fully flushed, but the poll
      // loop's last iteration may have run just before that — one more scan
      // catches whatever appeared in that final window rather than
      // undercounting segments the safety check never got to examine.
      await scanOnce();

      // A degenerate run (e.g. ffmpeg finishing instantly) would pass
      // vacuously with too few segments observed to mean anything — guard
      // against that without over-fitting to an exact count under real
      // timing variance (18s of source / 3s segments = 6, forced by
      // -force_key_frames; see plan.ts).
      expect(seen.size).toBeGreaterThanOrEqual(5);
      expect(violations).toEqual([]);
    },
    40_000
  );
});

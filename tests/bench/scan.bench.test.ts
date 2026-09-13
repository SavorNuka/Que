import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/main/db/connection';
import { interpretProbe, type ProbeResult } from '../../src/main/library/probe';
import { scanSource } from '../../src/main/library/scanner';
import { freshDb } from '../helpers/db';

/**
 * Cold-scan benchmark — the M1b exit criterion (M1b-SCOPE).
 *
 * AAR-M1 D3 measured a serial cold scan at 43.5 ms/file, 98% of it ffprobe
 * wait, projecting ~14.5 minutes for 20,000 files. PRA-M1b predicted 2–3
 * minutes with a pool.
 *
 * What this measured (AAR-M1b): the speed-up saturates at the machine's core
 * count and does not improve past it, so **ffprobe is CPU-bound, not
 * I/O-bound** — each probe is a subprocess burning a core, not a request
 * waiting on a disk. The pool is still the right mechanism, but its ceiling is
 * the hardware, which is why `defaultProbeConcurrency()` tracks
 * `availableParallelism()` and why raising it further buys nothing.
 *
 * Skipped by default — it generates real media and takes tens of seconds.
 *
 *     npm run bench
 *
 * Real media rather than fixtures, deliberately: AAR-M1 §7 records that
 * generating actual MKV and MP4 files is what found the Matroska behaviour a
 * JSON fixture would have hidden. The same applies to probe timing.
 */

const run = promisify(execFile);
const ENABLED = process.env.QUE_BENCH === '1';
const FILES = Number(process.env.QUE_BENCH_FILES ?? 240);
const SIZES = (process.env.QUE_BENCH_SIZES ?? '1,2,4,8,16').split(',').map(Number);
const DIR = join(tmpdir(), 'que-bench-media');

function ffmpegBin(name: string): string {
  const local = join(process.cwd(), 'resources', 'bin', name);
  return existsSync(local) ? local : name;
}

async function generate(): Promise<void> {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });

  // One real encode, then copies — the probe cost is identical for a copy and
  // this keeps setup from dominating the run.
  const seed = join(DIR, 'seed.mp4');
  await run(ffmpegBin('ffmpeg'), [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-shortest', seed,
  ]);

  for (let i = 0; i < FILES; i++) {
    const folder = join(DIR, `folder-${String(Math.floor(i / 25))}`);
    mkdirSync(folder, { recursive: true });
    copyFileSync(seed, join(folder, `title-${String(i)}.mp4`));
  }
  rmSync(seed);
}

/**
 * A real ffprobe subprocess and the real parser, wired directly.
 *
 * `probeFile` resolves its binary through `src/main/ffmpeg.ts`, which reads
 * `app.getAppPath()` and so cannot run outside Electron. That is why M1's probe
 * tests exercise `interpretProbe` with a stub. The cost being measured here is
 * the subprocess plus the parse, and both are the real ones.
 */
async function probe(path: string, ext: string): Promise<ProbeResult> {
  const { stdout } = await run(
    ffmpegBin('ffprobe'),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  return interpretProbe(JSON.parse(stdout) as Parameters<typeof interpretProbe>[0], ext);
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const minutes = (msPerFile: number, files: number): string =>
  `${((msPerFile * files) / 60_000).toFixed(1)} min`;

describe.skipIf(!ENABLED)('cold scan — pool size', () => {
  it(
    'measures the speed-up the pool actually delivers',
    async () => {
      await generate();

      const rows: { size: number; elapsed: number; perFile: number }[] = [];

      for (const size of SIZES) {
        const db: Db = freshDb();
        db.prepare(`INSERT INTO sources (kind, path, enabled) VALUES ('video', ?, 1)`).run(DIR);

        const started = Date.now();
        const result = await scanSource(db, { id: 1, kind: 'video', path: DIR }, { concurrency: size, probe });
        const elapsed = Date.now() - started;

        expect(result.scanned).toBe(FILES);
        expect(result.failed).toBe(0);

        rows.push({ size, elapsed, perFile: elapsed / FILES });
        db.close();
      }

      // The floor: everything except the probe. AAR-M1 D3 put our own code at
      // 2% of a cold scan; this is the measurement that says whether the pool
      // is chasing the remaining 98% or hitting our own bookkeeping.
      const floorDb: Db = freshDb();
      floorDb.prepare(`INSERT INTO sources (kind, path, enabled) VALUES ('video', ?, 1)`).run(DIR);
      const floorStarted = Date.now();
      await scanSource(
        floorDb,
        { id: 1, kind: 'video', path: DIR },
        {
          concurrency: 8,
          probe: () =>
            Promise.resolve({
              durationMs: 2000, container: 'mov,mp4,m4a,3gp,3g2,mj2',
              videoCodec: 'h264', audioCodec: 'aac', width: 320, height: 240,
              needsRemux: false, remuxReason: null, tags: {},
            }),
        }
      );
      const floor = Date.now() - floorStarted;
      floorDb.close();

      const serial = rows[0]!;
      const best = rows.reduce((a, b) => (b.elapsed < a.elapsed ? b : a));
      const cores = availableParallelism();
      const ceiling = Math.min(cores, Math.max(...SIZES));

      const lines = [
        '',
        `cold scan of ${String(FILES)} real files, fresh database each run`,
        '',
        `  ${pad('pool', 8)}${pad('total', 12)}${pad('per file', 12)}${pad('speed-up', 11)}20k projection`,
        ...rows.map(
          (r) =>
            `  ${pad(r.size, 8)}${pad(`${String(r.elapsed)} ms`, 12)}${pad(`${r.perFile.toFixed(2)} ms`, 12)}` +
            `${pad(`${(serial.elapsed / r.elapsed).toFixed(2)}×`, 11)}${minutes(r.perFile, 20_000)}`
        ),
        `  ${pad('stub', 8)}${pad(`${String(floor)} ms`, 12)}${pad(`${(floor / FILES).toFixed(2)} ms`, 12)}${pad('—', 11)}${minutes(floor / FILES, 20_000)}`,
        '',
        `  best: pool ${String(best.size)} at ${(serial.elapsed / best.elapsed).toFixed(2)}× serial`,
        `  cores: ${String(cores)}, so the ceiling for CPU-bound probing is ~${String(ceiling)}×`,
        `  scanner's own share at best pool: ${((floor / best.elapsed) * 100).toFixed(0)}%`,
        `  AAR-M1 D3 baseline: 43.50 ms/file serial -> ${minutes(43.5, 20_000)} at 20k files`,
        '',
      ];
      console.log(lines.join('\n'));

      rmSync(DIR, { recursive: true, force: true });

      /**
       * PRA-M1b §12 falsification 1 set the bar at a flat 2×, written on the
       * assumption that ffprobe is I/O-bound and the pool depth is what limits
       * it. The measurement says otherwise: speed-up saturates at the core
       * count and does not move after that, so ffprobe is CPU-bound and the
       * ceiling is the machine, not the pool. A flat threshold would therefore
       * fail on a 2-core box that is achieving everything available to it, and
       * pass on a 16-core box delivering a quarter of what it could.
       *
       * The bar is now "most of what the hardware allows".
       */
      expect(serial.elapsed / best.elapsed).toBeGreaterThan(ceiling * 0.75);
    },
    10 * 60 * 1000
  );
});

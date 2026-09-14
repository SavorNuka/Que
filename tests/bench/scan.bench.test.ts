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

/**
 * Point the benchmark at a real library instead of generated clips.
 *
 * Better evidence than synthetic media: real files vary in container, codec,
 * duration and size, and probe cost varies with all four. It also needs only
 * ffprobe, not ffmpeg — nothing is generated. Read-only; the scan never writes
 * to the media folder, only to a throwaway in-memory database.
 */
const REAL_DIR = process.env.QUE_BENCH_DIR?.trim() || null;
const GENERATED_DIR = join(tmpdir(), 'que-bench-media');
const DIR = REAL_DIR ?? GENERATED_DIR;

/**
 * Que bundles its own ffmpeg into resources/bin (`npm run fetch:ffmpeg`).
 * The `.exe` suffix is not optional on Windows: without it `existsSync` misses
 * the bundled binary and this silently falls back to whatever `ffmpeg` happens
 * to be on PATH — which, on a machine relying on the bundled copy, is nothing.
 */
function ffmpegBin(name: string): string {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const local = join(process.cwd(), 'resources', 'bin', `${name}${exe}`);
  return existsSync(local) ? local : name;
}

async function generate(): Promise<void> {
  if (REAL_DIR) {
    if (!existsSync(REAL_DIR)) throw new Error(`QUE_BENCH_DIR does not exist: ${REAL_DIR}`);
    return; // Someone else's files. Nothing to create, and nothing to delete.
  }

  rmSync(GENERATED_DIR, { recursive: true, force: true });
  mkdirSync(GENERATED_DIR, { recursive: true });

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
      // With a real library the count is discovered, not chosen.
      let fileCount = REAL_DIR ? 0 : FILES;

      for (const size of SIZES) {
        const db: Db = freshDb();
        db.prepare(`INSERT INTO sources (kind, path, enabled) VALUES ('video', ?, 1)`).run(DIR);

        const started = Date.now();
        const result = await scanSource(db, { id: 1, kind: 'video', path: DIR }, { concurrency: size, probe });
        const elapsed = Date.now() - started;

        if (fileCount === 0) fileCount = result.scanned;
        expect(result.scanned).toBe(fileCount);
        expect(fileCount).toBeGreaterThan(0);
        // A real library legitimately contains files ffprobe cannot read.
        if (!REAL_DIR) expect(result.failed).toBe(0);

        rows.push({ size, elapsed, perFile: elapsed / fileCount });
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
      const achieved = serial.elapsed / best.elapsed;

      /**
       * Amdahl's law, using the stub run as the serial fraction.
       *
       * Stage A — walk, quick-hash, row insert, FTS reindex — is deliberately
       * serial, and the stub run measures exactly that. So the most any pool
       * can deliver is bounded before the core count is even considered, and
       * comparing achieved against this says *which* limit is binding:
       * near the prediction means stage A; well under it means the probes
       * themselves are contending on something (disk queue, or process
       * creation, which is far more expensive on Windows than on Linux).
       */
      const serialFraction = floor / serial.elapsed;
      const amdahl = (n: number): number => 1 / (serialFraction + (1 - serialFraction) / n);
      const predicted = amdahl(best.size);

      const lines = [
        '',
        REAL_DIR
          ? `cold scan of ${String(fileCount)} files in ${REAL_DIR}, fresh database each run`
          : `cold scan of ${String(fileCount)} generated files, fresh database each run`,
        '',
        `  ${pad('pool', 8)}${pad('total', 12)}${pad('per file', 12)}${pad('speed-up', 11)}20k projection`,
        ...rows.map(
          (r) =>
            `  ${pad(r.size, 8)}${pad(`${String(r.elapsed)} ms`, 12)}${pad(`${r.perFile.toFixed(2)} ms`, 12)}` +
            `${pad(`${(serial.elapsed / r.elapsed).toFixed(2)}×`, 11)}${minutes(r.perFile, 20_000)}`
        ),
        `  ${pad('stub', 8)}${pad(`${String(floor)} ms`, 12)}${pad(`${(floor / fileCount).toFixed(2)} ms`, 12)}${pad('—', 11)}${minutes(floor / fileCount, 20_000)}`,
        '',
        `  best: pool ${String(best.size)} at ${achieved.toFixed(2)}× serial`,
        `  cores: ${String(cores)}`,
        `  serial stage (stub): ${(serialFraction * 100).toFixed(1)}% of a serial scan` +
          `  ->  Amdahl ceiling at pool ${String(best.size)}: ${predicted.toFixed(2)}×`,
        `  achieved ${((achieved / predicted) * 100).toFixed(0)}% of that ceiling — ` +
          (achieved / predicted > 0.8
            ? 'stage A is the binding constraint'
            : 'probes are contending on something beyond CPU (disk queue, process spawn)'),
        `  AAR-M1 D3 baseline: 43.50 ms/file serial -> ${minutes(43.5, 20_000)} at 20k files`,
        '',
      ];
      console.log(lines.join('\n'));

      // Only ever remove what this file created. QUE_BENCH_DIR points at the
      // user's own media and must never be touched.
      if (!REAL_DIR) rmSync(GENERATED_DIR, { recursive: true, force: true });

      /**
       * This asserts only that the pool does something. It deliberately does
       * NOT assert how much.
       *
       * Two thresholds have now been wrong here, both from generalising one
       * machine. A flat `> 2×` failed a 2-core box achieving 100% of what it
       * had. Replacing it with `> 0.75 × min(cores, maxPool)` then failed a
       * 16-core box at a perfectly respectable 3×, because core count is not
       * the only limit — Amdahl's law and the cost of spawning processes bind
       * long before it on a wide machine.
       *
       * A benchmark that fails on hardware that is working correctly is a
       * broken benchmark. Its job is to produce a number and explain it; the
       * judgement belongs in the AAR, where someone can look at the table.
       * What is still worth catching is a regression to no concurrency at all.
       */
      expect(achieved).toBeGreaterThan(1.2);
    },
    10 * 60 * 1000
  );
});

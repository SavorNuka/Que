import { extname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ConcurrencyBudget } from '../../src/main/transcode/budget';
import { TranscodeManager } from '../../src/main/transcode/manager';
import { planTranscode } from '../../src/main/transcode/plan';
import { createProbePool } from '../../src/main/library/scanner';
import { probeFile } from '../../src/main/library/probe';
import { cleanup, tempDir } from '../helpers/media';

/**
 * OPEN-ACTIONS #9 / AAR-M1c §3 falsification 2: the shared concurrency
 * budget's wiring is unit-tested in isolation (scanner.test.ts), but nothing
 * had run a real scan and a real transcode on this machine at the same time
 * to see whether the budget actually protects the transcode from being
 * starved. This does that, against real files, gated behind an env var —
 * it needs real media at machine-specific paths and takes real wall time,
 * the same shape as `tests/bench/scan.bench.test.ts`'s QUE_BENCH gate.
 *
 *   QUE_STRESS=1
 *   QUE_STRESS_VIDEO_FILE="D:\...\a file that needs an actual video transcode"
 *   QUE_STRESS_LIBRARY_DIR="D:\...\a folder of a few hundred real media files"
 */
const RUN = process.env['QUE_STRESS'] === '1';
const VIDEO_FILE = process.env['QUE_STRESS_VIDEO_FILE'];
const LIBRARY_DIR = process.env['QUE_STRESS_LIBRARY_DIR'];

describe.runIf(RUN)('Shared concurrency budget under real simultaneous load', () => {
  it('the probe pool visibly shrinks while a real video transcode holds cores, and the transcode is not starved by a concurrent scan', async () => {
    if (!VIDEO_FILE || !LIBRARY_DIR) {
      throw new Error('QUE_STRESS=1 needs QUE_STRESS_VIDEO_FILE and QUE_STRESS_LIBRARY_DIR set');
    }

    const cacheRoot = tempDir('que-stress-cache-');
    try {
      const budget = new ConcurrencyBudget();
      console.log(`\n[stress] machine cores (budget.total): ${budget.total}`);

      const files = readdirSync(LIBRARY_DIR)
        .map((f) => join(LIBRARY_DIR, f))
        .filter((f) => ['.mkv', '.mp4', '.avi'].includes(extname(f).toLowerCase()));
      console.log(`[stress] probing ${files.length} real files from ${LIBRARY_DIR}`);

      // --- Baseline: the transcode alone, no concurrent scan. ---
      const manager = new TranscodeManager({ cacheRoot: join(cacheRoot, 'baseline'), budget });
      const ext = extname(VIDEO_FILE);
      const probed = await probeFile(VIDEO_FILE, ext);
      const plan = planTranscode(probed.container, probed.videoCodec, probed.audioCodec, ext);
      console.log(`[stress] plan for target file: ${JSON.stringify(plan)}, duration ${String(probed.durationMs)}ms`);

      const baselineStart = Date.now();
      const baselineJob = manager.getOrStart({
        mediaId: 1,
        fingerprint: 'baseline',
        inputPath: VIDEO_FILE,
        plan,
      });
      await new Promise<void>((resolve, reject) => {
        baselineJob.proc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${String(code)}`))));
        baselineJob.proc.once('error', reject);
      });
      const baselineMs = Date.now() - baselineStart;
      const baselineRatio = probed.durationMs ? probed.durationMs / baselineMs : null;
      console.log(`[stress] BASELINE (no concurrent scan): ${baselineMs}ms, ratio ${String(baselineRatio)}x realtime`);

      // --- Concurrent: the same transcode, racing a real probe-pool scan. ---
      const poolSizeSamples: number[] = [];
      const { pool, release } = createProbePool({ concurrency: 8, budget });
      const sampler = setInterval(() => poolSizeSamples.push(pool.size), 250);

      const manager2 = new TranscodeManager({ cacheRoot: join(cacheRoot, 'concurrent'), budget });
      const concurrentStart = Date.now();
      const concurrentJob = manager2.getOrStart({
        mediaId: 2,
        fingerprint: 'concurrent',
        inputPath: VIDEO_FILE,
        plan,
      });

      const transcodeDone = new Promise<void>((resolve, reject) => {
        concurrentJob.proc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${String(code)}`))));
        concurrentJob.proc.once('error', reject);
      });

      // A single pass over `files` (a few seconds, per PRA-M1c §3 M-0) would
      // finish long before a multi-minute transcode and leave most of the
      // "concurrent" window with no actual contention. Loop it for as long
      // as the transcode runs, so the probe pool has sustained real work
      // for the property this test checks to mean anything.
      let transcodeRunning = true;
      void transcodeDone.finally(() => {
        transcodeRunning = false;
      });
      let passes = 0;
      const scanDone = (async (): Promise<void> => {
        while (transcodeRunning) {
          for (const f of files) {
            if (!transcodeRunning) break;
            await pool.submit(
              () => probeFile(f, extname(f)),
              () => undefined
            );
          }
          await pool.drain();
          passes++;
        }
      })();

      await transcodeDone;
      const concurrentMs = Date.now() - concurrentStart;
      console.log(`[stress] scan completed ${passes} full passes over ${files.length} files while the transcode ran`);
      const concurrentRatio = probed.durationMs ? probed.durationMs / concurrentMs : null;
      console.log(`[stress] CONCURRENT (scan racing transcode): transcode finished at ${concurrentMs}ms, ratio ${String(concurrentRatio)}x realtime`);

      await scanDone; // let the scan finish so the pool can be released cleanly
      clearInterval(sampler);
      release();

      const minPoolSize = Math.min(...poolSizeSamples);
      const maxPoolSize = Math.max(...poolSizeSamples);
      console.log(`[stress] probe pool size samples: min=${minPoolSize}, max=${maxPoolSize}, n=${poolSizeSamples.length}`);
      console.log(
        `[stress] baseline ${baselineMs}ms vs concurrent ${concurrentMs}ms — slowdown factor ${(concurrentMs / baselineMs).toFixed(2)}x`
      );

      // The property this test exists to check: the budget visibly engaged
      // (the pool shrank while the transcode ran, ceding real cores to it),
      // the transcode completed rather than being starved to a halt, and —
      // the property the first run of this test found missing — the
      // concurrent run is not dramatically slower than the transcode alone.
      // 1.5x is generous headroom above "no measurable effect"; the
      // pre-fix reservation measured 3.83x on this machine (OPEN-ACTIONS #9).
      expect(minPoolSize).toBeLessThan(8);
      expect(concurrentJob.exitCode).toBe(0);
      expect(concurrentMs / baselineMs).toBeLessThan(1.5);
    } finally {
      cleanup(cacheRoot);
    }
  }, 30 * 60_000);
});

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyBudget } from '../../src/main/transcode/budget';
import { TranscodeManager, type SpawnFn } from '../../src/main/transcode/manager';
import type { TranscodePlan } from '../../src/main/transcode/plan';
import { cleanup, ffmpegBin, hasFfmpeg, makeMkv, tempDir } from '../helpers/media';

/** A fake ffmpeg process: no real subprocess, just enough shape to drive the manager. */
class FakeProcess extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', null);
    return true;
  }
}

const COPY_PLAN: TranscodePlan = { remuxContainer: true, transcodeVideo: false, transcodeAudio: false };
const VIDEO_PLAN: TranscodePlan = { remuxContainer: true, transcodeVideo: true, transcodeAudio: false };

describe('TranscodeManager — lifecycle', () => {
  let dir: string;
  let budget: ConcurrencyBudget;
  let spawned: FakeProcess[];
  let spawn: SpawnFn;
  let now: number;

  beforeEach(() => {
    dir = tempDir('que-transcode-');
    budget = new ConcurrencyBudget(8);
    spawned = [];
    spawn = vi.fn(() => {
      const p = new FakeProcess();
      spawned.push(p);
      return p as unknown as ChildProcess;
    });
    now = 1_000_000;
  });
  afterEach(() => cleanup(dir));

  function manager(overrides: Partial<ConstructorParameters<typeof TranscodeManager>[0]> = {}): TranscodeManager {
    return new TranscodeManager({
      cacheRoot: dir,
      budget,
      spawn,
      // Never actually executed by the fake `spawn` above, but requireFfmpeg()
      // throws if the real ~80 MB binary isn't on disk — which it deliberately
      // isn't in CI (`npm ci --ignore-scripts`). Stub it out.
      resolveFfmpeg: () => 'ffmpeg',
      now: () => now,
      idleTimeoutMs: 1000,
      ...overrides,
    });
  }

  it('starts exactly one process for the from-start job', () => {
    const mgr = manager();
    const job = mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mgr.jobCount).toBe(1);
    expect(job.exited).toBe(false);
  });

  it('a second call for the same (mediaId, fingerprint, start) returns the same job without spawning again', () => {
    const mgr = manager();
    const a = mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    const b = mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    expect(a).toBe(b);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('two rapid calls in the same synchronous turn still coalesce to one process', () => {
    const mgr = manager();
    const [a, b] = [
      mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN }),
      mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN }),
    ];
    expect(a).toBe(b);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a different fingerprint for the same media is a different job', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpB', inputPath: 'in.mkv', plan: COPY_PLAN });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(mgr.jobCount).toBe(2);
  });

  it('a seek beyond the frontier starts a distinct job from the from-start one', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN, startSeconds: 120 });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('two seeks bucketed to the same segment boundary share one job', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN, startSeconds: 121 });
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN, startSeconds: 123 });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reserves budget cores only for a plan that transcodes video, never for copy-only', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    expect(budget.reserved).toBe(0);

    mgr.getOrStart({ mediaId: 2, fingerprint: 'fpB', inputPath: 'in.mkv', plan: VIDEO_PLAN });
    expect(budget.reserved).toBeGreaterThan(0);
  });

  it('releases its budget reservation when the process exits', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: VIDEO_PLAN });
    const reservedWhileRunning = budget.reserved;
    expect(reservedWhileRunning).toBeGreaterThan(0);

    spawned[0]?.emit('exit', 0);
    expect(budget.reserved).toBe(0);
  });

  it('releases its budget reservation if the process errors instead of exiting', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: VIDEO_PLAN });
    spawned[0]?.emit('error', new Error('ENOENT'));
    expect(budget.reserved).toBe(0);
  });

  it('killIdle kills a running job nobody has touched recently, and only that one', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    const key2 = mgr.keyFor(2, 'fpB');
    mgr.getOrStart({ mediaId: 2, fingerprint: 'fpB', inputPath: 'in.mkv', plan: COPY_PLAN });

    now += 2000; // both now idle past the 1000ms timeout
    mgr.touch(key2); // …except job 2, just touched
    mgr.killIdle();

    expect(spawned[0]?.killed).toBe(true);
    expect(spawned[1]?.killed).toBe(false);
  });

  it('killIdle never touches a job that has already exited', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    spawned[0]?.emit('exit', 0);
    now += 2000;
    expect(() => mgr.killIdle()).not.toThrow();
    expect(spawned[0]?.killed).toBe(false); // exited on its own, never "killed"
  });

  it('killAll kills every still-running job', () => {
    const mgr = manager();
    mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    mgr.getOrStart({ mediaId: 2, fingerprint: 'fpB', inputPath: 'in.mkv', plan: COPY_PLAN });
    mgr.killAll();
    expect(spawned.every((p) => p.killed)).toBe(true);
  });

  it('activeDirs lists only running jobs\' directories, never an exited one\'s', () => {
    const mgr = manager();
    const a = mgr.getOrStart({ mediaId: 1, fingerprint: 'fpA', inputPath: 'in.mkv', plan: COPY_PLAN });
    const b = mgr.getOrStart({ mediaId: 2, fingerprint: 'fpB', inputPath: 'in.mkv', plan: COPY_PLAN });
    spawned[0]?.emit('exit', 0);

    const active = mgr.activeDirs();
    expect(active.has(a.dir)).toBe(false);
    expect(active.has(b.dir)).toBe(true);
  });
});

/**
 * Against a real ffmpeg process, against a real (container-only) MKV — the
 * one PRA-M1c falsification item this test can settle without a running
 * Electron renderer: does the manager's real spawn produce a playlist that
 * actually converges to a finished VOD list (R1's readiness signal).
 */
describe('TranscodeManager — real ffmpeg', () => {
  let dir: string;
  let mediaDir: string;

  beforeEach(() => {
    dir = tempDir('que-transcode-real-');
    mediaDir = tempDir('que-transcode-media-');
  });
  afterEach(() => {
    cleanup(dir);
    cleanup(mediaDir);
  });

  it.runIf(hasFfmpeg())('generates a real playlist that reaches ENDLIST on a clean exit', async () => {
    const inputPath = makeMkv(mediaDir);
    const budget = new ConcurrencyBudget(4);
    // Default spawn — it resolves the bundled binary through ffmpeg.ts's own
    // search roots, the same ones the real app and the tests share.
    const mgr = new TranscodeManager({ cacheRoot: dir, budget });

    const job = mgr.getOrStart({
      mediaId: 1,
      fingerprint: 'real',
      inputPath,
      plan: { remuxContainer: true, transcodeVideo: false, transcodeAudio: false },
    });

    await new Promise<void>((resolve, reject) => {
      job.proc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${String(code)}`))));
      job.proc.once('error', reject);
    });

    const playlist = readFileSync(job.playlistPath, 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(playlist).toContain('.ts');
  }, 30_000);

  it.runIf(hasFfmpeg())('the bundled binary used by the manager is the same one ffmpeg.ts resolves', () => {
    expect(ffmpegBin()).toBeTruthy();
  });
});

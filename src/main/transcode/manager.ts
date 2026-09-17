import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { requireFfmpeg } from '../ffmpeg';
import type { ConcurrencyBudget } from './budget';
import { TRANSCODE_CORE_RESERVATION, TRANSCODE_ENCODER_THREADS } from './budget';
import { ensureDir, jobDir } from './cache';
import { buildHlsArgs, type TranscodePlan } from './plan';

/**
 * Process lifecycle for HLS generation jobs (PRA-M1c §5.6/§5.7).
 *
 * **Deviation from PRA-M1c §5.7, recorded here rather than quietly absorbed.**
 * The PRA proposed reusing `src/main/idempotency/single-flight.ts` to dedupe
 * two concurrent requests for the same job. That mechanism exists to close
 * the race window around an `await` — the check and the registration must
 * both happen before any suspension point, or two callers can both miss the
 * cache and both execute. Starting a transcode job has no such window:
 * `mkdirSync`, `ConcurrencyBudget.reserve` and `child_process.spawn` are all
 * synchronous, so the job is registered into `#jobs` before this function's
 * first `await`. Two callers invoked back-to-back (`Promise.all([...])`, or
 * two request handlers whose synchronous prefixes both run before either
 * suspends) therefore already coalesce with a plain `Map` — the single-flight
 * machinery would add a second map and an abort-detach path to guard a race
 * that cannot occur here. Reused where it solves a real problem (M1b's
 * providers); not reused where it would solve one that does not exist.
 */

export type SpawnFn = (bin: string, args: string[]) => ChildProcess;

function defaultSpawn(bin: string, args: string[]): ChildProcess {
  return nodeSpawn(bin, args, { windowsHide: true });
}

export interface TranscodeJob {
  readonly key: string;
  readonly dir: string;
  readonly playlistPath: string;
  readonly proc: ChildProcess;
  readonly startedAt: number;
  lastAccessedAt: number;
  exited: boolean;
  exitCode: number | null;
}

export interface StartJobRequest {
  mediaId: number;
  fingerprint: string;
  inputPath: string;
  plan: TranscodePlan;
  /** Seconds into the file — a seek beyond the already-generated frontier. Omitted/0 for the from-start job. */
  startSeconds?: number;
}

export interface TranscodeManagerOptions {
  cacheRoot: string;
  budget: ConcurrencyBudget;
  spawn?: SpawnFn;
  idleTimeoutMs?: number;
  now?: () => number;
  /** How many cores to reserve from the shared budget — shrinks the probe pool. */
  coreReservation?: number;
  /** How many threads to hand libx264 via `-threads` — deliberately separate; see budget.ts. */
  encoderThreads?: number;
  /**
   * Resolves the ffmpeg binary path. Injectable, like `spawn`, so a test that
   * fakes `spawn` (and so never actually executes the binary) doesn't also
   * need the real ~80 MB ffmpeg on disk just to obtain a path string for it —
   * `requireFfmpeg()` throws when it's absent, which it deliberately is in CI
   * (`npm ci --ignore-scripts` skips the fetch to keep the gate fast). Without
   * this, every test here failed in CI despite never touching a real process.
   */
  resolveFfmpeg?: () => string;
}

export class TranscodeManager {
  #jobs = new Map<string, TranscodeJob>();
  #cacheRoot: string;
  #budget: ConcurrencyBudget;
  #spawn: SpawnFn;
  #idleTimeoutMs: number;
  #now: () => number;
  #coreReservation: number;
  #encoderThreads: number;
  #resolveFfmpeg: () => string;

  constructor(options: TranscodeManagerOptions) {
    this.#cacheRoot = options.cacheRoot;
    this.#budget = options.budget;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#coreReservation = options.coreReservation ?? TRANSCODE_CORE_RESERVATION;
    this.#encoderThreads = options.encoderThreads ?? TRANSCODE_ENCODER_THREADS;
    this.#resolveFfmpeg = options.resolveFfmpeg ?? requireFfmpeg;
  }

  get jobCount(): number {
    return this.#jobs.size;
  }

  /** Directories a running job owns — cache.ts's enforceSizeCap must never evict these. */
  activeDirs(): Set<string> {
    const dirs = new Set<string>();
    for (const job of this.#jobs.values()) {
      if (!job.exited) dirs.add(job.dir);
    }
    return dirs;
  }

  getJob(key: string): TranscodeJob | undefined {
    return this.#jobs.get(key);
  }

  keyFor(mediaId: number, fingerprintValue: string, startSeconds = 0): string {
    return jobDir(this.#cacheRoot, mediaId, fingerprintValue, startSeconds);
  }

  /** Marks a job recently used — the HTTP layer calls this on every playlist/segment request. */
  touch(key: string): void {
    const job = this.#jobs.get(key);
    if (job) job.lastAccessedAt = this.#now();
  }

  /**
   * Start a job, or return the one already running/finished for the same
   * key. See the class doc comment for why this needs no dedicated
   * dedupe layer beyond the map itself.
   */
  getOrStart(req: StartJobRequest): TranscodeJob {
    const key = this.keyFor(req.mediaId, req.fingerprint, req.startSeconds ?? 0);
    const existing = this.#jobs.get(key);
    if (existing) {
      existing.lastAccessedAt = this.#now();
      return existing;
    }

    const dir = jobDir(this.#cacheRoot, req.mediaId, req.fingerprint, req.startSeconds ?? 0);
    ensureDir(dir);
    const playlistPath = join(dir, 'playlist.m3u8');
    const segmentPattern = join(dir, 'seg%05d.ts');

    // Transcode is foreground, user-waiting work — it reserves cores before
    // the probe pool gets a say (§5.4). Copy-only jobs need no reservation:
    // they are not CPU-bound the way an encode is (PRA-M1c §3 M-1).
    const wantsCores = req.plan.transcodeVideo;
    const releaseBudget = wantsCores ? this.#budget.reserve(this.#coreReservation) : undefined;

    const args = buildHlsArgs(req.plan, {
      inputPath: req.inputPath,
      playlistPath,
      segmentPattern,
      startSeconds: req.startSeconds,
      // Deliberately NOT #coreReservation — see budget.ts's
      // TRANSCODE_ENCODER_THREADS for why the two are separate numbers.
      threads: wantsCores ? this.#encoderThreads : undefined,
    });

    const proc = this.#spawn(this.#resolveFfmpeg(), args);

    const job: TranscodeJob = {
      key,
      dir,
      playlistPath,
      proc,
      startedAt: this.#now(),
      lastAccessedAt: this.#now(),
      exited: false,
      exitCode: null,
    };

    const finish = (code: number | null): void => {
      job.exited = true;
      job.exitCode = code;
      releaseBudget?.();
    };
    proc.once('exit', finish);
    proc.once('error', () => finish(null));

    this.#jobs.set(key, job);
    return job;
  }

  /** Kill a running job nobody has asked for a segment from recently (§5.6). */
  killIdle(): void {
    const now = this.#now();
    for (const job of this.#jobs.values()) {
      if (!job.exited && now - job.lastAccessedAt > this.#idleTimeoutMs) {
        job.proc.kill();
      }
    }
  }

  /** Kill every running job — app quit (§5.6). */
  killAll(): void {
    for (const job of this.#jobs.values()) {
      if (!job.exited) job.proc.kill();
    }
  }
}

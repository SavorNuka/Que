import { availableParallelism } from 'node:os';

/**
 * Shared concurrency budget between the probe pool and active transcodes
 * (PRA-M1c §5.4 / OPEN-ACTIONS #2, carried from AAR-M1b §5).
 *
 * A single video-codec transcode is a multi-threaded `libx264` process that
 * auto-claims most of the visible core count on its own — measured running
 * unthrottled on 28 cores (PRA-M1c §3 M-3). Run a scan's probe pool at the
 * same time with no coordination and each starves the other.
 *
 * The rule: a transcode is foreground, user-waiting work and reserves cores
 * first; the probe pool asks how many are left and resizes to fit, so a scan
 * that started before playback still yields cores once a transcode reserves
 * them, and gets them back once it releases.
 */
export class ConcurrencyBudget {
  readonly total: number;
  #reserved = 0;
  #subscribers = new Set<() => void>();

  constructor(total: number = availableParallelism()) {
    this.total = Math.max(1, total);
  }

  get reserved(): number {
    return this.#reserved;
  }

  /** Cores left for background work like probing, after transcode reservations. Never below 1. */
  get available(): number {
    return Math.max(1, this.total - this.#reserved);
  }

  /**
   * Reserve `cores` for a transcode. Returns a release function — idempotent,
   * safe to call once, meant to live in a `finally` next to the ffmpeg
   * process it guards.
   */
  reserve(cores: number): () => void {
    const n = Math.max(1, Math.min(cores, this.total));
    this.#reserved += n;
    this.#notify();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved -= n;
      this.#notify();
    };
  }

  /** Called whenever `available` may have changed — a pool resizes itself in response. */
  onChange(fn: () => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  #notify(): void {
    for (const fn of this.#subscribers) fn();
  }
}

/**
 * One instance per process, shared by the scanner's probe pool and the
 * transcode pipeline — the coordination only works if both sides reserve
 * from and read the same budget (AAR-M1 §4's "one module, two importers"
 * rule extended to state, not just code).
 */
export const mediaWorkBudget = new ConcurrencyBudget();

/** How many cores a transcode job reserves. Fixed for this phase — see PRA-M1c §11. */
export const TRANSCODE_CORE_RESERVATION = Math.min(4, mediaWorkBudget.total);

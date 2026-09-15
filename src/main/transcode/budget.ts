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

/**
 * How many cores a transcode job reserves.
 *
 * **Overturned by real measurement — OPEN-ACTIONS #9.** The original value,
 * `min(4, total)`, was sized as "a modest few cores" without checking it
 * against what it needed to beat: the probe pool's own target size
 * (`defaultProbeConcurrency()`, capped at 8). On a 28-core machine that
 * reserves 4 and leaves 24 available — far more than 8 — so `Pool.resize()`
 * never had a reason to shrink the scanner at all. Measured on real
 * hardware: a real video transcode alone finished in 130s; the same
 * transcode racing a real, continuously-scanning probe pool at that
 * reservation took 498s — **3.83× slower**, with the probe pool sampled at
 * a constant size of 8 throughout. The mechanism's logic was correct; the
 * constant was not.
 *
 * Fixed to reserve nearly everything: a transcode is foreground,
 * user-waiting work, and this makes it actually win the contention it is
 * meant to win, rather than merely being *allowed* to. `total - 2` leaves a
 * small amount of room for the probe pool rather than reducing it to
 * `Pool`'s own floor of 1, so a scan does not stall completely, and the
 * `Math.max(4, …)` floor keeps the reservation meaningful on a small
 * machine instead of rounding to nothing.
 */
export const TRANSCODE_CORE_RESERVATION = Math.max(4, mediaWorkBudget.total - 2);

/**
 * How many threads libx264 itself is told to use (`-threads N`) — a
 * deliberately separate, small, fixed number from the reservation above.
 *
 * A second real measurement, immediately after the first: raising
 * `TRANSCODE_CORE_RESERVATION` and passing that same large number straight
 * to `-threads` made the real slowdown *worse* — 12.8× instead of 3.83×,
 * despite the probe pool correctly shrinking to 2. The baseline (transcode
 * alone) was unchanged either way (~130s with 4 threads, ~129s with 26) —
 * this HEVC source is decode-bound, not encode-bound, so more encoder
 * threads bought nothing when idle and cost a great deal under contention:
 * x264's frame-parallel pipeline has real synchronization overhead between
 * threads, and a pipeline configured for many threads stalls harder when a
 * competing process preempts even a few of them, than one configured for
 * few threads to begin with. "Reserve more cores from the shared budget"
 * and "hand the encoder more threads" are different levers with different,
 * partly opposite, effects — conflating them was the mistake in the first
 * attempt at fixing OPEN-ACTIONS #9.
 */
export const TRANSCODE_ENCODER_THREADS = 4;

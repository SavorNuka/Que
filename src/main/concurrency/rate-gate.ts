import { systemClock, type Clock } from './clock';

/**
 * A per-host rate gate.
 *
 * PRA-M1b M-6: pool size and request rate are independent controls and must
 * not be conflated. Eight workers against MusicBrainz's 1 req/s finish no
 * sooner than one worker (595 ms vs 602 ms in the harness) and turn a polite
 * serial queue into a burst, which is how an IP gets blocked. So the pool
 * bounds how much work is *prepared* in parallel; this gate bounds how fast it
 * *leaves*.
 *
 * The model is a token bucket expressed as a reservation. Each `acquire` takes
 * the next slot and advances the cursor, so admission order is call order, and
 * an idle gate can release up to `burst` immediately before spacing resumes.
 * Reservations never drift: a caller that aborts while waiting forfeits its
 * slot rather than letting a later caller move up, which errs towards asking
 * less often than allowed.
 */

export interface RateGateOptions {
  /** Average spacing between dispatches. MusicBrainz: 1000. */
  minIntervalMs: number;
  /** How many may leave back-to-back after an idle period. Default 1. */
  burst?: number;
  clock?: Clock;
}

export interface RateGateStats {
  dispatched: number;
  /** Total time callers spent waiting on this gate — the R8 signal. */
  waitedMs: number;
  /** Longest single wait, which is what a user would actually notice. */
  maxWaitMs: number;
}

export class RateGate {
  readonly minIntervalMs: number;
  readonly burst: number;

  #clock: Clock;
  #cursor: number | null = null;
  #stats: RateGateStats = { dispatched: 0, waitedMs: 0, maxWaitMs: 0 };

  constructor(options: RateGateOptions) {
    if (options.minIntervalMs < 0) throw new Error('minIntervalMs must be >= 0');
    this.minIntervalMs = options.minIntervalMs;
    this.burst = Math.max(1, options.burst ?? 1);
    this.#clock = options.clock ?? systemClock;
  }

  /** Resolves when the caller may make its request. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.minIntervalMs === 0) {
      this.#stats.dispatched++;
      return;
    }

    const now = this.#clock.now();

    // An idle gate refills: allow `burst` slots at or before now.
    const earliest = now - (this.burst - 1) * this.minIntervalMs;
    const at = Math.max(this.#cursor ?? earliest, earliest);
    this.#cursor = at + this.minIntervalMs;

    const wait = at - now;
    if (wait > 0) {
      await this.#clock.sleep(wait, signal);
      this.#stats.waitedMs += wait;
      this.#stats.maxWaitMs = Math.max(this.#stats.maxWaitMs, wait);
    }

    this.#stats.dispatched++;
  }

  stats(): RateGateStats {
    return { ...this.#stats };
  }

  /** Forget the reservation cursor. Tests and a settings change use this. */
  reset(): void {
    this.#cursor = null;
    this.#stats = { dispatched: 0, waitedMs: 0, maxWaitMs: 0 };
  }
}

/**
 * Published limits, checked against each provider's documentation rather than
 * guessed. PRA-M1b §13 leaves burst tolerance as an open question — the
 * conservative value is 1 until it is measured.
 */
export const HOST_LIMITS: Record<string, RateGateOptions> = {
  'musicbrainz.org': { minIntervalMs: 1000, burst: 1 },
  'coverartarchive.org': { minIntervalMs: 250, burst: 2 },
  'itunes.apple.com': { minIntervalMs: 350, burst: 2 },
  'api.lyrics.ovh': { minIntervalMs: 500, burst: 2 },
  'v3-cinemeta.strem.io': { minIntervalMs: 100, burst: 5 },
  'api.opensubtitles.com': { minIntervalMs: 250, burst: 2 },
  'api.themoviedb.org': { minIntervalMs: 50, burst: 10 },
};

/** Anything not listed above. Deliberately cautious. */
export const DEFAULT_HOST_LIMIT: RateGateOptions = { minIntervalMs: 500, burst: 2 };

export interface RateGateRegistryOptions {
  clock?: Clock;
  /** Overrides HOST_LIMITS. Tests use this to remove spacing entirely. */
  limits?: Record<string, RateGateOptions>;
  /** Applied to a host that appears in neither table. */
  fallback?: RateGateOptions;
}

export class RateGateRegistry {
  #gates = new Map<string, RateGate>();
  #clock: Clock;
  #limits: Record<string, RateGateOptions>;
  #fallback: RateGateOptions;

  constructor(options: RateGateRegistryOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#limits = { ...HOST_LIMITS, ...options.limits };
    this.#fallback = options.fallback ?? DEFAULT_HOST_LIMIT;
  }

  /** The gate for a host. One gate per host, shared by every caller. */
  for(host: string): RateGate {
    const existing = this.#gates.get(host);
    if (existing) return existing;

    const limit = this.#limits[host] ?? this.#fallback;
    const gate = new RateGate({ ...limit, clock: this.#clock });
    this.#gates.set(host, gate);
    return gate;
  }

  forUrl(url: string): RateGate {
    try {
      return this.for(new URL(url).host);
    } catch {
      return this.for('invalid');
    }
  }

  snapshot(): Record<string, RateGateStats> {
    return Object.fromEntries([...this.#gates].map(([host, gate]) => [host, gate.stats()]));
  }

  resetAll(): void {
    for (const gate of this.#gates.values()) gate.reset();
  }
}

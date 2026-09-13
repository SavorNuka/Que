import { systemClock, type Clock } from '../concurrency/clock';
import { RateGateRegistry } from '../concurrency/rate-gate';
import { classify, retry, type RetryOptions } from '../concurrency/retry';
import {
  DEFAULT_POLICY,
  expiryFor,
  type CacheOutcome,
  type CachePolicy,
  type ProviderCache,
} from './cache';
import { describeKey, type KeyParts, type OriginRef, originSegment } from './key';
import { SingleFlight } from './single-flight';

/**
 * The provider request path — where the four pieces meet.
 *
 * PRA-M1b §4 C1: none of Que's providers offer an idempotency contract, so
 * nothing upstream will deduplicate on our behalf. For this purpose **Que is
 * the server**, and the guarantee is ours to keep. This class is where it is
 * kept:
 *
 *   1. build the key from the resource, not the row  (key.ts)
 *   2. return a cached answer immediately, no execution
 *   3. otherwise join or start exactly one call      (single-flight.ts)
 *   4. space the call against the host's limit       (rate-gate.ts)
 *   5. retry only what is worth retrying             (retry.ts)
 *   6. cache the outcome by what kind of outcome it is
 *
 * Steps 2 and 3 are synchronous with respect to one another — no `await`
 * separates them — which is what makes the check-then-act race (harness M-1)
 * unreachable rather than merely unlikely.
 */

export interface ProviderRequest<T> extends KeyParts {
  /** Picks the rate gate. Usually the provider's API host. */
  host: string;
  /**
   * Perform the call. Resolve with the value, or `null` to mean "the provider
   * is sure there is nothing here" — a definitive negative, which is cached
   * with a TTL rather than retried forever.
   */
  execute: (ctx: { signal: AbortSignal; attempt: number }) => Promise<T | null>;
  /** Override the policy TTL for this one request. */
  ttlMs?: number | null;
}

export type ResultSource = 'cache' | 'coalesced' | 'network';

export interface ProviderResult<T> {
  value: T | null;
  outcome: CacheOutcome;
  source: ResultSource;
  key: string;
}

export interface ProviderClientOptions {
  cache: ProviderCache;
  gates?: RateGateRegistry;
  singleFlight?: SingleFlight;
  clock?: Clock;
  policy?: CachePolicy;
  retry?: RetryOptions;
  /** Applied to each shared call; a socket that never settles is R3. */
  timeoutMs?: number;
}

export interface ClientStats {
  requests: number;
  cacheHits: number;
  coalesced: number;
  networkCalls: number;
  negatives: number;
  failures: number;
}

export class ProviderClient {
  readonly gates: RateGateRegistry;

  #cache: ProviderCache;
  #singleFlight: SingleFlight;
  #clock: Clock;
  #policy: CachePolicy;
  #retry: RetryOptions;
  #timeoutMs: number | undefined;
  #stats: ClientStats = {
    requests: 0,
    cacheHits: 0,
    coalesced: 0,
    networkCalls: 0,
    negatives: 0,
    failures: 0,
  };

  constructor(options: ProviderClientOptions) {
    this.#cache = options.cache;
    this.#clock = options.clock ?? systemClock;
    this.gates = options.gates ?? new RateGateRegistry({ clock: this.#clock });
    this.#singleFlight = options.singleFlight ?? new SingleFlight({ clock: this.#clock });
    this.#policy = options.policy ?? DEFAULT_POLICY;
    this.#retry = options.retry ?? {};
    this.#timeoutMs = options.timeoutMs;
  }

  async request<T>(req: ProviderRequest<T>, options: { signal?: AbortSignal } = {}): Promise<ProviderResult<T>> {
    this.#stats.requests++;

    const descriptor = describeKey(req);
    const now = this.#clock.now();

    // (2) Cache first, synchronously. A hit never executes anything.
    const hit = this.#cache.get<T>(descriptor.key, now);
    if (hit) {
      this.#stats.cacheHits++;
      return { value: hit.value, outcome: hit.outcome, source: 'cache', key: descriptor.key };
    }

    // (3) Exactly one call per key. `executed` distinguishes "we did the work"
    // from "we waited for someone else's", which is the number worth watching.
    let executed = false;

    const gate = this.gates.for(req.host);

    const shared = this.#singleFlight.run<{ value: T | null; outcome: CacheOutcome }>(
      descriptor.key,
      async (signal) => {
        executed = true;
        this.#stats.networkCalls++;

        try {
          const value = await retry(
            async (attempt) => req.execute({ signal, attempt }),
            { ...this.#retry, gate, signal, clock: this.#clock }
          );

          const outcome: CacheOutcome = value === null ? 'negative' : 'success';
          if (outcome === 'negative') this.#stats.negatives++;

          this.#write(descriptor, outcome, value, req.ttlMs);
          return { value, outcome };
        } catch (e) {
          const kind = classify(e);

          // A provider that is certain there is nothing is an answer, not a
          // failure — cached with a TTL so we stop asking every scan.
          if (kind === 'negative') {
            this.#stats.negatives++;
            this.#write(descriptor, 'negative', null, req.ttlMs);
            return { value: null, outcome: 'negative' as const };
          }

          // Everything else — transient, rate-limited, malformed, aborted —
          // is a failure to ask. Never cached (harness M-4).
          this.#stats.failures++;
          throw e;
        }
      },
      { signal: options.signal, timeoutMs: this.#timeoutMs }
    );

    const result = await shared;
    if (!executed) this.#stats.coalesced++;

    return {
      value: result.value,
      outcome: result.outcome,
      source: executed ? 'network' : 'coalesced',
      key: descriptor.key,
    };
  }

  /**
   * Drop everything cached about one resource — the "re-match this item"
   * primitive (PRA-M1b R4). Clears every provider, capability and parameter
   * variant, so a correction does not half-apply.
   */
  invalidate(origin: OriginRef): number {
    return this.#cache.invalidateOrigin(originSegment(origin));
  }

  stats(): ClientStats & { rateGates: ReturnType<RateGateRegistry['snapshot']> } {
    return { ...this.#stats, rateGates: this.gates.snapshot() };
  }

  #write(
    descriptor: ReturnType<typeof describeKey>,
    outcome: CacheOutcome,
    value: unknown,
    ttlMs: number | null | undefined
  ): void {
    const now = this.#clock.now();
    const expiresAt = ttlMs === undefined ? expiryFor(outcome, now, this.#policy) : ttlMs === null ? null : now + ttlMs;
    this.#cache.set({ descriptor, outcome, value, now, expiresAt });
  }
}

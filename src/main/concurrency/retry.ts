import { AbortError, systemClock, type Clock } from './clock';
import { asError } from './pool';
import type { RateGate } from './rate-gate';

/**
 * Retry with backoff, jitter, and a hard rule about what may be retried.
 *
 * PRA-M1b R8: a naive retry loop turns a provider hiccup into a burst, which
 * against a rate-limited host is how a temporary block is earned. Two things
 * prevent that here — retries re-enter the same gate as the first attempt
 * (so a retry storm is spaced exactly like normal traffic), and the delay is
 * jittered so N simultaneous failures do not retry in lockstep.
 *
 * The classification matters as much as the backoff. Retrying a 404 wastes the
 * rate budget on an answer that will not change; not retrying a 503 loses a
 * result we could have had. PRA-M1b §5.5 defines which is which, and
 * `classify` is the single place that decides.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message?: string, retryAfterMs: number | null = null) {
    super(message ?? `HTTP ${String(status)}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when a provider's response cannot be understood. Never retried. */
export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedResponseError';
  }
}

export type Outcome = 'success' | 'negative' | 'transient' | 'rate-limited' | 'malformed' | 'aborted';

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Classify a failure. This is the function the cache policy and the retry
 * policy both read, so the two can never disagree about what a 404 is.
 */
export function classify(error: unknown): Outcome {
  const e = asError(error);

  if (e.name === 'AbortError') return 'aborted';
  if (e instanceof MalformedResponseError) return 'malformed';

  if (e instanceof HttpError) {
    if (e.status === 429) return 'rate-limited';
    if (e.status >= 500) return 'transient';
    if (e.status === 404 || e.status === 410) return 'negative';
    // Every other 4xx is our request being wrong. Repeating it will not help.
    return 'malformed';
  }

  const code = (e as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return 'transient';
  if (/timeout|timed out|socket hang up|network/i.test(e.message)) return 'transient';

  return 'malformed';
}

export function isRetryable(error: unknown): boolean {
  const outcome = classify(error);
  return outcome === 'transient' || outcome === 'rate-limited';
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** First backoff, doubled each attempt. Default 500. */
  baseMs?: number;
  /** Ceiling on a single backoff. Default 15_000. */
  maxMs?: number;
  /**
   * Fraction of the delay that is randomised, 0..1. Default 0.5, so a delay
   * lands between 50% and 100% of the capped value.
   */
  jitter?: number;
  /** Overridden in tests so backoff is deterministic. */
  random?: () => number;
  /** Acquired before EVERY attempt, retries included. */
  gate?: Pick<RateGate, 'acquire'>;
  isRetryable?: (error: unknown) => boolean;
  signal?: AbortSignal;
  clock?: Clock;
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
}

export function backoffDelay(
  attempt: number,
  { baseMs = 500, maxMs = 15_000, jitter = 0.5, random = Math.random }: RetryOptions = {}
): number {
  const capped = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const clampedJitter = Math.min(1, Math.max(0, jitter));
  return Math.round(capped * (1 - clampedJitter + clampedJitter * random()));
}

/**
 * Run `fn`, retrying only what is worth retrying.
 *
 * `fn` receives the attempt number (1-based) so a caller can log or vary a
 * request. The gate is acquired before each attempt, which is what keeps a
 * failure storm from becoming a traffic spike.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    gate,
    signal,
    clock = systemClock,
    isRetryable: retryable = isRetryable,
    onRetry,
  } = options;

  let lastError: Error = new Error('retry: no attempts were made');

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new AbortError();

    try {
      if (gate) await gate.acquire(signal);
      return await fn(attempt);
    } catch (e) {
      lastError = asError(e);

      if (classify(lastError) === 'aborted') throw lastError;
      if (attempt === attempts || !retryable(lastError)) throw lastError;

      // A server that told us how long to wait knows better than our curve.
      const advised = lastError instanceof HttpError ? lastError.retryAfterMs : null;
      const delayMs = advised ?? backoffDelay(attempt, options);

      onRetry?.({ attempt, delayMs, error: lastError });
      await clock.sleep(delayMs, signal);
    }
  }

  throw lastError;
}

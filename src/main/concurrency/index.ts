/**
 * Bounded concurrency, rate limiting and retry.
 *
 * Built once here and imported by both consumers — the scanner's ffprobe calls
 * now, the provider layer in M3. AAR-M1 §4 is explicit about why: "Build it
 * once, in M1b, as a shared utility, and M3 inherits it. Solve it twice and
 * they will drift." (PRA-M1b R1.)
 *
 * The one rule that is easy to forget: **pool size is not a rate control.**
 * Harness M-6 measured eight workers against a rate-limited host finishing no
 * sooner than one (602 ms vs 595 ms) while turning a polite queue into a burst.
 * Use the pool for local work and the gate for remote work; the two compose but
 * do not substitute.
 */

export { AbortError, abortReason, manualClock, systemClock, type Clock, type ManualClock } from './clock';
export { Pool, mapPool, asError, failures, values, type PoolOptions, type Settled, type Task } from './pool';
export {
  DEFAULT_HOST_LIMIT,
  HOST_LIMITS,
  RateGate,
  RateGateRegistry,
  type RateGateOptions,
  type RateGateStats,
} from './rate-gate';
export {
  HttpError,
  MalformedResponseError,
  backoffDelay,
  classify,
  isRetryable,
  retry,
  type Outcome,
  type RetryOptions,
} from './retry';

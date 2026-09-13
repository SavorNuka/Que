import { AbortError, abortReason, systemClock, type Clock } from '../concurrency/clock';
import { asError } from '../concurrency/pool';

/**
 * Single-flight: the mechanism the brief asks for, and the one a cache alone
 * cannot provide.
 *
 * Harness M-1, twelve concurrent requests for one resource:
 *
 *     no protection            12 provider calls
 *     cache, check-then-act    12 provider calls   <- the race
 *     cache + in-flight map     1 provider call
 *
 * A cache is checked, missed, and only written after the call returns. Under
 * concurrency every caller checks before any caller writes, so every caller
 * executes. Tracking the in-flight promise closes that window: the second
 * caller finds the first caller's work and waits for it.
 *
 * Two properties that are easy to get wrong and each have a test:
 *
 *  - **A failure must not poison the key** (M-4). The in-flight entry is
 *    cleared in `finally`, not in `then`. Clearing only on success leaves a
 *    rejected promise cached under that key for the life of the process — one
 *    network blip and that film is unmatchable until restart.
 *  - **A cancelling caller must not cancel its joiners** (PRA-M1b R7). The
 *    shared promise is owned by this class, never by whoever happened to ask
 *    first. A caller that aborts detaches; the request is abandoned only when
 *    the last joiner leaves. The obvious implementation — pass the caller's
 *    signal straight through to `exec` — gets this wrong in a way that shows
 *    up only under cancellation, which is to say in front of a user.
 */

interface Entry<T> {
  promise: Promise<T>;
  controller: AbortController;
  joiners: number;
  startedAt: number;
}

export interface SingleFlightOptions {
  clock?: Clock;
  /**
   * Abort any shared call still running after this long (PRA-M1b R3). Without
   * it, a socket that never settles holds its key forever.
   */
  timeoutMs?: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class SingleFlight {
  #entries = new Map<string, Entry<unknown>>();
  #clock: Clock;
  #defaultTimeoutMs: number | undefined;
  #coalesced = 0;

  constructor(options: SingleFlightOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#defaultTimeoutMs = options.timeoutMs;
  }

  /** How many distinct keys are executing right now. */
  get size(): number {
    return this.#entries.size;
  }

  /** How many callers have been served by someone else's in-flight call. */
  get coalesced(): number {
    return this.#coalesced;
  }

  /**
   * Run `exec` for `key`, or join the run already happening for it.
   *
   * Registration happens synchronously before any `await`, which is what makes
   * the check-then-act window zero-width.
   */
  run<T>(key: string, exec: (signal: AbortSignal) => Promise<T>, options: RunOptions = {}): Promise<T> {
    const existing = this.#entries.get(key) as Entry<T> | undefined;
    if (existing) {
      this.#coalesced++;
      return this.#attach(key, existing, options.signal);
    }

    const controller = new AbortController();
    const entry: Entry<T> = {
      controller,
      joiners: 0,
      startedAt: this.#clock.now(),
      promise: undefined as unknown as Promise<T>,
    };

    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const timer = new AbortController();

    /**
     * The timeout races the call as well as aborting it. A provider wrapper
     * that ignores its signal would otherwise hold the key forever, which is
     * the failure R3 describes — and the key, not the socket, is what matters
     * here: while it is held, every later caller joins a call that will never
     * finish.
     */
    const run = (): Promise<T> => {
      const call = (async () => exec(controller.signal))();
      if (timeoutMs === undefined) return call;

      const message = `Request for ${key} exceeded ${String(timeoutMs)}ms`;
      const expiry = new Promise<never>((_resolve, reject) => {
        this.#clock
          .sleep(timeoutMs, timer.signal)
          .then(() => {
            controller.abort(new Error(message));
            reject(new Error(message));
          })
          .catch(() => {
            /* the timer was cancelled because the call finished first */
          });
      });

      return Promise.race([call, expiry]);
    };

    entry.promise = run().finally(() => {
      timer.abort();
      // Cleared on success AND failure. See M-4 above.
      if (this.#entries.get(key) === (entry as Entry<unknown>)) this.#entries.delete(key);
    });

    // The shared promise may end up with no joiners if everyone detaches; mark
    // it handled so a rejection is not reported as unhandled.
    entry.promise.catch(() => undefined);

    this.#entries.set(key, entry as Entry<unknown>);
    return this.#attach(key, entry, options.signal);
  }

  /** Abort every in-flight call. Used when the app is shutting down. */
  abortAll(reason?: unknown): void {
    for (const entry of this.#entries.values()) entry.controller.abort(reason);
    this.#entries.clear();
  }

  #attach<T>(key: string, entry: Entry<T>, signal: AbortSignal | undefined): Promise<T> {
    entry.joiners++;

    const release = (): void => {
      entry.joiners--;
      // Only the departure of the LAST joiner abandons the work. A joiner
      // leaving while others wait changes nothing for them.
      if (entry.joiners <= 0 && this.#entries.get(key) === (entry as Entry<unknown>)) {
        this.#entries.delete(key);
        entry.controller.abort(new AbortError('All callers detached'));
      }
    };

    if (!signal) {
      return entry.promise.then(
        (v) => {
          entry.joiners--;
          return v;
        },
        (e: unknown) => {
          entry.joiners--;
          throw asError(e);
        }
      );
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = (): void => {
        finish(() => {
          release();
          reject(abortReason(signal));
        });
      };

      if (signal.aborted) {
        // Registered above, so release() keeps the joiner count honest.
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      entry.promise.then(
        (value) =>
          finish(() => {
            entry.joiners--;
            resolve(value);
          }),
        (error: unknown) =>
          finish(() => {
            entry.joiners--;
            reject(asError(error));
          })
      );
    });
  }
}

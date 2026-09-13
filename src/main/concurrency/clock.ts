/**
 * An injectable clock.
 *
 * Everything in this folder waits on time — a rate gate spaces requests, a
 * retry backs off, a timeout gives up. Code that reads `Date.now()` and calls
 * `setTimeout` directly can only be tested by actually waiting, so in practice
 * it gets tested with `sleep(50)` and a generous tolerance, which is how flaky
 * suites are born.
 *
 * PRA-M1b R9: the clock is a parameter from the start. `manualClock()` makes
 * every timing test deterministic and instant.
 */

export interface Clock {
  now(): number;
  /** Resolves after `ms` of this clock's time, or rejects if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Normalise whatever an AbortSignal carries as its reason into an Error. */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new AbortError(reason);
  return new AbortError();
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    if (ms <= 0) return signal?.aborted ? Promise.reject(abortReason(signal)) : Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

interface PendingTimer {
  at: number;
  seq: number;
  fire: () => void;
  cancel: () => void;
}

export interface ManualClock extends Clock {
  /**
   * Move time forward, firing everything due along the way and draining the
   * microtask queue between firings so continuations run in order.
   */
  advance(ms: number): Promise<void>;
  /** Run pending microtasks without moving time. */
  tick(): Promise<void>;
  /** How many sleepers are waiting. Useful for asserting backpressure. */
  pending(): number;
}

/**
 * A clock whose time only moves when a test says so.
 *
 * `advance` fires timers in due order rather than all at once, so a retry that
 * schedules its next attempt from inside a firing timer is handled correctly
 * within a single `advance` call.
 */
export function manualClock(start = 0): ManualClock {
  let current = start;
  let seq = 0;
  const timers = new Set<PendingTimer>();

  const drain = (): Promise<void> =>
    // Two turns: one for `.then` continuations, one for anything they queue.
    new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  return {
    now: () => current,

    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (ms <= 0) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const timer: PendingTimer = {
          at: current + ms,
          seq: seq++,
          fire: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          cancel: () => reject(abortReason(signal)),
        };

        const onAbort = (): void => {
          timers.delete(timer);
          timer.cancel();
        };

        signal?.addEventListener('abort', onAbort, { once: true });
        timers.add(timer);
      });
    },

    async advance(ms) {
      const target = current + ms;

      // Drain BEFORE moving time. A caller that has just started an async
      // function has not reached its `sleep` yet; firing timers first would
      // both miss that sleep and let already-resolved work observe a clock
      // that has jumped ahead of it.
      await drain();

      for (;;) {
        const due = [...timers]
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.seq - b.seq);

        if (due.length === 0) break;

        const next = due[0]!;
        current = Math.max(current, next.at);
        timers.delete(next);
        next.fire();
        await drain();
      }

      current = target;
      await drain();
    },

    tick: drain,
    pending: () => timers.size,
  };
}

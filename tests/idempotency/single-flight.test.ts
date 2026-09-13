import { describe, expect, it } from 'vitest';
import { manualClock } from '../../src/main/concurrency/clock';
import { SingleFlight } from '../../src/main/idempotency/single-flight';

/**
 * Harness M-1 reduced to a regression test, plus the two properties that are
 * easy to lose in a refactor and only fail in front of a user.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SingleFlight — the check-then-act race', () => {
  /**
   * The measured result this exists to keep:
   *
   *   no protection            12 provider calls
   *   cache, check-then-act    12 provider calls
   *   cache + in-flight map     1 provider call
   */
  it('collapses twelve concurrent callers into one call', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const gate = deferred<string>();

    const exec = (): Promise<string> => {
      calls++;
      return gate.promise;
    };

    const all = Promise.all(Array.from({ length: 12 }, () => sf.run('album:kid-a', exec)));
    gate.resolve('the answer');

    const results = await all;
    expect(calls).toBe(1);
    expect(results).toHaveLength(12);
    expect(results.every((r) => r === 'the answer')).toBe(true);
    expect(sf.coalesced).toBe(11);
  });

  /**
   * The negative control. Without the in-flight map, the same workload makes
   * twelve calls — which is what a cache-only design does, and why a cache
   * alone is not enough.
   */
  it('NEGATIVE CONTROL: a cache-only design makes twelve calls for the same work', async () => {
    const cache = new Map<string, string>();
    let calls = 0;
    const gate = deferred<string>();

    const cacheOnly = async (key: string): Promise<string> => {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      calls++;
      const value = await gate.promise;
      cache.set(key, value);
      return value;
    };

    const all = Promise.all(Array.from({ length: 12 }, () => cacheOnly('album:kid-a')));
    gate.resolve('the answer');
    await all;

    expect(calls).toBe(12);
  });

  it('does not coalesce different keys', async () => {
    const sf = new SingleFlight();
    let calls = 0;

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sf.run(`recording:${String(i)}`, () => {
          calls++;
          return Promise.resolve(i);
        })
      )
    );

    expect(calls).toBe(12);
  });

  it('starts a fresh call once the first has settled', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const exec = (): Promise<number> => Promise.resolve(++calls);

    expect(await sf.run('k', exec)).toBe(1);
    expect(await sf.run('k', exec)).toBe(2);
    expect(sf.size).toBe(0);
  });
});

describe('SingleFlight — failure must not poison the key', () => {
  /**
   * Harness M-4. If the in-flight entry were cleared in `then` rather than
   * `finally`, one 503 would leave a rejected promise under that key for the
   * life of the process and that film would be unmatchable until restart.
   */
  it('allows a retry after a transient failure', async () => {
    const sf = new SingleFlight();
    let calls = 0;

    const exec = (): Promise<string> => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('transient 503')) : Promise.resolve('ok');
    };

    await expect(sf.run('cinemeta:tt0111161', exec)).rejects.toThrow('transient 503');
    await expect(sf.run('cinemeta:tt0111161', exec)).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('delivers one rejection to every joiner', async () => {
    const sf = new SingleFlight();
    const gate = deferred<string>();
    let calls = 0;

    const joiners = Array.from({ length: 5 }, () =>
      sf
        .run('k', () => {
          calls++;
          return gate.promise;
        })
        .catch((e: unknown) => (e as Error).message)
    );

    gate.reject(new Error('down'));
    expect(await Promise.all(joiners)).toEqual(['down', 'down', 'down', 'down', 'down']);
    expect(calls).toBe(1);
  });

  it('turns a synchronous throw into a rejection rather than a crash', async () => {
    const sf = new SingleFlight();
    await expect(
      sf.run('k', () => {
        throw new Error('thrown, not rejected');
      })
    ).rejects.toThrow('thrown, not rejected');
    expect(sf.size).toBe(0);
  });
});

describe('SingleFlight — cancellation detaches, it does not cancel (R7)', () => {
  /**
   * The subtle one. The obvious implementation passes the caller's signal
   * straight through to `exec`, which means the first caller to give up
   * cancels the work eleven other callers are still waiting on. That failure
   * only appears under cancellation, which is to say in front of a user.
   */
  it('lets a joiner abort without disturbing the others', async () => {
    const sf = new SingleFlight();
    const gate = deferred<string>();
    let sawAbort = false;
    let calls = 0;

    const exec = (signal: AbortSignal): Promise<string> => {
      calls++;
      signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      return gate.promise;
    };

    const leaver = new AbortController();
    const leaving = sf.run('k', exec, { signal: leaver.signal }).catch((e: unknown) => (e as Error).name);
    const staying = [
      sf.run('k', exec),
      sf.run('k', exec),
    ];

    leaver.abort();
    expect(await leaving).toBe('AbortError');
    expect(sawAbort).toBe(false); // the work carries on for the others

    gate.resolve('the answer');
    expect(await Promise.all(staying)).toEqual(['the answer', 'the answer']);
    expect(calls).toBe(1);
  });

  it('abandons the work only when the LAST caller leaves', async () => {
    const sf = new SingleFlight();
    const gate = deferred<string>();
    let sawAbort = false;

    const exec = (signal: AbortSignal): Promise<string> => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      return gate.promise;
    };

    const a = new AbortController();
    const b = new AbortController();
    const first = sf.run('k', exec, { signal: a.signal }).catch(() => 'gone');
    const second = sf.run('k', exec, { signal: b.signal }).catch(() => 'gone');

    a.abort();
    await first;
    expect(sawAbort).toBe(false);

    b.abort();
    await second;
    expect(sawAbort).toBe(true);
    expect(sf.size).toBe(0);
  });

  it('rejects a caller whose signal was already aborted', async () => {
    const sf = new SingleFlight();
    const controller = new AbortController();
    controller.abort();

    await expect(sf.run('k', () => Promise.resolve(1), { signal: controller.signal })).rejects.toThrow();
  });

  it('lets a later caller start fresh work after everyone abandoned the last', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const controller = new AbortController();

    const abandoned = sf
      .run('k', () => {
        calls++;
        return new Promise<number>(() => undefined);
      }, { signal: controller.signal })
      .catch(() => 'gone');

    controller.abort();
    await abandoned;

    await expect(sf.run('k', () => {
      calls++;
      return Promise.resolve(7);
    })).resolves.toBe(7);

    expect(calls).toBe(2);
  });
});

describe('SingleFlight — a call that never settles (R3)', () => {
  it('times out a cooperative call, tells it to stop, and releases the key', async () => {
    const clock = manualClock();
    const sf = new SingleFlight({ clock, timeoutMs: 30_000 });
    let toldToStop = false;

    const stuck = sf
      .run('k', (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            toldToStop = true;
            reject(new Error('gave up'));
          });
        })
      )
      .catch((e: unknown) => (e as Error).message);

    await clock.advance(30_001);

    // The timeout is authoritative, so the caller learns what actually
    // happened rather than whatever the abandoned call chose to say.
    expect(await stuck).toMatch(/exceeded 30000ms/);
    expect(toldToStop).toBe(true);
    expect(sf.size).toBe(0);

    // And the key is usable again, rather than poisoned for the process.
    await expect(sf.run('k', () => Promise.resolve('fresh'))).resolves.toBe('fresh');
  });

  /**
   * The case the abort alone does not cover: a call that ignores its signal.
   * Aborting it changes nothing; only racing the timeout frees the key, and
   * the key is what matters — while it is held, every later caller joins a
   * call that will never finish.
   */
  it('times out a call that ignores its signal entirely', async () => {
    const clock = manualClock();
    const sf = new SingleFlight({ clock, timeoutMs: 30_000 });

    const stuck = sf.run('k', () => new Promise<string>(() => undefined)).catch((e: unknown) => (e as Error).message);

    await clock.advance(30_001);
    expect(await stuck).toMatch(/exceeded 30000ms/);
    expect(sf.size).toBe(0);
    await expect(sf.run('k', () => Promise.resolve('fresh'))).resolves.toBe('fresh');
  });

  it('does not fire the timeout for a call that finishes in time', async () => {
    const clock = manualClock();
    const sf = new SingleFlight({ clock, timeoutMs: 30_000 });

    await expect(sf.run('k', () => Promise.resolve('quick'))).resolves.toBe('quick');
    await clock.advance(60_000);
    expect(clock.pending()).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { manualClock } from '../../src/main/concurrency/clock';
import { Pool, failures, mapPool, values, type Settled } from '../../src/main/concurrency/pool';

/**
 * The pool's four properties (AAR-M1 D3, PRA-M1b §5.3). Each test states which
 * one it guards, because a pool that silently stops being bounded, or silently
 * starts losing errors, looks exactly like one that works.
 */

/** A task that records when it starts and finishes, so overlap is observable. */
function tracker() {
  let active = 0;
  let peak = 0;
  const order: string[] = [];

  return {
    get peak() {
      return peak;
    },
    get order() {
      return order;
    },
    task(label: string, ms: number, fail = false) {
      return async (): Promise<string> => {
        active++;
        peak = Math.max(peak, active);
        order.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, ms));
        active--;
        order.push(`end:${label}`);
        if (fail) throw new Error(`boom ${label}`);
        return label;
      };
    },
  };
}

describe('Pool — bounded', () => {
  it('never runs more than `size` tasks at once', async () => {
    const t = tracker();
    const settled: Settled<string>[] = [];
    const pool = new Pool({ size: 3, queueLimit: 100 });

    for (let i = 0; i < 12; i++) {
      await pool.submit(t.task(String(i), 5), (s) => settled.push(s));
    }
    await pool.drain();

    expect(t.peak).toBe(3);
    expect(settled).toHaveLength(12);
    expect(settled.every((s) => s.ok)).toBe(true);
  });

  it('runs a size-1 pool strictly serially', async () => {
    const t = tracker();
    const pool = new Pool({ size: 1, queueLimit: 10 });

    for (const label of ['a', 'b', 'c']) {
      await pool.submit(t.task(label, 2), () => undefined);
    }
    await pool.drain();

    expect(t.peak).toBe(1);
    expect(t.order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('rejects a nonsense size rather than quietly doing something else', () => {
    expect(() => new Pool({ size: 0 })).toThrow();
    expect(() => new Pool({ size: 2.5 })).toThrow();
  });
});

describe('Pool — error isolation', () => {
  /**
   * The negative control for this one is the language default: an unhandled
   * rejection inside a loop of awaited promises ends the loop. The pool must
   * not behave that way — one corrupt file out of 20,000 cannot end a scan.
   */
  it('keeps going after a task rejects, and reports which failed', async () => {
    const t = tracker();
    const settled: Settled<string>[] = [];
    const pool = new Pool({ size: 2, queueLimit: 10 });

    for (let i = 0; i < 6; i++) {
      await pool.submit(t.task(String(i), 2, i === 2), (s) => settled.push(s));
    }
    await pool.drain();

    expect(settled).toHaveLength(6);
    expect(failures(settled)).toHaveLength(1);
    expect(failures(settled)[0]?.message).toBe('boom 2');
    expect(values(settled)).toHaveLength(5);
  });

  it('survives a settle handler that throws', async () => {
    const pool = new Pool({ size: 2 });
    let second = false;

    await pool.submit(
      () => Promise.resolve(1),
      () => {
        throw new Error('handler is buggy');
      }
    );
    await pool.submit(
      () => Promise.resolve(2),
      () => {
        second = true;
      }
    );
    await pool.drain();

    expect(second).toBe(true);
  });

  it('converts a non-Error throw into an Error', async () => {
    const pool = new Pool({ size: 1 });
    let captured: Settled<never> | null = null;

    await pool.submit<never>(
      () => Promise.reject('a bare string'),
      (s) => {
        captured = s;
      }
    );
    await pool.drain();

    expect(captured).not.toBeNull();
    const result = captured as unknown as Settled<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});

describe('Pool — backpressure', () => {
  /**
   * Without this, feeding the pool from a walk of 20,000 files buffers 20,000
   * pending tasks and the "streamed progress" of M1 becomes a memory spike.
   */
  it('makes submit wait once the queue is full', async () => {
    const pool = new Pool({ size: 1, queueLimit: 1 });

    // A latch rather than a list of resolvers: a task that only STARTS after
    // the list was drained would otherwise block forever, which is a deadlock
    // in the test rather than in the pool.
    let open = false;
    const waiting: (() => void)[] = [];
    const block = (): Promise<void> =>
      new Promise<void>((resolve) => (open ? resolve() : waiting.push(resolve)));
    const releaseOne = (): void => waiting.shift()?.();
    const releaseAll = (): void => {
      open = true;
      for (const resolve of waiting.splice(0)) resolve();
    };

    await pool.submit(block, () => undefined); // runs
    await pool.submit(block, () => undefined); // queued, filling the queue

    let admitted = false;
    const third = pool.submit(block, () => undefined).then(() => {
      admitted = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(admitted).toBe(false); // still waiting for room

    releaseOne();
    await third;
    expect(admitted).toBe(true);

    releaseAll();
    await pool.drain();
  });
});

describe('Pool — cancellation', () => {
  it('drops queued work when isCancelled flips', async () => {
    let cancelled = false;
    const settled: Settled<number>[] = [];
    const pool = new Pool({ size: 1, queueLimit: 10, isCancelled: () => cancelled });

    await pool.submit(
      async () => {
        cancelled = true;
        return 1;
      },
      (s) => settled.push(s)
    );
    for (let i = 0; i < 4; i++) {
      await pool.submit(() => Promise.resolve(i), (s) => settled.push(s));
    }
    await pool.drain();

    expect(settled[0]?.ok).toBe(true);
    expect(settled.slice(1).every((s) => !s.ok)).toBe(true);
  });

  it('aborts running tasks through their signal', async () => {
    const controller = new AbortController();
    const pool = new Pool({ size: 1, signal: controller.signal });
    let sawAbort = false;

    const task = (signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
        setTimeout(resolve, 1000);
      });

    await pool.submit(task, () => undefined);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await pool.drain();

    expect(sawAbort).toBe(true);
  });

  /**
   * PRA-M1b R3. A subprocess that hangs must not hold a worker for the life of
   * the process. Driven by a manual clock, so it is instant and deterministic.
   */
  it('times out a task that never settles', async () => {
    const clock = manualClock();
    const pool = new Pool({ size: 1, taskTimeoutMs: 1000, clock });
    let captured: Settled<never> | null = null;

    const never = (): Promise<never> => new Promise(() => undefined);
    const submitted = pool.submit<never>(never, (s) => {
      captured = s;
    });

    await submitted;
    await clock.advance(1001);
    await pool.drain();

    const result = captured as unknown as Settled<never> | null;
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error.message).toMatch(/exceeded 1000ms/);
  });

  it('does not fire the timeout for a task that finishes in time', async () => {
    const clock = manualClock();
    const pool = new Pool({ size: 1, taskTimeoutMs: 1000, clock });
    const settled: Settled<string>[] = [];

    await pool.submit(() => Promise.resolve('quick'), (s) => settled.push(s));
    await pool.drain();
    await clock.advance(5000);

    expect(settled).toEqual([{ ok: true, value: 'quick' }]);
    expect(clock.pending()).toBe(0);
  });
});

describe('mapPool', () => {
  it('returns results in INPUT order, not completion order', async () => {
    const delays = [30, 1, 20, 2, 10];
    const settled = await mapPool(
      delays,
      async (ms, _signal) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      },
      { size: 5 }
    );

    expect(values(settled)).toEqual(delays);
  });

  it('marks individual failures without losing the successes around them', async () => {
    const settled = await mapPool(
      [1, 2, 3, 4],
      (n) => (n === 3 ? Promise.reject(new Error('three')) : Promise.resolve(n * 10)),
      { size: 2 }
    );

    expect(settled.map((s) => s.ok)).toEqual([true, true, false, true]);
    expect(values(settled)).toEqual([10, 20, 40]);
  });

  it('accepts an async iterable, so a walk can be fed straight in', async () => {
    async function* source(): AsyncGenerator<number> {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        yield i;
      }
    }

    const settled = await mapPool(source(), (n) => Promise.resolve(n * 2), { size: 2 });
    expect(values(settled)).toEqual([0, 2, 4, 6, 8]);
  });

  it('bounds concurrency over an async iterable too', async () => {
    const t = tracker();
    async function* source(): AsyncGenerator<number> {
      for (let i = 0; i < 10; i++) yield i;
    }

    await mapPool(source(), (n) => t.task(String(n), 3)(), { size: 2, queueLimit: 2 });
    expect(t.peak).toBe(2);
  });
});

describe('Pool — measured benefit', () => {
  /**
   * The AAR-M1 D3 claim, reduced to something a test can hold: a pool is a
   * large win on independent waiting work. The assertion is deliberately loose
   * (2× rather than 8×) because CI machines are not benchmark rigs — this
   * guards against the pool silently reverting to serial, not against a
   * performance regression of a few percent.
   */
  it('is materially faster than serial for waiting work', async () => {
    const jobs = Array.from({ length: 16 }, (_, i) => i);
    const work = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

    const t0 = Date.now();
    await mapPool(jobs, work, { size: 1, queueLimit: 16 });
    const serial = Date.now() - t0;

    const t1 = Date.now();
    await mapPool(jobs, work, { size: 8, queueLimit: 16 });
    const pooled = Date.now() - t1;

    expect(pooled).toBeLessThan(serial / 2);
  });
});

describe('Pool — drain', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const pool = new Pool({ size: 2 });
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  it('refuses work after abort instead of silently queueing it', async () => {
    const pool = new Pool({ size: 1 });
    const settle = vi.fn();

    pool.abort();
    await pool.submit(() => Promise.resolve(1), settle);

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]?.[0]).toMatchObject({ ok: false });
  });
});

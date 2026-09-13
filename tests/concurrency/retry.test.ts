import { describe, expect, it, vi } from 'vitest';
import { manualClock } from '../../src/main/concurrency/clock';
import { RateGate } from '../../src/main/concurrency/rate-gate';
import {
  HttpError,
  MalformedResponseError,
  backoffDelay,
  classify,
  isRetryable,
  retry,
} from '../../src/main/concurrency/retry';

/**
 * Classification is the part worth testing hardest. The cache policy and the
 * retry policy both read `classify`, so a mistake here does not just waste a
 * request — it can cache a failure as an answer (harness M-4) or retry a 404
 * forever against a 1 req/s budget (M-5).
 */

describe('classify', () => {
  it.each([
    [new HttpError(500), 'transient'],
    [new HttpError(502), 'transient'],
    [new HttpError(503), 'transient'],
    [new HttpError(429), 'rate-limited'],
    [new HttpError(404), 'negative'],
    [new HttpError(410), 'negative'],
    [new HttpError(400), 'malformed'],
    [new HttpError(401), 'malformed'],
    [new HttpError(403), 'malformed'],
    [new MalformedResponseError('bad json'), 'malformed'],
  ])('classifies %s', (error, expected) => {
    expect(classify(error)).toBe(expected);
  });

  it('treats a dropped socket as transient', () => {
    const e = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(classify(e)).toBe('transient');
  });

  it('treats a DNS hiccup as transient', () => {
    const e = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
    expect(classify(e)).toBe('transient');
  });

  it('treats an abort as its own thing, never retried', () => {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    expect(classify(e)).toBe('aborted');
    expect(isRetryable(e)).toBe(false);
  });

  it('does not retry a 404 — the answer will not change (M-5)', () => {
    expect(isRetryable(new HttpError(404))).toBe(false);
  });

  it('retries a 503 and a 429', () => {
    expect(isRetryable(new HttpError(503))).toBe(true);
    expect(isRetryable(new HttpError(429))).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('doubles, with jitter disabled for determinism', () => {
    const opts = { baseMs: 100, maxMs: 10_000, jitter: 0 };
    expect(backoffDelay(1, opts)).toBe(100);
    expect(backoffDelay(2, opts)).toBe(200);
    expect(backoffDelay(3, opts)).toBe(400);
    expect(backoffDelay(4, opts)).toBe(800);
  });

  it('caps', () => {
    expect(backoffDelay(20, { baseMs: 100, maxMs: 5000, jitter: 0 })).toBe(5000);
  });

  /**
   * PRA-M1b R8. Without jitter, N failures retry in lockstep and the recovery
   * is a burst — the exact shape that earns a block from a rate-limited host.
   */
  it('spreads simultaneous retries instead of aligning them', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 200; i++) {
      delays.add(backoffDelay(3, { baseMs: 100, maxMs: 10_000, jitter: 0.5 }));
    }
    expect(delays.size).toBeGreaterThan(50);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(200); // >= 50% of 400
    expect(Math.max(...delays)).toBeLessThanOrEqual(400);
  });
});

describe('retry', () => {
  it('returns the first success without waiting', async () => {
    const clock = manualClock();
    const fn = vi.fn(() => Promise.resolve('ok'));

    await expect(retry(fn, { clock })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(0);
  });

  it('retries a transient failure and succeeds', async () => {
    const clock = manualClock();
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      return calls === 1 ? Promise.reject(new HttpError(503)) : Promise.resolve('ok');
    });

    const promise = retry(fn, { clock, baseMs: 1000, jitter: 0 });
    await clock.advance(2000);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after `attempts` and throws the last error', async () => {
    const clock = manualClock();
    const fn = vi.fn(() => Promise.reject(new HttpError(503, 'still down')));

    const promise = retry(fn, { clock, attempts: 3, baseMs: 100, jitter: 0 });
    const caught = promise.catch((e: unknown) => (e as Error).message);
    await clock.advance(10_000);

    await expect(caught).resolves.toBe('still down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry what is not worth retrying', async () => {
    const clock = manualClock();
    const fn = vi.fn(() => Promise.reject(new HttpError(404)));

    await expect(retry(fn, { clock, attempts: 5 })).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on abort', async () => {
    const clock = manualClock();
    const controller = new AbortController();
    const fn = vi.fn(() => Promise.reject(new HttpError(503)));

    const promise = retry(fn, { clock, attempts: 5, baseMs: 1000, jitter: 0, signal: controller.signal });
    const caught = promise.catch((e: unknown) => (e as Error).name);

    await clock.tick();
    controller.abort();
    await clock.advance(10_000);

    await expect(caught).resolves.toBe('AbortError');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After over its own curve', async () => {
    const clock = manualClock();
    const at: number[] = [];
    let calls = 0;
    const fn = vi.fn(() => {
      at.push(clock.now());
      calls++;
      return calls === 1
        ? Promise.reject(new HttpError(429, 'slow down', 7000))
        : Promise.resolve('ok');
    });

    const promise = retry(fn, { clock, baseMs: 100, jitter: 0 });
    await clock.advance(10_000);

    await expect(promise).resolves.toBe('ok');
    expect(at).toEqual([0, 7000]);
  });

  /**
   * PRA-M1b R8, the structural half: retries go back through the same gate as
   * first attempts. Without this, three failures against MusicBrainz produce
   * three retries that ignore the 1 req/s limit entirely.
   */
  it('acquires the gate before EVERY attempt, retries included', async () => {
    const clock = manualClock();
    const gate = new RateGate({ minIntervalMs: 1000, clock });
    const at: number[] = [];
    let calls = 0;

    const fn = (): Promise<string> => {
      at.push(clock.now());
      calls++;
      return calls < 3 ? Promise.reject(new HttpError(503)) : Promise.resolve('ok');
    };

    const promise = retry(fn, { clock, gate, attempts: 3, baseMs: 100, jitter: 0 });
    await clock.advance(20_000);

    await expect(promise).resolves.toBe('ok');
    // t=0 first attempt. Backoff 100 → t=100, but the gate holds it to 1000.
    // Backoff 200 → t=1200, gate holds it to 2000.
    expect(at).toEqual([0, 1000, 2000]);
    expect(gate.stats().dispatched).toBe(3);
  });

  it('reports each retry so a storm is visible rather than silent', async () => {
    const clock = manualClock();
    const seen: number[] = [];
    let calls = 0;
    const fn = (): Promise<string> => {
      calls++;
      return calls < 3 ? Promise.reject(new HttpError(503)) : Promise.resolve('ok');
    };

    const promise = retry(fn, {
      clock,
      attempts: 3,
      baseMs: 100,
      jitter: 0,
      onRetry: ({ attempt }) => seen.push(attempt),
    });
    await clock.advance(5000);
    await promise;

    expect(seen).toEqual([1, 2]);
  });

  it('passes the attempt number to the caller', async () => {
    const clock = manualClock();
    const attempts: number[] = [];
    let calls = 0;

    const promise = retry(
      (attempt) => {
        attempts.push(attempt);
        calls++;
        return calls < 3 ? Promise.reject(new HttpError(503)) : Promise.resolve('ok');
      },
      { clock, attempts: 3, baseMs: 10, jitter: 0 }
    );
    await clock.advance(1000);
    await promise;

    expect(attempts).toEqual([1, 2, 3]);
  });
});

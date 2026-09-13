import { describe, expect, it } from 'vitest';
import { manualClock } from '../../src/main/concurrency/clock';
import { Pool } from '../../src/main/concurrency/pool';
import { DEFAULT_HOST_LIMIT, HOST_LIMITS, RateGate, RateGateRegistry } from '../../src/main/concurrency/rate-gate';

/**
 * Every test here runs on a manual clock, so the suite proves the spacing
 * arithmetic rather than measuring the machine (PRA-M1b R9). A gate tested with
 * real timers is a gate tested with a tolerance, and a tolerance wide enough to
 * be stable is wide enough to hide the bug.
 */

describe('RateGate', () => {
  it('lets the first caller through immediately', async () => {
    const clock = manualClock(1000);
    const gate = new RateGate({ minIntervalMs: 1000, clock });

    let released = false;
    void gate.acquire().then(() => {
      released = true;
    });
    await clock.tick();

    expect(released).toBe(true);
    expect(clock.now()).toBe(1000);
  });

  it('spaces subsequent callers by the interval', async () => {
    const clock = manualClock(0);
    const gate = new RateGate({ minIntervalMs: 1000, clock });
    const at: number[] = [];

    for (let i = 0; i < 4; i++) void gate.acquire().then(() => at.push(clock.now()));

    await clock.advance(5000);
    expect(at).toEqual([0, 1000, 2000, 3000]);
  });

  it('admits in call order', async () => {
    const clock = manualClock(0);
    const gate = new RateGate({ minIntervalMs: 100, clock });
    const order: string[] = [];

    for (const label of ['a', 'b', 'c', 'd']) {
      void gate.acquire().then(() => order.push(label));
    }

    await clock.advance(1000);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('allows a burst after an idle period, then resumes spacing', async () => {
    const clock = manualClock(0);
    const gate = new RateGate({ minIntervalMs: 1000, burst: 3, clock });
    const at: number[] = [];

    for (let i = 0; i < 5; i++) void gate.acquire().then(() => at.push(clock.now()));
    await clock.advance(10_000);

    // Three immediately, then one per interval.
    expect(at).toEqual([0, 0, 0, 1000, 2000]);
  });

  it('refills the burst allowance while idle', async () => {
    const clock = manualClock(0);
    const gate = new RateGate({ minIntervalMs: 1000, burst: 2, clock });

    const first: number[] = [];
    for (let i = 0; i < 2; i++) void gate.acquire().then(() => first.push(clock.now()));
    await clock.advance(10_000);
    expect(first).toEqual([0, 0]);

    const second: number[] = [];
    for (let i = 0; i < 2; i++) void gate.acquire().then(() => second.push(clock.now()));
    await clock.advance(10_000);
    expect(second).toEqual([10_000, 10_000]);
  });

  it('is a no-op when the interval is zero', async () => {
    const clock = manualClock(0);
    const gate = new RateGate({ minIntervalMs: 0, clock });

    await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);
    expect(clock.now()).toBe(0);
    expect(gate.stats().dispatched).toBe(3);
  });

  it('reports wait time, which is the signal for a retry storm (R8)', async () => {
    const clock = manualClock(0);
    const gate = new RateGate({ minIntervalMs: 500, clock });

    for (let i = 0; i < 3; i++) void gate.acquire();
    await clock.advance(5000);

    const stats = gate.stats();
    expect(stats.dispatched).toBe(3);
    expect(stats.waitedMs).toBe(1500); // 0 + 500 + 1000
    expect(stats.maxWaitMs).toBe(1000);
  });

  it('rejects a waiting caller when its signal aborts', async () => {
    const clock = manualClock(0);
    const gate = new RateGate({ minIntervalMs: 1000, clock });
    const controller = new AbortController();

    void gate.acquire(); // takes the first slot
    const second = gate.acquire(controller.signal);
    const caught = second.catch((e: unknown) => (e as Error).name);

    controller.abort();
    await expect(caught).resolves.toBe('AbortError');
  });
});

describe('RateGate vs Pool — the M-6 result', () => {
  /**
   * PRA-M1b M-6, and the reason this module exists separately from the pool.
   * Eight workers against a rate-limited host finish no sooner than one. If
   * this test ever starts failing because pool 8 IS faster, someone has made
   * pool size into a rate control and the provider layer will start getting
   * blocked.
   */
  it('makes pool size irrelevant to completion time', async () => {
    const run = async (size: number): Promise<number> => {
      const clock = manualClock(0);
      const gate = new RateGate({ minIntervalMs: 1000, clock });
      const pool = new Pool({ size, queueLimit: 24 });
      const finishedAt: number[] = [];

      for (let i = 0; i < 12; i++) {
        await pool.submit(
          () => gate.acquire(),
          () => finishedAt.push(clock.now())
        );
      }

      const drained = pool.drain();
      await clock.advance(60_000);
      await drained;

      expect(finishedAt).toHaveLength(12);
      return Math.max(...finishedAt);
    };

    // Twelve requests at one per second: the twelfth leaves at t=11s, whether
    // one worker is asking or eight.
    expect(await run(1)).toBe(11_000);
    expect(await run(8)).toBe(11_000);
  });
});

describe('RateGateRegistry', () => {
  it('returns the same gate for the same host', () => {
    const registry = new RateGateRegistry({ clock: manualClock() });
    expect(registry.for('musicbrainz.org')).toBe(registry.for('musicbrainz.org'));
    expect(registry.for('musicbrainz.org')).not.toBe(registry.for('coverartarchive.org'));
  });

  it('applies the published MusicBrainz limit of one per second', () => {
    const registry = new RateGateRegistry({ clock: manualClock() });
    expect(registry.for('musicbrainz.org').minIntervalMs).toBe(1000);
    expect(HOST_LIMITS['musicbrainz.org']?.burst).toBe(1);
  });

  it('falls back to a cautious default for an unlisted host', () => {
    const registry = new RateGateRegistry({ clock: manualClock() });
    const gate = registry.for('some-new-provider.example');
    expect(gate.minIntervalMs).toBe(DEFAULT_HOST_LIMIT.minIntervalMs);
  });

  it('derives the host from a URL', () => {
    const registry = new RateGateRegistry({ clock: manualClock() });
    expect(registry.forUrl('https://musicbrainz.org/ws/2/release/x')).toBe(registry.for('musicbrainz.org'));
  });

  it('does not throw on a malformed URL', () => {
    const registry = new RateGateRegistry({ clock: manualClock() });
    expect(() => registry.forUrl('not a url')).not.toThrow();
  });
});

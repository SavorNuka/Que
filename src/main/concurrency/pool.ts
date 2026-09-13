import { AbortError, systemClock, type Clock } from './clock';

/**
 * A bounded work pool.
 *
 * AAR-M1 D3 measured a cold scan at 98% ffprobe wait, serial: 43.5 ms/file,
 * ~14.5 min at 20,000 files. PRA-M1b M-6 measured what a pool buys and where:
 * 8× on local work like ffprobe, nothing at all against a rate-limited
 * provider. So this is the right tool for ffprobe and the wrong tool for
 * MusicBrainz — that one needs the RateGate, and pool size must never be used
 * as a rate control.
 *
 * Four properties, each of which has a test:
 *
 *  1. **Bounded.** Never more than `size` tasks in flight.
 *  2. **Error-isolated.** A rejecting task settles as a failure and the pool
 *     keeps going. Nothing thrown by one file can end a scan of 20,000.
 *  3. **Backpressured.** `submit` waits when the queue is full, so feeding the
 *     pool from a walk of a huge directory tree cannot buffer the whole tree.
 *  4. **Cancellable.** Queued tasks are dropped, running tasks get a signal.
 */

export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

export type Task<T> = (signal: AbortSignal) => Promise<T>;

export interface PoolOptions {
  /** Maximum tasks in flight. */
  size: number;
  /**
   * Maximum tasks admitted but not yet started before `submit` starts waiting.
   * Defaults to `size`, which keeps one full batch queued behind the workers.
   */
  queueLimit?: number;
  /** Polled before each task starts, for cooperative cancellation. */
  isCancelled?: () => boolean;
  /** External cancellation; aborts queued and running work. */
  signal?: AbortSignal;
  /**
   * Backstop for a task that never settles (PRA-M1b R3). A hung subprocess
   * would otherwise occupy a worker for the life of the process.
   */
  taskTimeoutMs?: number;
  clock?: Clock;
}

export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

interface Queued<T> {
  task: Task<T>;
  settle: (s: Settled<T>) => void;
}

export class Pool {
  readonly size: number;

  #queue: Queued<unknown>[] = [];
  #active = 0;
  #roomWaiters: (() => void)[] = [];
  #drainWaiters: (() => void)[] = [];
  #controller = new AbortController();
  #queueLimit: number;
  #isCancelled: (() => boolean) | undefined;
  #taskTimeoutMs: number | undefined;
  #clock: Clock;
  #closed = false;

  constructor(options: PoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new Error(`Pool size must be a positive integer, got ${String(options.size)}`);
    }
    this.size = options.size;
    this.#queueLimit = options.queueLimit ?? options.size;
    this.#isCancelled = options.isCancelled;
    this.#taskTimeoutMs = options.taskTimeoutMs;
    this.#clock = options.clock ?? systemClock;

    if (options.signal) {
      if (options.signal.aborted) this.abort(options.signal.reason);
      else options.signal.addEventListener('abort', () => this.abort(options.signal?.reason), { once: true });
    }
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get idle(): boolean {
    return this.#active === 0 && this.#queue.length === 0;
  }

  /**
   * Admit a task. Resolves once there is room in the queue — NOT when the task
   * finishes. The result arrives via `settle`, which is called exactly once and
   * never throws out of the pool.
   */
  async submit<T>(task: Task<T>, settle: (s: Settled<T>) => void): Promise<void> {
    if (this.#closed) {
      settle({ ok: false, error: new AbortError('Pool is closed') });
      return;
    }

    while (this.#queue.length >= this.#queueLimit && !this.#closed) {
      await new Promise<void>((resolve) => this.#roomWaiters.push(resolve));
    }

    if (this.#closed) {
      settle({ ok: false, error: new AbortError('Pool is closed') });
      return;
    }

    this.#queue.push({ task, settle } as unknown as Queued<unknown>);
    this.#pump();
  }

  /** Resolves when everything admitted so far has finished. */
  async drain(): Promise<void> {
    if (this.idle) return;
    await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
  }

  /**
   * Stop. Queued tasks are settled as failures without running; running tasks
   * see their signal abort and are expected to give up.
   */
  abort(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;

    const error = reason instanceof Error ? reason : new AbortError(typeof reason === 'string' ? reason : undefined);

    const dropped = this.#queue;
    this.#queue = [];
    for (const item of dropped) this.#safeSettle(item, { ok: false, error });

    this.#controller.abort(error);
    this.#release(this.#roomWaiters);
    if (this.idle) this.#release(this.#drainWaiters);
  }

  #pump(): void {
    while (this.#active < this.size && this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (!item) break;
      this.#release(this.#roomWaiters);
      this.#active++;
      void this.#run(item);
    }

    if (this.idle) this.#release(this.#drainWaiters);
  }

  async #run(item: Queued<unknown>): Promise<void> {
    try {
      if (this.#isCancelled?.() || this.#closed) {
        this.#safeSettle(item, { ok: false, error: new AbortError() });
        return;
      }

      const value = await this.#withTimeout(item.task);
      this.#safeSettle(item, { ok: true, value });
    } catch (e) {
      this.#safeSettle(item, { ok: false, error: asError(e) });
    } finally {
      this.#active--;
      this.#pump();
    }
  }

  async #withTimeout(task: Task<unknown>): Promise<unknown> {
    if (this.#taskTimeoutMs === undefined) return task(this.#controller.signal);

    // A per-task controller so one timeout does not abort the whole pool, but
    // a pool-wide abort still reaches the task.
    const local = new AbortController();
    const onPoolAbort = (): void => local.abort(this.#controller.signal.reason);
    this.#controller.signal.addEventListener('abort', onPoolAbort, { once: true });

    const timer = new AbortController();
    const message = `Task exceeded ${String(this.#taskTimeoutMs)}ms`;

    /**
     * The timeout RACES the task rather than only aborting it. A cooperative
     * task gives up when its signal fires; an uncooperative one — a subprocess
     * wrapper that never settles, which is exactly the R3 case — would
     * otherwise hold this worker for the life of the process.
     */
    const expiry = new Promise<never>((_resolve, reject) => {
      this.#clock
        .sleep(this.#taskTimeoutMs ?? 0, timer.signal)
        .then(() => {
          local.abort(new Error(message));
          reject(new Error(message));
        })
        .catch(() => {
          /* the timer was cancelled because the task finished first */
        });
    });

    try {
      return await Promise.race([task(local.signal), expiry]);
    } finally {
      timer.abort();
      this.#controller.signal.removeEventListener('abort', onPoolAbort);
    }
  }

  #safeSettle(item: Queued<unknown>, s: Settled<unknown>): void {
    try {
      item.settle(s);
    } catch {
      // A throwing settle handler is the caller's bug and must not take the
      // pool down with it.
    }
  }

  #release(waiters: (() => void)[]): void {
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) resolve();
  }
}

/**
 * Run `fn` over `items` with bounded concurrency, returning results **in input
 * order** regardless of completion order, each marked ok or failed.
 *
 * Accepts an async iterable, so a directory walk can be fed straight in and
 * backpressure keeps memory flat.
 */
export async function mapPool<T, R>(
  items: Iterable<T> | AsyncIterable<T>,
  fn: (item: T, signal: AbortSignal) => Promise<R>,
  options: PoolOptions
): Promise<Settled<R>[]> {
  const pool = new Pool(options);
  const results: Settled<R>[] = [];
  let index = 0;

  for await (const item of items as AsyncIterable<T>) {
    const at = index++;
    results[at] = { ok: false, error: new AbortError('Never ran') };
    await pool.submit<R>(
      (signal) => fn(item, signal),
      (s) => {
        results[at] = s;
      }
    );
  }

  await pool.drain();
  return results;
}

/** The values from a mapPool run, dropping failures. */
export function values<R>(settled: Settled<R>[]): R[] {
  return settled.filter((s): s is { ok: true; value: R } => s.ok).map((s) => s.value);
}

/** The failures from a mapPool run. */
export function failures<R>(settled: Settled<R>[]): Error[] {
  return settled.filter((s): s is { ok: false; error: Error } => !s.ok).map((s) => s.error);
}

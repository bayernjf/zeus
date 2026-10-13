/**
 * E1.5 concurrency gate.
 *
 * The kernel used to dispatch every branch of every intent at once
 * (`Promise.all`), so "concurrency control" meant nothing and the queue-depth
 * metric was permanently 0. This is the smallest thing that makes both true:
 * a fixed number of leases, a FIFO wait line, and a bound on how many branches
 * may stand in it (`queueLimit`; further arrivals are refused with
 * QueueFullError).
 *
 * A queued waiter can be released from the line in two opt-in ways: an
 * AbortSignal passed to `acquire` rejects the wait with
 * QueueWaitCancelledError, and a `timeoutMs` deadline rejects it with
 * QueueWaitTimeoutError. A released waiter is removed from the FIFO line and
 * never consumes a later slot. Without those options the wait is unbounded;
 * `queueLimit` remains the last global backstop against an unbounded line, not
 * a per-waiter deadline.
 *
 * One semaphore per Orchestrator, which is per process in the long-running
 * assembly - so the cap bounds in-flight branches across all intents, which is
 * what protects a shared downstream vassal.
 */

export type SlotRelease = () => void;

export interface AcquireOptions {
  /** Aborting while queued rejects the wait with QueueWaitCancelledError. */
  signal?: AbortSignal;
  /** Reject the wait with QueueWaitTimeoutError after this many milliseconds. */
  timeoutMs?: number;
}

/** The gate is at capacity and no queue room is left. */
export class QueueFullError extends Error {
  constructor(readonly maxConcurrent: number, readonly queueLimit: number) {
    super(
      `concurrency limit ${maxConcurrent} reached with ${queueLimit} queued branch slot(s) full`,
    );
    this.name = 'QueueFullError';
  }
}

/** The wait for a slot was cancelled via AbortSignal before a lease was granted. */
export class QueueWaitCancelledError extends Error {
  constructor() {
    super('branch slot wait cancelled before a lease was granted');
    this.name = 'QueueWaitCancelledError';
  }
}

/** The wait for a slot outlasted its caller-supplied deadline. */
export class QueueWaitTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out waiting for a branch slot after ${timeoutMs}ms`);
    this.name = 'QueueWaitTimeoutError';
  }
}

interface Waiter {
  resolve: (release: SlotRelease) => void;
  reject: (error: Error) => void;
  settled: boolean;
  cleanup: () => void;
}

export class Semaphore {
  private running = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly max: number,
    private readonly queueLimit: number = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`semaphore needs a whole max of at least 1, got ${String(max)}`);
    }
    // A non-integer or negative queueLimit is not a limit this class can honour:
    // `waiters.length >= NaN` is never true, so the queue silently becomes
    // unbounded. Refuse it at construction instead.
    if (!(queueLimit === Number.POSITIVE_INFINITY || (Number.isInteger(queueLimit) && queueLimit >= 0))) {
      throw new Error(`semaphore queue limit must be a whole number of at least 0 (or Infinity), got ${String(queueLimit)}`);
    }
  }

  /** Leases currently held. */
  get active(): number {
    return this.running;
  }

  /** Branches waiting for a lease. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Resolve with a release callback, or reject when the wait line is full. */
  acquire(options: AcquireOptions = {}): Promise<SlotRelease> {
    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      return Promise.reject(new QueueWaitCancelledError());
    }
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve(this.lease());
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(new QueueFullError(this.max, this.queueLimit));
    }
    return new Promise<SlotRelease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false, cleanup: () => {} };

      const releaseFromLine = (error: Error): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.cleanup();
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(error);
      };

      const onAbort = (): void => releaseFromLine(new QueueWaitCancelledError());
      signal?.addEventListener('abort', onAbort, { once: true });

      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => releaseFromLine(new QueueWaitTimeoutError(timeoutMs)), timeoutMs);
        timer.unref();
      }
      waiter.cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) clearTimeout(timer);
      };

      this.waiters.push(waiter);
    });
  }

  private lease(): SlotRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.handOff();
    };
  }

  private handOff(): void {
    while (this.running < this.max && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.settled = true;
      next.cleanup();
      this.running += 1;
      next.resolve(this.lease());
    }
  }
}

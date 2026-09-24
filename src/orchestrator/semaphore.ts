/**
 * E1.5 concurrency gate.
 *
 * The kernel used to dispatch every branch of every intent at once
 * (`Promise.all`), so "concurrency control" meant nothing and the queue-depth
 * metric was permanently 0. This is the smallest thing that makes both true:
 * a fixed number of leases, a FIFO wait line, and a hard limit on how long a
 * branch is willing to stand in it.
 *
 * One semaphore per Orchestrator, which is per process in the long-running
 * assembly - so the cap bounds in-flight branches across all intents, which is
 * what protects a shared downstream vassal.
 */

export type SlotRelease = () => void;

/** The gate is at capacity and no queue room is left. */
export class QueueFullError extends Error {
  constructor(readonly maxConcurrent: number, readonly queueLimit: number) {
    super(
      `concurrency limit ${maxConcurrent} reached with ${queueLimit} queued branch slot(s) full`,
    );
    this.name = 'QueueFullError';
  }
}

export class Semaphore {
  private running = 0;
  private readonly waiters: Array<{
    resolve: (release: SlotRelease) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(
    private readonly max: number,
    private readonly queueLimit: number = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`semaphore needs a whole max of at least 1, got ${String(max)}`);
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
  acquire(): Promise<SlotRelease> {
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve(this.lease());
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(new QueueFullError(this.max, this.queueLimit));
    }
    return new Promise<SlotRelease>((resolve, reject) => this.waiters.push({ resolve, reject }));
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
      this.running += 1;
      next.resolve(this.lease());
    }
  }
}

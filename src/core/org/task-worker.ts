/**
 * In-process asynchronous task worker (T-M7-01/#11). Decouples claiming a
 * task (HTTP request: match → dispatched → running, persisted) from executing
 * it (the hardened runner, which may block on retries or decision checkpoints).
 *
 * Concurrency model: a single worker drains an in-memory FIFO queue serially —
 * at most one task executes at a time within the process, and a task is never
 * enqueued twice (queued or active). On start the worker recovers every task
 * left in `running` (a claimed task interrupted by a crash) and re-runs it;
 * durable action/decision idempotency prevents duplicate side effects.
 *
 * Scope: this is a single-process scheduler. Multi-process leasing / fencing
 * (locked_by, locked_at with TTL) is a later hardening slice; for now run one
 * worker per deployment.
 */
import type { OrgService } from './org-service.js';
import type { OrgTaskExecutor } from './org-service.js';

export interface TaskWorkerDeps {
  org: OrgService;
  executor: OrgTaskExecutor;
  /** Interval for the periodic drain/recovery sweep (ms). */
  intervalMs?: number;
  /** Notified when a queued task fails to settle; the task itself is failed. */
  onError?: (taskId: string, error: unknown) => void;
  /** Clock/queueing hooks, primarily for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_INTERVAL_MS = 1000;

export class TaskWorker {
  private readonly org: OrgService;
  private readonly executor: OrgTaskExecutor;
  private readonly intervalMs: number;
  private readonly onError: ((taskId: string, error: unknown) => void) | undefined;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pumping = false;
  private started = false;

  constructor(deps: TaskWorkerDeps) {
    this.org = deps.org;
    this.executor = deps.executor;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onError = deps.onError;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Number of tasks queued but not yet executing (tests/observability). */
  get pending(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Start the worker: recover interrupted tasks and begin draining. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.recover();
    this.timer = this.setIntervalFn(() => {
      void this.pump();
    }, this.intervalMs);
    // Do not keep the process alive solely for the sweep timer.
    (this.timer as { unref?: () => void })?.unref?.();
    void this.pump();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  /** Enqueue a claimed task for execution; duplicate enqueues are ignored. */
  enqueue(taskId: string): void {
    if (this.queue.includes(taskId) || this.active.has(taskId)) return;
    this.queue.push(taskId);
    if (this.started) void this.pump();
  }

  /** Re-enqueue every task left in `running` (crash recovery). */
  recover(): void {
    for (const task of this.org.listTasks()) {
      if (task.status === 'running' && !this.queue.includes(task.id) && !this.active.has(task.id)) {
        this.queue.push(task.id);
      }
    }
  }

  /** Drain the queue serially until empty. Safe to call repeatedly. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const taskId = this.queue.shift() as string;
        if (this.active.has(taskId)) continue;
        this.active.add(taskId);
        try {
          await this.org.runClaimed(taskId, this.executor);
        } catch (error) {
          this.onError?.(taskId, error);
        } finally {
          this.active.delete(taskId);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Test/helper: wait until the queue is empty and no task is executing.
   * Because pump schedules work on the microtask/await chain, poll on the
   * event loop until settled.
   */
  async drain(): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    for (;;) {
      if (this.queue.length === 0 && this.active.size === 0 && !this.pumping) return;
      await sleep(2);
    }
  }
}

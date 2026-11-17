/**
 * In-process asynchronous task worker (T-M7-01/#11). Decouples claiming a
 * task (HTTP request: match → dispatched → running, persisted) from executing
 * it (the hardened runner, which may block on retries or decision checkpoints).
 *
 * Concurrency model (F1.1): the queue is split into one FIFO bucket per
 * position, so tasks of the same position keep strict submission order while
 * different positions may run in parallel. Total concurrency is bounded by
 * `concurrencyLimit` on the organization (default 2; 1 reproduces the original
 * serial drain). A task is never enqueued twice (queued or active). On start
 * the worker recovers every task left in `running` (a claimed task interrupted
 * by a crash) and re-runs it; durable action/decision idempotency prevents
 * duplicate side effects.
 *
 * Known limitation: the hardened runner settles retries inside `runClaimed`,
 * so a task waiting on retry backoff still holds its slot. Releasing the slot
 * across backoff is a later slice; the acceptance criteria for F1.1 cover
 * per-position ordering and the bounded parallel window only.
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
  /** F1.1: fallback concurrency when the task's organization sets none (default 2). */
  concurrencyLimit?: number;
  /** Notified when a queued task fails to settle; the task itself is failed. */
  onError?: (taskId: string, error: unknown) => void;
  /** Clock/queueing hooks, primarily for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_CONCURRENCY = 2;
/** Bucket for tasks whose position is not bound yet (never dispatched). */
const UNASSIGNED = '__unassigned__';

export class TaskWorker {
  private readonly org: OrgService;
  private readonly executor: OrgTaskExecutor;
  private readonly intervalMs: number;
  private readonly defaultLimit: number;
  private readonly onError: ((taskId: string, error: unknown) => void) | undefined;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  /** Per-position FIFO buckets; a bucket holds only queued task ids. */
  private readonly buckets = new Map<string, string[]>();
  /** Every queued or active task id, for duplicate suppression. */
  private readonly known = new Set<string>();
  /** Task id → effective concurrency limit of its organization. */
  private readonly limitByTask = new Map<string, number>();
  private readonly active = new Set<string>();
  /** Tasks currently executing per bucket; >0 keeps the bucket out of the pump. */
  private readonly activeByBucket = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pumping = false;
  private started = false;

  constructor(deps: TaskWorkerDeps) {
    this.org = deps.org;
    this.executor = deps.executor;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.defaultLimit = deps.concurrencyLimit ?? DEFAULT_CONCURRENCY;
    this.onError = deps.onError;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Number of tasks queued but not yet executing (tests/observability). */
  get pending(): number {
    let total = 0;
    for (const ids of this.buckets.values()) total += ids.length;
    return total;
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
    if (this.known.has(taskId)) return;
    this.schedule(taskId);
    if (this.started) void this.pump();
  }

  /** Re-enqueue every task left in `running` (crash recovery). */
  recover(): void {
    for (const task of this.org.listTasks()) {
      if (task.status === 'running' && !this.known.has(task.id)) this.schedule(task.id);
    }
  }

  /** Place one task into its position bucket and resolve its concurrency limit. */
  private schedule(taskId: string): void {
    let task;
    try {
      task = this.org.getTask(taskId);
    } catch {
      // Unknown id: queue it anyway so the failed runClaimed surfaces through
      // onError instead of being silently dropped.
      const unassigned = this.buckets.get(UNASSIGNED) ?? [];
      unassigned.push(taskId);
      this.buckets.set(UNASSIGNED, unassigned);
      this.known.add(taskId);
      this.limitByTask.set(taskId, this.defaultLimit);
      return;
    }
    const bucket = task.positionId ?? UNASSIGNED;
    const bucketQueue = this.buckets.get(bucket) ?? [];
    bucketQueue.push(taskId);
    this.buckets.set(bucket, bucketQueue);
    this.known.add(taskId);
    const org = this.org.getOrganization(task.organizationId);
    this.limitByTask.set(taskId, org.concurrencyLimit ?? this.defaultLimit);
  }

  /** Effective bound: never exceed any involved organization's own limit. */
  private limit(): number {
    let limit = this.defaultLimit;
    for (const taskId of this.known) {
      const taskLimit = this.limitByTask.get(taskId);
      if (taskLimit !== undefined && taskLimit < limit) limit = taskLimit;
    }
    return limit;
  }

  /**
   * Launch every runnable task, then return. Each settlement re-enters the
   * pump, so the sweep timer and completions both drive progress.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let launched = true;
      while (launched) {
        launched = false;
        if (this.active.size >= this.limit()) break;
        for (const [bucket, ids] of this.buckets) {
          if (this.active.size >= this.limit()) break;
          if ((this.activeByBucket.get(bucket) ?? 0) > 0) continue; // keep per-position order
          const taskId = ids.shift();
          if (taskId === undefined) {
            this.buckets.delete(bucket);
            continue;
          }
          if (ids.length === 0) this.buckets.delete(bucket);
          if (this.active.has(taskId)) continue;
          this.active.add(taskId);
          this.activeByBucket.set(bucket, (this.activeByBucket.get(bucket) ?? 0) + 1);
          launched = true;
          void this.execute(taskId, bucket);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(taskId: string, bucket: string): Promise<void> {
    try {
      await this.org.runClaimed(taskId, this.executor);
    } catch (error) {
      this.onError?.(taskId, error);
    } finally {
      this.active.delete(taskId);
      const remaining = (this.activeByBucket.get(bucket) ?? 1) - 1;
      if (remaining > 0) this.activeByBucket.set(bucket, remaining);
      else this.activeByBucket.delete(bucket);
      this.known.delete(taskId);
      this.limitByTask.delete(taskId);
      // A settlement frees a slot; re-enter the pump on the microtask queue so
      // the running loop always finishes its own bookkeeping first.
      if (this.started) queueMicrotask(() => void this.pump());
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
      if (this.pending === 0 && this.active.size === 0 && !this.pumping) return;
      await sleep(2);
    }
  }
}

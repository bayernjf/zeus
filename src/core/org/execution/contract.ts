/**
 * Tier0 M7 (T-M7-01) hardened OrgTaskExecutor contract.
 *
 * Replaces the M2 contract (run() returning a {complete|request} union) with a
 * callback-style, effect-sandboxed executor:
 *
 *   - the executor is linear code: it does work, optionally awaits a decision
 *     (ctx.requestDecision), reports progress (ctx.reportProgress), and ends by
 *     returning { outcome: 'complete' };
 *   - every external effect goes through the context (ctx.tool / ctx.action /
 *     ctx.requestDecision), so the framework can enforce tool authority,
 *     deadlines, retry budgets and idempotency regardless of executor code;
 *   - a blocked decision is a suspension (CheckpointSuspension), captured by
 *     the runner to persist awaiting_decision; resume re-runs the task and the
 *     already-resolved decision is replayed by its idempotency key, while
 *     already-performed actions are returned rather than re-executed.
 *
 * This module is pure types plus the minimal ports the runner needs (decision
 * creation, tool invocation, idempotent action storage, progress sink). The
 * durable orchestration (queueing, restart, persistence) is a later slice;
 * here the contract is fully exercised in memory.
 */
import type { Json, OrgTask, Position } from '../types.js';
import type { DecisionRequest } from '../../grading/policy.js';
import type { DecisionRecord } from '../../decision-service/types.js';
import type { RetryPolicy } from './backoff.js';
import type { CredentialRef } from './credentials.js';

/** A non-pausing progress report; the runner stamps `at`. */
export interface ExecutionProgress {
  stage: string;
  /** 0..100 when known; omit for stage-only updates. */
  percent?: number;
  data?: Json;
}

/** A progress record as persisted on the task. */
export interface StoredProgress extends ExecutionProgress {
  at: string;
}

/** Decision request from the executor; domain is prefilled by the runner. */
export type ExecutorDecisionRequest = Omit<DecisionRequest, 'domain'> & { domain?: string };

/** JSON-serializable result of a tool call or idempotent action. */
export type EffectResult = Json;

/**
 * The framework-invoked surface that actually performs a tool. Adapters
 * (T-M7-02: agent-world / commerce) implement this; it is the only place that
 * holds channel clients and resolves credentials. The runner never calls the
 * executor's own reach for the network.
 */
export interface ToolInvoker {
  invoke(tool: string, args: Record<string, unknown>, ctx: ExecutorContext): Promise<EffectResult>;
}

/** Minimal decision port satisfied by DecisionService. */
export interface DecisionPort {
  createDecision(req: DecisionRequest): Promise<DecisionRecord>;
}

/** Storage of already-completed idempotent actions (for retry / replay). */
export interface ActionResultStore {
  get(key: string): { ok: true; value: EffectResult } | { ok: false };
  put(key: string, value: EffectResult): void;
}

/** In-memory ActionResultStore used by tests and the synchronous runner. */
export class InMemoryActionStore implements ActionResultStore {
  private readonly done = new Map<string, EffectResult>();

  get(key: string): { ok: true; value: EffectResult } | { ok: false } {
    if (this.done.has(key)) return { ok: true, value: this.done.get(key) as EffectResult };
    return { ok: false };
  }

  put(key: string, value: EffectResult): void {
    this.done.set(key, value);
  }
}

/**
 * Execution context handed to the executor. Every member is provided by the
 * runner; the executor must not construct credentials or channel clients.
 */
export interface ExecutorContext {
  task: OrgTask;
  position: Position;
  agentId: string;
  /** True when re-invoked after a blocked decision was resolved. */
  resumed: boolean;
  /** Tools granted to the bound position (== position.allowedTools). */
  allowedTools: readonly string[];
  /** Credential references available to this run; never the secret value. */
  credentialRefs: readonly CredentialRef[];
  /** Aborted when the task deadline elapses or the run is cancelled. */
  signal: AbortSignal;
  /** Remaining wall-clock budget in ms (0 once elapsed). */
  readonly remainingMs: number;

  /** Record a non-pausing progress / recovery point. */
  reportProgress(progress: ExecutionProgress): void;

  /**
   * Pause at a decision checkpoint. Auto-decided records resolve and return
   * immediately; blocked records throw CheckpointSuspension so the runner can
   * persist awaiting_decision. On replay the same idempotency key returns the
   * already-decided record.
   */
  requestDecision(req: ExecutorDecisionRequest): Promise<DecisionRecord>;

  /**
   * Invoke a granted tool. Tool authority is enforced (denied →
   * ToolDeniedError, fail-closed, no retry) and the call is gated by the
   * deadline.
   */
  tool<T extends EffectResult = EffectResult>(name: string, args: Record<string, unknown>): Promise<T>;

  /**
   * Perform an idempotent side effect. `key` is unique within the task; on
   * retry or resume the stored result is returned without re-running fn. This
   * is what makes channel effects (publish listing, issue refund) happen at
   * most once across retries.
   */
  action<T extends EffectResult = EffectResult>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** V2 executor: linear run; returns once completed; suspends/fails via context. */
export interface OrgTaskExecutorV2 {
  run(ctx: ExecutorContext): Promise<ExecutorCompletion>;
}

export interface ExecutorCompletion {
  outcome: 'complete';
  result?: Json;
}

/** Terminal settlements produced by the runner. */
export type TaskSettlement =
  | { outcome: 'complete'; result?: Json; attempts: number }
  | { outcome: 'awaiting_decision'; decision: DecisionRecord; attempts: number }
  | {
      outcome: 'failed';
      failureKind: import('./errors.js').TaskFailureKind;
      error: string;
      attempts: number;
    };

/** A cancellable wait. The default implementation unrefs and clears its timer. */
export interface WaitHandle {
  promise: Promise<void>;
  /** Cancel the pending wait (used to release the deadline race once settled). */
  cancel(): void;
}

/** Injectable timing, all of which tests can make deterministic. */
export interface Timing {
  /** Monotonic ms for deadline math. */
  nowMs?: () => number;
  /** Wall clock ISO timestamp for progress records. */
  iso?: () => string;
  /** Cancellable timer used by both the deadline race and backoff. */
  wait?: (ms: number) => WaitHandle;
  /** RNG for backoff jitter. */
  rng?: () => number;
}

/** Full runner configuration. */
export interface RunTaskParams extends Timing {
  task: OrgTask;
  position: Position;
  agentId: string;
  resumed?: boolean;
  /** The decision that unblocked this resume, if any. */
  lastDecision?: DecisionRecord;
  executor: OrgTaskExecutorV2;
  /**
   * Decision port (DecisionService). Optional: when absent, reaching a
   * decision checkpoint fails as a business error (no decisions can be made).
   */
  decisions?: DecisionPort;
  /** Supplies the actual tool effect; absent → any tool call is denied. */
  toolInvoker?: ToolInvoker;
  credentialRefs?: CredentialRef[];
  retryPolicy?: RetryPolicy;
  /** Task-level wall-clock deadline across all attempts; default 10 min. */
  deadlineMs?: number;
  /** Cap on distinct decision points per task; default 10. */
  maxDecisionHops?: number;
  /** Pre-populated action results (resume / restart) and/or shared store. */
  actionStore?: ActionResultStore;
  onProgress?: (progress: StoredProgress) => void;
  /** External cancellation (e.g. owner abort). */
  abort?: AbortSignal;
}

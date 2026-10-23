/**
 * Tier0 M7 (T-M7-01) execution contract — failure taxonomy.
 *
 * The executor (an agent bound to a position) only reports two kinds of
 * explicit failure; everything else is a controlled outcome of the runner:
 *
 *   - retryable: a transient condition (upstream 5xx, timeout, lock). The
 *     runner retries with bounded exponential backoff; once the attempt
 *     budget is exhausted the task settles as failed/retryable_exhausted.
 *   - business: a definitive condition (out of stock, invalid input, policy
 *     forbids). The task settles immediately as failed/business with no retry.
 *
 * Needs-approval is NOT a failure and never goes through this taxonomy: the
 * executor reaches a decision point via `await ctx.requestDecision(req)` and
 * the runner pauses the task in awaiting_decision. The runner also owns the
 * remaining terminal conditions (timeout, tool denial) because the task must
 * not be able to bypass the framework-imposed limits by simply not reporting
 * them.
 */

/** Failure classes an executor is allowed to report itself. */
export type ExecutorErrorKind = 'retryable' | 'business';

/**
 * The executor reports an explicit, classified failure. Any other thrown
 * value (a plain `Error`, a string, a non-Error) is treated as retryable by
 * the runner only when the policy allows it; unknown errors never masquerade
 * as clean business failures.
 */
export class ExecutorError extends Error {
  readonly kind: ExecutorErrorKind;
  /** Optional structured detail persisted with the task for replay. */
  readonly detail?: Record<string, unknown>;

  constructor(
    kind: ExecutorErrorKind,
    message: string,
    opts: { detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ExecutorError';
    this.kind = kind;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }

  static retryable(message: string, opts?: { detail?: Record<string, unknown>; cause?: unknown }): ExecutorError {
    return new ExecutorError('retryable', message, opts);
  }

  static business(message: string, opts?: { detail?: Record<string, unknown>; cause?: unknown }): ExecutorError {
    return new ExecutorError('business', message, opts);
  }
}

/**
 * The executor invoked a tool the bound position does not grant. This is a
 * security fail-closed: it terminates the run immediately, is never retried,
 * and settles as failed/tool_denied.
 */
export class ToolDeniedError extends Error {
  readonly tool: string;
  readonly grantedTools: readonly string[];

  constructor(tool: string, grantedTools: readonly string[]) {
    super(
      `tool "${tool}" is not granted to this position (allowed: ${grantedTools.join(', ') || 'none'})`,
    );
    this.name = 'ToolDeniedError';
    this.tool = tool;
    this.grantedTools = grantedTools;
  }
}

/**
 * The task-level wall-clock deadline elapsed. Owned by the runner, not the
 * executor: every effect-producing context hook refuses after the deadline,
 * so a task that ignores the clock cannot continue to cause effects.
 */
export class ExecutorTimeoutError extends Error {
  readonly deadlineMs: number;
  readonly elapsedMs: number;

  constructor(deadlineMs: number, elapsedMs: number) {
    super(`execution exceeded the ${deadlineMs}ms task deadline (elapsed ${elapsedMs}ms)`);
    this.name = 'ExecutorTimeoutError';
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Internal control signal (never a failure): `ctx.requestDecision` produced a
 * blocked/awaiting decision. The runner catches it to pause the task; the
 * executor is resumed by re-running with the resolved decision in place.
 */
import type { DecisionRecord } from '../../decision-service/types.js';

export class CheckpointSuspension extends Error {
  readonly decision: DecisionRecord;

  constructor(decision: DecisionRecord) {
    super(`paused at decision checkpoint ${decision.id} (${decision.grade})`);
    this.name = 'CheckpointSuspension';
    this.decision = decision;
  }
}

/**
 * Final failure classification written to the org task (`failedKind`).
 * business = definitive; retryable_exhausted = retries spent; timeout =
 * deadline elapsed; tool_denied = guardrail fail-closed.
 */
export type TaskFailureKind =
  | 'business'
  | 'retryable_exhausted'
  | 'timeout'
  | 'tool_denied';

/**
 * Tier0 M7 (T-M7-01) execution contract — bounded retry and deadline policy.
 *
 * Both limits are enforced by the runner around the executor, never by the
 * executor itself: a task cannot grant itself more attempts or more time. The
 * policy is deliberately pure (no timers / Math.random) so it is fully
 * deterministic under tests; the runner supplies the clock and a jitter
 * function.
 */

/** Bounded retry policy. `maxAttempts` counts the first attempt (>= 1). */
export interface RetryPolicy {
  /** Total attempts including the first run; 1 means no retry. */
  maxAttempts: number;
  /** Delay after the first failure, before attempt #2. */
  baseBackoffMs: number;
  /** Cap on any single delay. */
  maxBackoffMs: number;
  /** Exponential growth factor per consecutive failure. */
  factor: number;
  /** Jitter fraction of the computed delay, 0..1 (e.g. 0.2 = up to 20%). */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 200,
  maxBackoffMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

/** Default task-level wall-clock deadline, milliseconds. */
export const DEFAULT_TASK_DEADLINE_MS = 10 * 60_000;

/**
 * Default cap on distinct decision points a single task may traverse. A task
 * that chains more than this many (auto-decided or blocked) decisions is
 * failed by the framework rather than looping indefinitely. Replaying an
 * already-resolved decision on resume does not consume a hop.
 */
export const DEFAULT_MAX_DECISION_HOPS = 10;

/**
 * Delay before retrying after the given zero-based failed attempt
 * (attempt 0 failed → delay before attempt 1). Deterministic once `rng` is
 * supplied; equal jitter when rng is omitted (uses 0).
 */
export function backoffDelayMs(policy: RetryPolicy, failedAttempt: number, rng: () => number = () => 0): number {
  if (policy.maxAttempts <= 1) return 0;
  if (policy.factor < 1 || policy.baseBackoffMs < 0 || policy.maxBackoffMs < policy.baseBackoffMs) {
    // Misconfigured policy fails safe: no retry delay but never negative.
    return 0;
  }
  const base = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * policy.factor ** failedAttempt);
  const spread = base * Math.min(1, Math.max(0, policy.jitter));
  return Math.round(base + rng() * spread);
}

/**
 * Whether another attempt is permitted after `failedAttempts` failures have
 * already occurred (each failed attempt counts as one). With maxAttempts=3:
 * 1 or 2 failures still leave attempts; 3 failures exhaust the budget.
 */
export function canRetry(policy: RetryPolicy, failedAttempts: number): boolean {
  return failedAttempts < policy.maxAttempts;
}

/** Whether the task deadline has elapsed at `nowMs`. */
export function deadlineExceeded(startedAtMs: number, nowMs: number, deadlineMs: number): boolean {
  return deadlineMs >= 0 && nowMs - startedAtMs >= deadlineMs;
}

/** Remaining budget, never negative. */
export function remainingBudgetMs(startedAtMs: number, nowMs: number, deadlineMs: number): number {
  return Math.max(0, deadlineMs - (nowMs - startedAtMs));
}

/** Validate a retry policy; returns the human-readable reason or undefined. */
export function validateRetryPolicy(p: RetryPolicy): string | undefined {
  if (!Number.isFinite(p.maxAttempts) || p.maxAttempts < 1 || !Number.isInteger(p.maxAttempts)) {
    return 'maxAttempts must be an integer >= 1';
  }
  if (!Number.isFinite(p.baseBackoffMs) || p.baseBackoffMs < 0) return 'baseBackoffMs must be >= 0';
  if (!Number.isFinite(p.maxBackoffMs) || p.maxBackoffMs < p.baseBackoffMs) {
    return 'maxBackoffMs must be >= baseBackoffMs';
  }
  if (p.factor < 1) return 'factor must be >= 1';
  if (p.jitter < 0 || p.jitter > 1) return 'jitter must be within 0..1';
  return undefined;
}

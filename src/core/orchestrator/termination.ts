/**
 * Termination and convergence guards (PRD E1.5 / tech map S4, design-supervision
 * §7.1): intent-level budget + consecutive-failure circuit breaker. Both are
 * fail-closed safety guards on top of the concurrency gate (which bounds what is
 * in flight; this bounds how much one intent may cumulatively spawn and how many
 * consecutive failures may pass before auto-selection stops).
 *
 * Pure functions only; the orchestrator holds the per-intent state map and wires
 * these into fan-out / resume paths.
 */

/** Per-intent termination state, held by the orchestrator and serialized into
 *  OrchestratorSnapshot so a restart does not reset the guards. */
export type IntentBudget = {
  /** Cumulative branches spawned for this intent (first fan-out N + each resume). */
  used: number;
  /** Consecutive failed branches (branch.ok === false) since the last success. */
  failureStreak: number;
};

/** Structural defaults (design-supervision §7.1): fail-closed guard defaults, not
 *  calibrated limits — real-load calibration rides the #9 trigger (≥3 live
 *  vassals). 256 branches per intent and 8 consecutive failures are wide enough
 *  that ordinary fan-outs / partial-failure flows never brush them. */
export const DEFAULT_MAX_BRANCHES_PER_INTENT = 256;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;

export type BudgetLimit = {
  /** Cumulative branch cap per intent. Unset = no budget guard (historical behaviour). */
  maxBranchesPerIntent?: number;
  /** Consecutive failure threshold after which auto-selected dispatch is refused. Unset = no breaker. */
  maxConsecutiveBranchFailures?: number;
};

/** True when the cumulative branch count meets or exceeds the cap. */
export function budgetExceeded(budget: IntentBudget, limit: number): boolean {
  return budget.used >= limit;
}

/** True when the consecutive failure streak meets or exceeds the threshold. */
export function circuitOpen(budget: IntentBudget, threshold: number): boolean {
  return budget.failureStreak >= threshold;
}

/** Advance the counter when branches are spawned (fan-out N at once, resume +1).
 *  Pure: returns a new object, never mutates the input. */
export function advanceBudget(budget: IntentBudget, amount = 1): IntentBudget {
  return { used: budget.used + amount, failureStreak: budget.failureStreak };
}

/** Fold one settled branch into the streak. A success resets the streak to 0; a
 *  failure increments it. `used` is untouched here — it is charged at spawn time
 *  (advanceBudget), so in-flight branches count against the budget too. */
export function settleBranch(budget: IntentBudget, ok: boolean): IntentBudget {
  return { used: budget.used, failureStreak: ok ? 0 : budget.failureStreak + 1 };
}

/** Initial state for an intent that has not spawned anything yet. */
export function emptyBudget(): IntentBudget {
  return { used: 0, failureStreak: 0 };
}

/** Result of a guarded entry: a discriminated union so callers can rely on
 *  `allowed: false` implying a concrete reason. */
export type DispatchGate =
  | { allowed: true; reason: null }
  | { allowed: false; reason: 'budget-exceeded' | 'circuit-open' };

/** Guarded entry: true when the intent may spawn another auto-selected branch
 *  under the configured limits (budget and, for auto-selection, the breaker).
 *  `explicit` means the driver named the target — a deliberate override that
 *  the breaker (unlike the budget) does not govern, matching the skillGovernor /
 *  backpressure override precedent. */
export function mayDispatch(
  budget: IntentBudget,
  limits: BudgetLimit,
  explicit: boolean,
): DispatchGate {
  if (limits.maxBranchesPerIntent !== undefined && budgetExceeded(budget, limits.maxBranchesPerIntent)) {
    return { allowed: false, reason: 'budget-exceeded' };
  }
  if (!explicit && limits.maxConsecutiveBranchFailures !== undefined && circuitOpen(budget, limits.maxConsecutiveBranchFailures)) {
    return { allowed: false, reason: 'circuit-open' };
  }
  return { allowed: true, reason: null };
}

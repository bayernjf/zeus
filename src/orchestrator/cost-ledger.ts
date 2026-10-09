// design-cost-governance (tech map S9): cost as a first-class guardrail.
// The ledger admits work under a budget, records settled/admitted cost, and
// exposes the two gate conditions — the soft cap and the rate circuit —
// before an outbound call goes out. V1 is the pure-ledger layer only
// (design-cost-governance §5): no collector, no self-report parsing, no
// wiring — every input is caller-supplied. Self-reported cost never feeds the
// admission gate (a provider that reports its own cost must not be able to
// inflate or deflate the gate).

export type CostAmount = {
  tokens?: number;
  credits?: number;
};

export type CostWindow = {
  /** Cumulative admitted cost in the current window. */
  spent: number;
  /** The window end (epoch ms); on expiry the ledger rolls spent back to 0. */
  windowEndsAt: number;
};

export type CostBudget = {
  /** Admitted (in-flight + settled) cost in the current window. */
  spent: number;
  /** Estimated in-flight cost that has not settled yet. */
  inFlightEstimate: number;
  window: CostWindow;
  /** When the rate circuit tripped (epoch ms); absent = never tripped. */
  rateTrippedAt?: number;
};

export type CostLimit = {
  /** Soft cap per window: crossing it refuses further admission (blocked). */
  maxWindowCost?: number;
  /** Rate cap: admits per window beyond this rate trip the circuit. */
  maxRatePerWindow?: number;
  /** Circuit open window (ms): after a trip, admission is refused until expiry. */
  circuitWindowMs?: number;
};

/** Empty ledger state. */
export function emptyCostBudget(now: number, windowMs: number): CostBudget {
  return { spent: 0, inFlightEstimate: 0, window: { spent: 0, windowEndsAt: now + windowMs } };
}

/** Refuse/allow a cost admission (design-cost-governance §3.1). The gate is
 *  fail-closed: an undefined limit admits nothing new when the ledger is
 *  already at or past the soft cap. Self-reported cost never enters the gate. */
export function costAdmit(
  budget: CostBudget,
  limit: CostLimit,
  cost: CostAmount,
  now: number,
): { ok: true; budget: CostBudget } | { ok: false; reason: 'budget-exceeded' | 'rate-circuit-open'; budget: CostBudget } {
  const fresh = rollWindow(budget, limit, now);
  const amount = toUnits(cost);
  const projected = fresh.budget.spent + amount;
  if (fresh.rateOpen === false) {
    return { ok: false, reason: 'rate-circuit-open', budget: fresh.budget };
  }
  if (limit.maxWindowCost !== undefined && projected > limit.maxWindowCost) {
    return { ok: false, reason: 'budget-exceeded', budget: fresh.budget };
  }
  // Crossing the rate cap trips the circuit at this moment; the trip time is
  // anchored here (not lazily at the next read), so the circuit window counts
  // from the crossing.
  const atRate = limit.maxRatePerWindow !== undefined && projected >= limit.maxRatePerWindow;
  const tripped = atRate ? { rateTrippedAt: fresh.budget.rateTrippedAt ?? now } : {};
  return { ok: true, budget: { ...fresh.budget, spent: projected, inFlightEstimate: fresh.budget.inFlightEstimate + amount, ...tripped } };
}

/** Record a settled cost against the ledger (design-cost-governance §3.2):
 *  settles the in-flight estimate back to spent and carries the window. */
export function recordSettled(budget: CostBudget, limit: CostLimit, cost: CostAmount, now: number): CostBudget {
  const fresh = rollWindow(budget, limit, now);
  const amount = toUnits(cost);
  // Admitted cost already counts against `spent`; settling only releases the
  // in-flight estimate. A settled amount larger than the estimate clamps to 0.
  return {
    ...fresh.budget,
    spent: fresh.budget.spent,
    inFlightEstimate: Math.max(0, fresh.budget.inFlightEstimate - amount),
  };
}

/** Record an admitted-but-never-dispatched cost (design-cost-governance
 *  §3.3): the estimate is released without touching spent. */
export function recordAdmitted(budget: CostBudget, limit: CostLimit, cost: CostAmount, now: number): CostBudget {
  const fresh = rollWindow(budget, limit, now);
  const amount = toUnits(cost);
  return { ...fresh.budget, inFlightEstimate: Math.max(0, fresh.budget.inFlightEstimate - amount) };
}

/** The soft cap is reached when the projected spend sits at or above the
 *  cap — the admission that would cross it is refused, and reaching the cap is
 *  observable before any further call. */
export function costSoftReached(budget: CostBudget, limit: CostLimit, cost: CostAmount, now: number): boolean {
  const fresh = rollWindow(budget, limit, now);
  if (limit.maxWindowCost === undefined) return false;
  return fresh.budget.spent + toUnits(cost) >= limit.maxWindowCost;
}

/** The rate circuit is open when admissions in this window have crossed the
 *  configured rate (design-cost-governance §3.4); the circuit stays open for
 *  `circuitWindowMs` from the trip. */
export function costRateCircuitOpen(budget: CostBudget, limit: CostLimit, now: number): boolean {
  const fresh = rollWindow(budget, limit, now);
  return fresh.rateOpen === false;
}

function rollWindow(
  budget: CostBudget,
  limit: CostLimit,
  now: number,
): { budget: CostBudget; rateOpen: boolean } {
  if (now >= budget.window.windowEndsAt) {
    const windowMs = limit.circuitWindowMs ?? DEFAULT_COST_WINDOW_MS;
    return {
      budget: { spent: 0, inFlightEstimate: 0, window: { spent: 0, windowEndsAt: now + windowMs } },
      rateOpen: true,
    };
  }
  if (limit.maxRatePerWindow === undefined) return { budget, rateOpen: true };
  if (budget.spent < limit.maxRatePerWindow) return { budget, rateOpen: true };
  // At or past the rate cap: open, and stays open until the circuit window
  // elapses from the trip (or until the ledger window rolls).
  const trippedAt = budget.rateTrippedAt ?? now;
  const circuitMs = limit.circuitWindowMs ?? Number.POSITIVE_INFINITY;
  return { budget: { ...budget, rateTrippedAt: trippedAt }, rateOpen: now - trippedAt >= circuitMs };
}

/** Normalize a cost amount into a single comparable unit: tokens win when both
 *  are present (the ledger is calibrated in tokens; credits are converted at
 *  the configured 1:1 until real pricing data lands). Self-reports are never
 *  trusted here — this is the caller's conversion. */
function toUnits(cost: CostAmount): number {
  return cost.tokens ?? cost.credits ?? 0;
}

const DEFAULT_COST_WINDOW_MS = 60_000;

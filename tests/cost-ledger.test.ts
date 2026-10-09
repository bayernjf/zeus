// design-cost-governance (tech map S9) V1: emptyCostBudget / costAdmit /
// recordSettled / recordAdmitted / costSoftReached / costRateCircuitOpen pure
// ledger functions. Acceptance (design-cost-governance §5): admission under
// budget passes and over budget refuses (budget-exceeded); the rate circuit
// trips and stays open for the circuit window; the window rolls; settled and
// admitted records move the ledger deterministically; self-reported cost
// never gates admission (only the caller-supplied amount does); zero runtime
// behaviour change (V1 is pure functions only).

import { describe, expect, it } from 'vitest';
import {
  costAdmit,
  costRateCircuitOpen,
  costSoftReached,
  emptyCostBudget,
  recordAdmitted,
  recordSettled,
} from '../src/orchestrator/cost-ledger.js';
import type { CostLimit } from '../src/orchestrator/cost-ledger.js';

const NOW = 1_000_000;
const WINDOW = 60_000;

const noLimit: CostLimit = {};

describe('costAdmit (S9 V1)', () => {
  it('admits cost under the budget and tracks spent + in-flight', () => {
    const b0 = emptyCostBudget(NOW, WINDOW);
    const limit: CostLimit = { maxWindowCost: 100 };
    const r = costAdmit(b0, limit, { tokens: 30 }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.budget.spent).toBe(30);
      expect(r.budget.inFlightEstimate).toBe(30);
    }
  });

  it('refuses admission that would cross the soft cap (budget-exceeded)', () => {
    const b0 = emptyCostBudget(NOW, WINDOW);
    const limit: CostLimit = { maxWindowCost: 50 };
    const r = costAdmit(b0, limit, { tokens: 60 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('budget-exceeded');
  });

  it('admits exactly up to the cap and refuses the next token', () => {
    let b = emptyCostBudget(NOW, WINDOW);
    const limit: CostLimit = { maxWindowCost: 50 };
    const r1 = costAdmit(b, limit, { tokens: 50 }, NOW);
    expect(r1.ok).toBe(true);
    if (r1.ok) b = r1.budget;
    const r2 = costAdmit(b, limit, { tokens: 1 }, NOW);
    expect(r2.ok).toBe(false);
  });

  it('is fail-open on cost when no cap is configured', () => {
    const r = costAdmit(emptyCostBudget(NOW, WINDOW), noLimit, { tokens: 10_000 }, NOW);
    expect(r.ok).toBe(true);
  });
});

describe('costSoftReached + costRateCircuitOpen (S9 V1)', () => {
  it('reports the soft cap reached before the crossing call', () => {
    let b = emptyCostBudget(NOW, WINDOW);
    const limit: CostLimit = { maxWindowCost: 100 };
    b = (costAdmit(b, limit, { tokens: 99 }, NOW) as { ok: true; budget: typeof b }).budget;
    expect(costSoftReached(b, limit, { tokens: 1 }, NOW)).toBe(true);
    expect(costSoftReached(b, limit, { tokens: 0 }, NOW)).toBe(false);
  });

  it('trips the rate circuit once the rate cap is crossed and stays open', () => {
    let b = emptyCostBudget(NOW, WINDOW);
    const limit: CostLimit = { maxRatePerWindow: 100 };
    b = (costAdmit(b, limit, { tokens: 100 }, NOW) as { ok: true; budget: typeof b }).budget;
    expect(costRateCircuitOpen(b, limit, NOW)).toBe(true);
    const r = costAdmit(b, limit, { tokens: 1 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rate-circuit-open');
  });

  it('closes the circuit when the circuit window expires', () => {
    let b = emptyCostBudget(NOW, WINDOW);
    const limit: CostLimit = { maxRatePerWindow: 100, circuitWindowMs: 5_000 };
    b = (costAdmit(b, limit, { tokens: 100 }, NOW) as { ok: true; budget: typeof b }).budget;
    expect(costRateCircuitOpen(b, limit, NOW)).toBe(true);
    expect(costRateCircuitOpen(b, limit, NOW + 5_001)).toBe(false);
  });
});

describe('window roll + settle records (S9 V1)', () => {
  it('rolls the window after expiry and resets spent and in-flight', () => {
    let b = emptyCostBudget(NOW, WINDOW);
    const limit: CostLimit = { maxWindowCost: 100 };
    b = (costAdmit(b, limit, { tokens: 80 }, NOW) as { ok: true; budget: typeof b }).budget;
    const r = costAdmit(b, limit, { tokens: 50 }, NOW + WINDOW + 1);
    expect(r.ok).toBe(true); // fresh window has room again
    if (r.ok) expect(r.budget.spent).toBe(50);
  });

  it('recordSettled moves in-flight cost to spent', () => {
    let b = emptyCostBudget(NOW, WINDOW);
    b = (costAdmit(b, noLimit, { tokens: 40 }, NOW) as { ok: true; budget: typeof b }).budget;
    b = recordSettled(b, noLimit, { tokens: 40 }, NOW);
    expect(b.spent).toBe(40);
    expect(b.inFlightEstimate).toBe(0);
  });

  it('recordAdmitted releases the in-flight estimate without touching spent', () => {
    let b = emptyCostBudget(NOW, WINDOW);
    b = (costAdmit(b, noLimit, { tokens: 40 }, NOW) as { ok: true; budget: typeof b }).budget;
    b = recordAdmitted(b, noLimit, { tokens: 40 }, NOW);
    expect(b.spent).toBe(40); // admitted cost stays on the ledger
    expect(b.inFlightEstimate).toBe(0);
  });

  it('prefers tokens over credits and treats absence as zero', () => {
    const r = costAdmit(emptyCostBudget(NOW, WINDOW), { maxWindowCost: 100 }, { tokens: 30, credits: 90 }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.budget.spent).toBe(30);
    const z = costAdmit(emptyCostBudget(NOW, WINDOW), { maxWindowCost: 0 }, {}, NOW);
    expect(z.ok).toBe(true); // zero cost never trips the gate
  });
});

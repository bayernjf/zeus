import type { VassalStatus } from '../registry/registry.js';

/**
 * #9 backpressure diversion (design-backpressure.md): a pure target-selection
 * primitive that re-points a saturated (or ineligible) auto-selected vassal to
 * the best available same-skill provider *before* dispatch. It mirrors `aggregate`
 * in being side-effect-free (no clock, no IO, no LLM), so it is fully unit-testable
 * and its decisions are reproducible and auditable.
 *
 * Saturation is read from a caller-supplied load snapshot; the live per-vassal
 * in-flight counter lives in `ConcurrencyMetrics` (`inFlightByVassalNow`). The
 * per-vassal saturation cap (`capOf`) is deliberately separate from the global
 * `maxConcurrentBranches` gate: if it equalled the global cap, a saturated agent
 * would imply the global pool was full and no idle alternate could ever take a
 * slot, so diversion could never fire. The orchestrator therefore owns an
 * independently configured `maxConcurrentPerVassal`.
 *
 * Health is a *synchronous snapshot* (`statusOf`): the live async `healthCheck`
 * probe (registry.ts:185) is intentionally not called here — doing so per
 * candidate per fan-out would be impure and would perturb the run being measured.
 * The caller supplies the current status; the live probe refines the 'unhealthy'
 * classification once the ≥3-real-agent pressure test (the strategy's trigger
 * condition) is in place.
 */

export type DiversionInput = {
  skill: string;
  /** Explicitly-named targets (`request.vassals`). Presence = hard pin, never divert. */
  explicitVassals?: string[];
  /** Auto-selected names after the skill-governor gate (already filtered). */
  initialNames: string[];
  /** Same-skill candidate pool from `activeProviders()`; `undefined` = pass-through, no diversion. */
  candidatePool?: string[];
  load: {
    inFlightByVassal: (vassal: string) => number;
    /** Per-vassal saturation cap; `Infinity` means no per-vassal bound. */
    capOf: (vassal: string) => number;
  };
  metrics: {
    /** Historical failure rate (0 when no record). */
    failureRate: (vassal: string) => number;
    /** Historical p50 latency ms (null when no record). */
    p50Ms: (vassal: string) => number | null;
  };
  health: {
    /** Synchronous status snapshot; 'revoked'/'unknown' are excluded from candidacy. */
    statusOf: (vassal: string) => VassalStatus;
  };
  /** Scoring weights + normalizer. Threshold tuning is gated on the pressure test. */
  weights?: DiversionWeights;
};

export type DiversionWeights = {
  reliability: number;
  latency: number;
  latencyNormalizer: number;
};

/** Defaults: equal weight, normalizer set to a 1s baseline (calibrated under load later). */
export const DEFAULT_DIVERSION_WEIGHTS: DiversionWeights = {
  reliability: 1,
  latency: 1,
  latencyNormalizer: 1000,
};

export type DiversionTarget = {
  target: string;
  /** The originally-selected name this target replaced via diversion; null = as selected. */
  divertedFrom: string | null;
};

export type DiversionTried = {
  vassal: string;
  state: 'saturated' | 'unhealthy' | 'revoked' | 'none-active';
};

export type SelectTargetsResult = {
  plan: DiversionTarget[];
  /** Populated when at least one auto-selected target had no available alternate. */
  exhausted: { skill: string; tried: DiversionTried[] } | null;
};

/** Format an exhaustion report for inclusion in a branch's refusal reason. */
export function formatExhausted(exhausted: { skill: string; tried: DiversionTried[] }): string {
  const tried = exhausted.tried.map(t => `${t.vassal}[${t.state}]`).join(', ');
  return `no alternate provider for skill '${exhausted.skill}'; tried: ${tried}`;
}

/**
 * Decide the final dispatch targets for a fan-out. Auto-selected targets that
 * are saturated or ineligible are replaced, in score order, by the best eligible
 * non-saturated candidate from the same skill. Explicit targets are returned
 * unchanged (hard pin). When no alternate exists for a target, the original is
 * kept so it falls through to the global semaphore queue→reject gate, and the
 * pool's unavailability is reported in `exhausted` for the refusal audit.
 */
export function selectTargets(input: DiversionInput): SelectTargetsResult {
  const { skill, initialNames, candidatePool } = input;

  // Hard pin: explicit targets are a deliberate driver override — never divert.
  if (input.explicitVassals && input.explicitVassals.length > 0) {
    return { plan: initialNames.map(target => ({ target, divertedFrom: null })), exhausted: null };
  }
  // Pass-through (skill not governed) or nothing selected: no diversion.
  if (candidatePool === undefined || initialNames.length === 0) {
    return { plan: initialNames.map(target => ({ target, divertedFrom: null })), exhausted: null };
  }

  const w = input.weights ?? DEFAULT_DIVERSION_WEIGHTS;
  const saturated = (v: string) => input.load.inFlightByVassal(v) >= input.load.capOf(v);
  const eligible = (v: string) => input.health.statusOf(v) === 'active';
  const score = (v: string): number => {
    const failureRate = input.metrics.failureRate(v);
    const p50 = input.metrics.p50Ms(v);
    const latencyTerm = ((p50 === null ? w.latencyNormalizer : p50) / w.latencyNormalizer);
    return w.reliability * (1 - failureRate) - w.latency * latencyTerm;
  };
  const classify = (v: string): DiversionTried['state'] => {
    const status = input.health.statusOf(v);
    if (status === 'revoked') return 'revoked';
    if (status !== 'active') return 'unhealthy';
    if (saturated(v)) return 'saturated';
    return 'none-active';
  };

  // Eligible, non-saturated candidates, best first (tie → name asc for determinism).
  const available = candidatePool
    .filter(v => eligible(v) && !saturated(v))
    .sort((a, b) => score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0));

  const plan: DiversionTarget[] = [];
  let exhausted: { skill: string; tried: DiversionTried[] } | null = null;

  for (const name of initialNames) {
    if (eligible(name) && !saturated(name)) {
      plan.push({ target: name, divertedFrom: null });
      continue;
    }
    const altIndex = available.findIndex(v => v !== name);
    if (altIndex >= 0) {
      const alt = available.splice(altIndex, 1)[0];
      plan.push({ target: alt, divertedFrom: name });
    } else {
      // No alternate: keep the original so it hits the global queue→reject gate.
      plan.push({ target: name, divertedFrom: null });
      if (!exhausted) exhausted = { skill, tried: candidatePool.map(v => ({ vassal: v, state: classify(v) })) };
    }
  }

  return { plan, exhausted };
}

// design-tool-discovery (tech map S11): a pure selection-and-recovery layer
// that unifies the skill family (SkillRegistry/activeProviders) and the tool
// family (MCP-discovered tools) into one candidate face. V1 is the pure
// classifier only (design-tool-discovery §6): no real process is wired, no
// planner is introduced, no live health probe is called — every input is a
// caller-supplied snapshot, mirroring `selectTargets` (diversion.ts) and
// `classifyInterruption` (oversight/interrupt.ts), so it is fully
// unit-testable and reproducible.
//
// Selection order (design-tool-discovery §3.2): explicit names first (hard
// pin, never re-pointed) -> automatic targeting (saturated/unhealthy
// candidates filtered) -> trust face (tier-1 callers are narrowed to
// read-only tagged skills, fail-closed) -> capability face (execute requires
// a granted capability, otherwise plan).
//
// Recovery (design-tool-discovery §4): the fixed four-step chain retry ->
// switch -> degrade -> escalate, with high-stakes skipping retry and the S4
// circuit skipping retry/switch for automatic paths.

export type DispatchMode = 'execute' | 'plan';

/** One selectable candidate: a provider offering a skill, optionally through
 *  a specific tool, in the dispatch mode the capability face allows. */
export type DispatchCandidate = {
  provider: string;
  skillId: string;
  tool?: string;
  mode: DispatchMode;
};

/** Caller-supplied snapshot for selection (design-tool-discovery §3.2). */
export type SelectionContext = {
  skillId: string;
  /** Explicitly named targets. Presence = hard pin; saturation never re-points
   *  them (same rule as `selectTargets` on `request.vassals`). */
  named?: string[];
  /** Same-skill candidate pool; `undefined` = pass-through, no filtering. */
  candidatePool?: string[];
  /** Saturation per provider (per-vassal in-flight vs cap); `Infinity` cap
   *  means no bound. */
  load: {
    inFlightOf: (provider: string) => number;
    capOf: (provider: string) => number;
  };
  /** Trust face (design-external-trust / E9.4): tier-1 callers may only reach
   *  read-only tagged skills; a non-read-only skill yields zero candidates
   *  (fail-closed, not a downgrade). */
  tier: 'tier-0' | 'tier-1' | 'tier-2' | 'tier-3';
  readOnlyTagged: boolean;
  /** Capability face: execute is only reachable with a granted capability;
   *  otherwise every candidate is constrained to plan. */
  capabilityGranted: boolean;
  /** Which explicit names to omit (e.g. revoked), when the caller knows. */
  excludedNames?: string[];
};

/** Why the chain took the step it took — the audit-visible verdict. */
export type RecoveryAction = 'retry' | 'switch' | 'degrade' | 'escalate';

/** Failure facts for the recovery chain (design-tool-discovery §4). */
export type ChainFailure = {
  step: string;
  idempotent: boolean;
  retriesLeft: number;
  highStakes: boolean;
  /** S4 consecutive-failure circuit state; when open, automatic retry/switch
   *  are refused for auto-selected paths. */
  circuitOpen: boolean;
  hasAlternateProvider: boolean;
  /** Whether the step's result is required for the intent to converge. A
   *  non-required (optional) step may be skipped. */
  requiredStep: boolean;
};

function saturated(provider: string, ctx: SelectionContext): boolean {
  const cap = ctx.load.capOf(provider);
  return Number.isFinite(cap) && ctx.load.inFlightOf(provider) >= cap;
}

/**
 * Select the ordered candidate face for a skill (design-tool-discovery §3.2).
 *
 * - Explicit names are a hard pin: returned first, never filtered by
 *   saturation, only by explicit exclusion.
 * - Tier-1 (read-only-narrowed) callers: a skill without the read-only tag
 *   yields zero candidates — the trust face fails closed instead of silently
 *   downgrading the caller's request.
 * - Automatic candidates drop saturated/unhealthy providers, then are all
 *   constrained to the mode the capability face allows.
 */
export function selectCandidates(skillId: string, ctx: SelectionContext): DispatchCandidate[] {
  // Trust face first: tier-1 callers cannot reach non-read-only skills at all.
  if (ctx.tier === 'tier-1' && !ctx.readOnlyTagged) return [];

  const mode: DispatchMode = ctx.capabilityGranted ? 'execute' : 'plan';

  const named: DispatchCandidate[] =
    ctx.named === undefined
      ? []
      : ctx.named
          .filter((p) => !ctx.excludedNames?.includes(p))
          .map((p) => ({ provider: p, skillId, mode }));

  const auto: DispatchCandidate[] =
    ctx.candidatePool === undefined
      ? []
      : ctx.candidatePool
          .filter((p) => !ctx.excludedNames?.includes(p))
          .filter((p) => !saturated(p, ctx))
          .map((p) => ({ provider: p, skillId, mode }));

  return [...named, ...auto];
}

/**
 * Pick the next recovery action on the fixed chain (design-tool-discovery §4):
 *
 *   1. high-stakes skips retry entirely (retrying a high-stakes step twice can
 *      duplicate an external effect) -> escalate;
 *   2. idempotent with retries left and the circuit closed -> retry;
 *   3. an alternate provider with the circuit closed -> switch;
 *   4. a non-required step -> degrade (skip the step, keep converging);
 *   5. otherwise -> escalate (the operator-facing L1/L2 exit, shared with
 *      design-hil).
 *
 * When the circuit is open, automatic retry and switch are refused for the
 * auto-selected path (S4), so the chain falls through to degrade/escalate.
 */
export function recoverChain(failure: ChainFailure): RecoveryAction {
  if (failure.highStakes) return 'escalate';
  if (failure.idempotent && failure.retriesLeft > 0 && !failure.circuitOpen) return 'retry';
  if (failure.hasAlternateProvider && !failure.circuitOpen) return 'switch';
  if (!failure.requiredStep) return 'degrade';
  return 'escalate';
}

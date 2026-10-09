// design-hil (tech map S10): human-in-the-loop interruption timing. A pure
// classifier that maps an intent-execution signal onto one of three
// interruption levels, following the fixed decision chain in design-hil §3/§4:
//
//   auto-resolvable? -> L0 (no intervention)
//   stalled (no automatic path AND downstream depends on it)? -> L2 (blocking)
//   otherwise -> L1 (async queue entry, never blocks other intents)
//
// The module is side-effect-free (no clock, no IO, no LLM), mirroring
// `aggregate` / `selectTargets`: it is fully unit-testable and its decisions
// are reproducible. It deliberately does NOT touch the escalation queue, watch
// ticks or the termination guard (design-hil §5: V1 is the pure classifier +
// audit annotation only; wiring to live primitives is V2).

export type InterruptLevel = 0 | 1 | 2;

/** A signal the intent-execution path can emit (design-hil §5, one variant per
 *  existing primitive the chain maps onto). */
export type InterruptSignal =
  /** A branch failed. `idempotent` + `retriesLeft` decide retry; `highStakes`
   *  skips the automatic chain entirely and goes straight to async entry. */
  | { kind: 'branch-failed'; idempotent: boolean; retriesLeft: number; highStakes: boolean }
  /** The S4 consecutive-failure circuit opened. Auto-selected dispatch is
   *  refused (L0, the guard working); an explicitly named target is exempt
   *  from the breaker but the consecutive-failure history is worth an async
   *  operator glance. */
  | { kind: 'circuit-open'; explicitlyNamed: boolean }
  /** An intent-level conflict the arbitration rules could not resolve. */
  | { kind: 'intent-conflict'; autoResolvable: boolean }
  /** A task input the skill's declared inputs cannot complete (S1 V2
   *  `unavailable`); the intent waits for the operator to supply it. */
  | { kind: 'task-input-missing' }
  /** A delegation-limit ceiling blocked an execute fire. A covering parent
   *  contract can mint a child ticket automatically; otherwise the operator
   *  must sign a new contract. */
  | { kind: 'delegation-limit-hit'; coveredByContract: boolean }
  /** An explicitly named branch failed. Only when there is no fallback
   *  provider AND downstream work depends on its result does the intent
   *  actually stall (L2); anything else can recover or wait asynchronously. */
  | { kind: 'explicit-branch-failed'; hasFallbackProvider: boolean; downstreamDependsOnIt: boolean };

/**
 * Map a signal onto an interruption level (design-hil §3 fixed chain).
 *
 * - `branch-failed`: high-stakes skips the automatic chain (L1); an idempotent
 *   failure with retries left is auto-resolvable (L0); otherwise the four-step
 *   recovery chain is exhausted and the intent waits asynchronously (L1) —
 *   L2 is reserved for `explicit-branch-failed` with the stall pair.
 * - `circuit-open`: non-explicit auto-selection is refused by the guard (L0,
 *   the policy working); an explicit target still dispatches but consecutive
 *   failures deserve an async entry (L1).
 * - `intent-conflict`: arbitration-resolvable is automatic (L0); otherwise the
 *   conflict is queued with its stances as options (L1).
 * - `task-input-missing`: by construction the intent cannot proceed without
 *   the operator supplying it, but nothing else blocks on it (L1).
 * - `delegation-limit-hit`: a covering contract derives a child ticket
 *   automatically (L0); without one the operator must sign a new contract
 *   (L1).
 * - `explicit-branch-failed`: the L2 stall pair is *no fallback provider AND
 *   downstream depends on it*; every other combination recovers or waits
 *   asynchronously (L1).
 */
export function classifyInterruption(sig: InterruptSignal): InterruptLevel {
  switch (sig.kind) {
    case 'branch-failed':
      if (sig.highStakes) return 1;
      if (sig.idempotent && sig.retriesLeft > 0) return 0;
      return 1;
    case 'circuit-open':
      return sig.explicitlyNamed ? 1 : 0;
    case 'intent-conflict':
      return sig.autoResolvable ? 0 : 1;
    case 'task-input-missing':
      return 1;
    case 'delegation-limit-hit':
      return sig.coveredByContract ? 0 : 1;
    case 'explicit-branch-failed':
      if (!sig.hasFallbackProvider && sig.downstreamDependsOnIt) return 2;
      return 1;
  }
}

/** Human-readable reason for a classification, one sentence per level (used by
 *  the audit wording when the annotation is wired in V2). */
export function interruptionReason(sig: InterruptSignal): string {
  switch (sig.kind) {
    case 'branch-failed':
      if (sig.highStakes) return 'high-stakes failure: automatic chain skipped, operator entry queued';
      if (sig.idempotent && sig.retriesLeft > 0) return 'idempotent failure with retries left: automatic retry';
      return 'recovery chain exhausted: operator entry queued';
    case 'circuit-open':
      return sig.explicitlyNamed
        ? 'circuit open but target explicitly named: dispatch allowed, operator entry queued'
        : 'circuit open: auto-selected dispatch refused';
    case 'intent-conflict':
      return sig.autoResolvable ? 'conflict resolved by arbitration rules' : 'conflict unresolvable: operator entry queued with stances';
    case 'task-input-missing':
      return 'task input cannot be completed from skill declaration: operator entry queued';
    case 'delegation-limit-hit':
      return sig.coveredByContract ? 'delegation limit covered by parent contract: child ticket derived' : 'delegation limit hit without covering contract: new contract required';
    case 'explicit-branch-failed':
      return !sig.hasFallbackProvider && sig.downstreamDependsOnIt
        ? 'explicit branch failed with no fallback and downstream depends on it: blocking operator decision'
        : 'explicit branch failed but recoverable: operator entry queued';
  }
}

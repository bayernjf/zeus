// design-external-trust (PRD E9.4, deferred #5): trust tiers and per-tier
// sandbox limits for caller cards on the inbound A2A face. The protocol
// statement that unregistered callers get the lowest trust
// (design-vassal-protocol §5) becomes an enforceable, audited tier decision.

import type { AgentCard } from '../a2a/types.js';
import { attestationMatchesCard, type Attestation } from '../registry/signing.js';

/** Verification strength of a caller card whose fealty shape already passed
 *  the registration gate. `tier-0` is decided by the gate itself (fail-closed)
 *  and never reaches this module. */
export type TrustTier = 'tier-0' | 'tier-1' | 'tier-2' | 'tier-3';

/** The sandbox limits bound to a tier (design-external-trust §3): four
 *  orthogonal faces — capability, data, resource, operation. */
export type TierConstraints = {
  /** tier-1 pins the only reachable dispatch mode to plan (read-only
   *  analysis); execute is unreachable by construction. null = leave the
   *  caller's request untouched. */
  mode: 'plan' | null;
  /** tier-1 never injects outbound credentials into the caller's task. */
  injectCredentials: boolean;
  /** tier-1 pins realm-content entry into the outbound load to the strictest
   *  policy (none); null = leave the caller's request untouched. */
  dataPolicy: 'none' | null;
  /** Scale on the global resource defaults; 1/3 for tier-1. The kernel default
   *  is no branch timeout, so the scale only bites when a limit is actually set
   *  — numbers are tuned with real load (deferred #9), never fabricated here. */
  resourceScale: number;
};

export function tierConstraints(tier: TrustTier): TierConstraints {
  switch (tier) {
    case 'tier-1':
      return { mode: 'plan', injectCredentials: false, dataPolicy: 'none', resourceScale: 1 / 3 };
    case 'tier-2':
    case 'tier-3':
      return { mode: null, injectCredentials: true, dataPolicy: null, resourceScale: 1 };
    case 'tier-0':
      // A refusal has no constraint set to apply; callers that reach this were
      // rejected at the gate before constraints are ever consulted.
      throw new Error('tier-0 is a refusal, not a constraint set');
  }
}

export type TrustDecision = { tier: 'tier-1' | 'tier-2' | 'tier-3'; name: string };

/** V2 (design-external-trust §3, capability face): a skill tagged with this
 *  value is a read-only skill — the formal whitelist tier-1 callers may
 *  dispatch. The tag rides the existing skill `tags` field; no new field. */
export const READ_ONLY_TAG = 'read-only';

/** Capability-face whitelist predicate for tier-1 (design-external-trust §3):
 *  only skills tagged read-only are dispatchable by shape-trust callers. */
export function isReadOnlyTagged(spec: { tags?: string[] }): boolean {
  return (spec.tags ?? []).includes(READ_ONLY_TAG);
}

/** Verified view of the signed roster (design-external-trust §4, V3): the
 *  async seal/verify chain runs ahead of this pure decision and hands down
 *  this lookup. An attestation is only half the check — the presented card
 *  must still content-match it (attestationMatchesCard). */
export type RosterAnchor = {
  attestationFor(name: string): Attestation | undefined;
};

/** Decides the trust tier of a caller card whose fealty shape already passed
 *  the registration gate (version gate + fealtyOathProblem). Survivors map to
 *  tiers by verification strength:
 *  - tier-3: the signed roster anchors the exact card presented — the name is
 *    on the roster AND the card content-matches its attestation (V3, reachable
 *    once a RosterAnchor is wired in);
 *  - tier-2: the card names a registered, active agent;
 *  - tier-1: shape-trust only — the caller is not on the roster.
 *  A caller whose card fails the attestation content check falls back to the
 *  registry-row check rather than refusal: tier-2 never trusted the presented
 *  card's content in the first place, so the fallback weakens nothing.
 */
export function trustTierOf(card: AgentCard, isActive: (name: string) => boolean, rosterAnchor?: RosterAnchor): TrustDecision {
  const attestation = rosterAnchor?.attestationFor(card.name);
  if (attestation && attestationMatchesCard(attestation, card)) {
    return { tier: 'tier-3', name: card.name };
  }
  return isActive(card.name) ? { tier: 'tier-2', name: card.name } : { tier: 'tier-1', name: card.name };
}

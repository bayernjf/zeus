/**
 * TUI token subset (design-ui-foundations §3.2). The terminal does not get the
 * Web px/rem/color scales: semantic tokens map onto ANSI styles the user's own
 * terminal theme interprets, so we never hard-code an RGB value. Every kernel/
 * API status maps to exactly one semantic status token here; unknown statuses
 * fall back to `unknown` and are shown with their raw enum (never invented).
 */

export type SemanticColor =
  | 'default'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'attention'
  | 'info'
  | 'unknown';

/** SGR codes (foreground only), chosen for semantics rather than a fixed palette. */
const SGR: Record<SemanticColor, number> = {
  default: 0,
  muted: 90,
  accent: 36, // running / in-flight
  success: 32, // completed / active
  warning: 33, // partial
  danger: 31, // failed / destructive
  attention: 35, // needs-driver
  info: 34, // input-required
  unknown: 90,
};

/**
 * One canonical status -> semantic token entry. Keep this as the single place a
 * kernel/API enum is given a visual meaning (CI asserts it is a 1:1 mapping).
 */
const STATUS_TOKEN: Record<string, SemanticColor> = {
  // intent / branch lifecycle
  running: 'accent',
  completed: 'success',
  partial: 'warning',
  failed: 'danger',
  canceled: 'muted', // asked for by the driver, not a fault
  'needs-driver': 'attention',
  'input-required': 'info',
  working: 'accent',
  // roster membership
  active: 'success',
  revoked: 'muted',
};

/**
 * One canonical audit decision -> semantic token entry (single place, like
 * STATUS_TOKEN). Governance refusals are warnings (the policy worked);
 * transport/execution failures are danger; normal flow stays quiet.
 */
const AUDIT_TOKEN: Record<string, SemanticColor> = {
  dispatched: 'accent',
  // The lifecycle counterpart of `dispatched`: a branch ending on purpose.
  'cancel-requested': 'accent',
  'dispatch-failed': 'danger',
  // design-fan-out §7: the driver aborted a live branch via AbortSignal before
  // its A2A stream ended — a deliberate transport-level interrupt, like cancel.
  'branch-aborted': 'warning',
  'sla-ack-breached': 'warning',
  'vassal-revoked': 'danger',
  'vassal-reinstated': 'accent',
  'refused-realm-policy': 'warning',
  'refused-unknown-vassal': 'warning',
  'refused-revoked': 'warning',
  'refused-skill-uninstalled': 'warning',
  'refused-no-active-provider': 'warning',
  'branch-diverted': 'info',
  'domain-read': 'info',
  'domain-refused': 'warning',
  // design-realm §3.1: content admitted (info, like domain-read) and content
  // refused by policy origin (warning, like the other policy-working refusals).
  'content-injected': 'info',
  'refused-data-policy': 'warning',
  // S1 context engineering V1 (design-context-engineering §10): appendix
  // assembled is information (like content-injected); a trimmed entry and an
  // over-budget cap are shape-changes worth noticing, so both warn.
  'context-assembled': 'info',
  'context-trimmed': 'warning',
  'context-budget-exceeded': 'warning',
  'domain-grant-issued': 'info',
  'domain-grant-revoked': 'warning',
  'driver-grant-issued': 'info',
  'execution-delegation-issued': 'info',
  // deferred #33: the execute gate refused a branch — warning, like the other
  // policy-working refusals (the refusal is the gate doing its job).
  'execution-delegation-denied': 'warning',
  'realm-write': 'info',
  'realm-disconnected': 'warning',
  'realm-tenant-retargeted': 'warning',
  'commission-granted': 'info',
  'commission-waived': 'info',
  'commission-withdrawn': 'warning',
  'commission-refused': 'warning',
  'memory-claim-skipped': 'warning',
  // design-self-host-loop §4.3: an intent raised with nobody present is the one
  // governance fact that must never be muted, so firing is attention; a watch
  // that stops evaluating is a warning, because "silently never fires" is the
  // failure mode this whole surface exists to prevent.
  'watch-registered': 'info',
  'watch-fired': 'attention',
  'watch-disabled': 'warning',
  'watch-revoked': 'warning',
  'watch-eval-unavailable': 'warning',
  'watch-auto-disabled': 'danger',
  // self-host loop step 4: a child ticket minted for an unattended execute is
  // the governance fact that must stay visible (attention, like watch-fired);
  // a refused fire is the contract ceiling holding, which is danger.
  'delegation-child-issued': 'attention',
  'delegation-limit-exceeded': 'danger',
  'delegation-contract-issued': 'attention',
  // E6.1 / P0-5: the desk raising a question and the driver answering it.
  'escalation-escalated': 'attention',
  'escalation-approved': 'success',
  'escalation-rejected': 'muted',
  'delegation-contract-revoked': 'warning',
  // design-inbound-a2a (deferred #19): an inbound task landing on the intent
  // surface is a new intent arriving from outside - visible like any dispatch;
  // a refused inbound task is the gate holding, which is a warning.
  'inbound-task-accepted': 'attention',
  'inbound-task-refused': 'warning',
  // design-external-trust (PRD E9.4): admitting a caller on a trust tier is
  // visible like any governance fact; refusing one at the tier gate is the
  // gate holding, a warning.
  'external-agent-admitted': 'attention',
  'external-agent-refused': 'warning',
  // design-supervision §7.1 (S4): a termination guard holding is a governance
  // fact an operator should see — budget exhaustion and a circuit break are
  // warnings, not silent drops.
  'intent-branch-budget-exceeded': 'warning',
  'intent-circuit-opened': 'warning',
  // design-hil (S10): level-0 is normal automatic flow (quiet, like dispatched
  // is quiet), level-1 waits asynchronously for the operator (info), level-2
  // blocks on an operator decision (attention — the one that must never be
  // muted).
  'interrupt-level-0': 'muted',
  'interrupt-level-1': 'info',
  'interrupt-level-2': 'attention',
  // design-tool-discovery (S11): a candidate selection is information (like
  // branch-diverted); a tool failure and each recovery action are worth
  // noticing, so they warn.
  'tool-selected': 'info',
  'tool-failed': 'warning',
  'chain-retried': 'warning',
  'chain-switched': 'warning',
  'chain-degraded': 'warning',
  // design-guardrails (S8): a boundary annotation is information; a redaction
  // or refusal is the guardrail working, so it warns.
  'guardrail-annotated': 'info',
  'guardrail-redacted': 'warning',
  'guardrail-refused': 'warning',
  // design-sandbox (S16): an isolation refusal is the gate working, so it
  // warns; a spawned-isolated connector is normal operation.
  'connector-isolation-denied': 'warning',
  'connector-spawned-isolated': 'info',
  'connector-quota-killed': 'warning',
  // design-long-running (S13): an auto-resumed branch is normal; awaiting the
  // operator and a failed settle are recovery events the operator must see.
  'recovery-auto-resumed': 'info',
  'recovery-awaiting-operator': 'attention',
  'recovery-settled-failed': 'warning',
  'checkpoint-written': 'info',
  // design-planning (S12): plan lifecycle — selected is progress, conflict and
  // unplannable need the operator, malformed/replanned are warnings.
  'plan-selected': 'accent',
  'plan-conflict': 'attention',
  'plan-rejected-unplannable': 'attention',
  'plan-malformed': 'warning',
  'plan-replanned': 'warning',
  // design-cost-governance (S9): budget and rate refusals are warnings; a
  // self-report mismatch or backend degradation is danger.
  'cost-budget-exceeded': 'warning',
  'cost-rate-circuit-open': 'warning',
  'cost-self-report-mismatch': 'danger',
  'cost-backend-degraded': 'danger',
};

export type StatusToken = { token: SemanticColor; known: boolean };

/** Resolve a raw status enum to its semantic token. Unknown -> fallback + known:false. */
export function statusToken(status: string): StatusToken {
  if (Object.prototype.hasOwnProperty.call(STATUS_TOKEN, status)) {
    return { token: STATUS_TOKEN[status]!, known: true };
  }
  return { token: 'unknown', known: false };
}

/** Resolve a raw audit decision to its semantic token. Unknown -> fallback. */
export function auditToken(decision: string): StatusToken {
  if (Object.prototype.hasOwnProperty.call(AUDIT_TOKEN, decision)) {
    return { token: AUDIT_TOKEN[decision]!, known: true };
  }
  return { token: 'unknown', known: false };
}

export type Palette = {
  enabled: boolean;
  paint: (color: SemanticColor, text: string) => string;
  bold: (text: string) => string;
};

/** Build a palette; honors NO_COLOR / a non-TTY caller forcing colors off. */
export function makePalette(enabled: boolean): Palette {
  if (!enabled) {
    return { enabled: false, paint: (_c, text) => text, bold: text => text };
  }
  return {
    enabled: true,
    paint: (color, text) => `\x1b[${SGR[color]}m${text}\x1b[0m`,
    bold: text => `\x1b[1m${text}\x1b[0m`,
  };
}

/** Paint a raw status with its one semantic token. */
export function paintStatus(palette: Palette, status: string, label: string): string {
  const { token } = statusToken(status);
  return palette.paint(token, label);
}

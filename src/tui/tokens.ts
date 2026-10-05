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

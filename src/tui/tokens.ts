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
  'needs-driver': 'attention',
  'input-required': 'info',
  working: 'accent',
  // roster membership
  active: 'success',
  revoked: 'muted',
};

export type StatusToken = { token: SemanticColor; known: boolean };

/** Resolve a raw status enum to its semantic token. Unknown -> fallback + known:false. */
export function statusToken(status: string): StatusToken {
  if (Object.prototype.hasOwnProperty.call(STATUS_TOKEN, status)) {
    return { token: STATUS_TOKEN[status], known: true };
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

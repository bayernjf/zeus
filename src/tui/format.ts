import { messages, type Locale, type MessageKey } from './messages.js';

/** Format params for a message: numbers/strings interpolated by {name}. */
export type FormatParams = Record<string, string | number>;

/**
 * Neutralize terminal control sequences in untrusted text before it reaches a
 * TTY. Agent-controlled fields (vassal names, escalation reasons, branch
 * previews, connector commands, ...) could otherwise embed SGR/CSI/OSC
 * sequences or CR/LF and forge or disrupt the governance surface.
 *
 * Complete escape sequences (CSI, OSC, two-byte escapes) are stripped together
 * with their payload; any residual C0/C1 control byte is replaced with U+FFFD
 * so tampering stays visible. Printable content, including CJK and
 * box-drawing characters, is untouched. The palette adds its own SGR wraps
 * only after this pass, so legitimate coloring is unaffected.
 */
const ESCAPE_SEQUENCE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[@-~])/g;
const CONTROL_BYTE = /[\x00-\x1f\x7f-]/g;

export function safeText(value: string): string {
  return value.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_BYTE, '\uFFFD');
}

/**
 * Minimal {placeholder} interpolation (TUI v1). The Web v1 uses ICU
 * MessageFormat per design-ui-foundations §5.3; here values are already
 * pre-formatted by the caller via Intl.* so no plural/select syntax is needed.
 *
 * A missing param is left as its literal `{name}` rather than throwing: the deck
 * is a monitoring surface, and one gap in a translation table must not take the
 * whole panel down mid-refresh.
 */
export function format(template: string, params: FormatParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return match;
    const v = params[key]!;
    return typeof v === 'number' ? String(v) : safeText(v);
  });
}

export type Translator = (key: MessageKey, params?: FormatParams) => string;

/**
 * Build a bound translator. Unknown locale falls back to zh-CN (the canonical
 * set). A key absent from both tables renders as the key itself, so a hole in
 * the catalogue shows up as a visible placeholder instead of a
 * `undefined.replace` crash while drawing.
 */
export function makeTranslator(locale: Locale = 'zh-CN'): Translator {
  const table = messages[locale] ?? messages['zh-CN'];
  return (key, params) => {
    const template = table[key] ?? messages['zh-CN'][key];
    return template === undefined ? key : format(template, params);
  };
}

/** Resolve a locale from a BCP 47-ish string; non-matching -> zh-CN. */
export function resolveLocale(value: string | undefined): Locale {
  if (value === 'en' || value?.toLowerCase().startsWith('en')) return 'en';
  return 'zh-CN';
}

/** Localized label for a kernel/API status; the enum itself stays untranslated. */
export function statusLabel(t: Translator, status: string): string {
  const key = `intent.status.${status}` as MessageKey;
  if (key in messages['zh-CN']) return t(key);
  return t('intent.status.unknown', { status });
}

/** Localized label for an audit decision; the enum itself stays untranslated. */
export function auditDecisionLabel(t: Translator, decision: string): string {
  const key = `audit.decision.${decision}` as MessageKey;
  if (key in messages['zh-CN']) return t(key);
  return t('audit.decision.unknown', { decision });
}

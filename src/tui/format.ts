import { messages, type Locale, type MessageKey } from './messages.js';

/** Format params for a message: numbers/strings interpolated by {name}. */
export type FormatParams = Record<string, string | number>;

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
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  );
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

/**
 * Deterministic rendering primitives for Diary (design-diary §4).
 *
 * Content is presented, never invented: strings pass through, ClaimContent is
 * laid out as a triple, other objects become stable (sorted-key) JSON, and
 * empty content becomes an explicit placeholder.
 */
import type { ClaimContent } from '../memory/types.js';

export const NO_CONTENT = '(no content)';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClaimContent(value: unknown): value is ClaimContent {
  return isPlainObject(value) && 'subject' in value && 'predicate' in value;
}

/** Stable JSON: object keys sorted recursively so equal values stringify equal. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (isPlainObject(input)) {
      if (seen.has(input)) return null; // cycle guard
      seen.add(input);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) out[key] = normalize(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/** Render an RDF object: scalars verbatim, objects as stable JSON (truncated). */
export function renderObject(object: unknown, maxLength: number): string {
  if (isPlainObject(object) || Array.isArray(object)) {
    const json = stableStringify(object);
    return json.length > maxLength ? `${json.slice(0, maxLength)}…(truncated)` : json;
  }
  if (object === null) return 'null';
  return String(object);
}

/** Render an event's content per the safe, deterministic rules. */
export function renderEventContent(content: unknown, maxLength: number): string {
  if (content === undefined || content === null) return NO_CONTENT;
  if (typeof content === 'string') {
    return content.length === 0 ? NO_CONTENT : content;
  }
  if (isClaimContent(content)) {
    return `${String(content.subject)} ${String(content.predicate)} ${renderObject(content.object, maxLength)}`;
  }
  const json = stableStringify(content);
  return json.length > maxLength ? `${json.slice(0, maxLength)}…(truncated)` : json;
}

/** Calendar day bucket YYYY-MM-DD for an ISO instant (UTC by default). */
export function dayBucket(iso: string, timeZone: string = 'UTC'): string {
  const date = new Date(iso);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** HH:mm in the given zone (UTC by default). */
export function formatTime(iso: string, timeZone: string = 'UTC'): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

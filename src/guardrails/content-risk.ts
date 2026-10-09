/**
 * Content-side guardrail decision chain (tech map S8, V1).
 *
 * Zeus already guards the identity / authorization / network sides; the content
 * side (Realm text and agent output that carry instructional content) had no
 * primitive. This module is the content-side chain: for every piece of content
 * crossing the kernel, decide handling from (provenance × destination ×
 * deterministic signals), and make "agent-produced content is always data —
 * never an authorization, never an instruction" an executable invariant.
 *
 * V1 is pure functions only: no file-system scan, no model call, no assembly
 * wiring (assembly is V2 in design-guardrails §5). Signals are fed by the
 * deterministic scanner; the decision table is driven with the order
 * refuse > escalate > redact > annotate > pass.
 *
 * Principle: annotate by default, never rewrite user content in place; only a
 * cross-domain send or a sensitive-surface hit redacts or refuses, and every
 * disposition lands on the audit spine.
 */

export type ContentProvenance =
  | 'kernel-resolved-realm'
  | 'driver-supplied'
  | 'agent-produced'
  | 'caller-asserted'
  | 'mcp-fetched';

export type ContentDestination =
  | { kind: 'outbound'; mode: 'plan' | 'execute' }
  | { kind: 'cross-domain'; from: string; to: string; grantCoversContent: boolean }
  | { kind: 'memory-consolidation' }
  | { kind: 'audit-log' };

export type ContentSignal =
  | 'external-url'
  | 'credential-pattern'
  | 'instruction-phrase'
  | 'pii-pattern';

export type ContentHandling =
  | { action: 'pass' }
  | { action: 'annotate'; boundary: string; matches?: readonly ContentSignal[] }
  | { action: 'redact'; matches: readonly ContentSignal[] }
  | { action: 'refuse'; reason: string }
  | { action: 'escalate'; level: 1 | 2 };

/** Minimal built-in instructional-phrase list (configurable via the arg). */
export const DEFAULT_INSTRUCTION_PHRASES: readonly string[] = [
  'ignore previous',
  'ignore prior',
  '忽略此前',
  '忽略之前',
  '忽略以上',
  '你现在是',
  'you are now',
  '从现在开始',
  'do not follow',
  '作为系统提示',
] as const;

const EXTERNAL_URL_RE = /https?:\/\/[^\s'"<>]+/i;
const CREDENTIAL_RE =
  /(?:authorization\s*:\s*|bearer\s+)[A-Za-z0-9._~+/=-]{16,}|(?:\bsk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{10,}/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CN_PHONE_RE = /(?:^|[^0-9])(1[3-9][0-9]{9})(?:[^0-9]|$)/;
const CN_ID_RE = /\b[1-9][0-9]{16}[\dXx]\b/;

/**
 * Deterministic signal scanner (pure string → signal set). V1 ships the
 * minimal built-in set; `phrases` overrides the instructional-phrase list
 * (callers may pass any subset; the default list applies when omitted).
 */
export function scanContentSignals(
  text: string,
  phrases?: readonly string[],
): ContentSignal[] {
  const hits: ContentSignal[] = [];
  if (EXTERNAL_URL_RE.test(text)) hits.push('external-url');
  if (CREDENTIAL_RE.test(text)) hits.push('credential-pattern');
  const list = phrases ?? DEFAULT_INSTRUCTION_PHRASES;
  const lower = text.toLowerCase();
  if (list.some((p) => lower.includes(p.toLowerCase()))) {
    hits.push('instruction-phrase');
  }
  if (EMAIL_RE.test(text) || CN_PHONE_RE.test(text) || CN_ID_RE.test(text)) {
    hits.push('pii-pattern');
  }
  return hits;
}

function has(signals: readonly ContentSignal[], sig: ContentSignal): boolean {
  return signals.includes(sig);
}

/**
 * Decision table. Order: refuse > escalate > redact > annotate > pass.
 *
 * - audit-log: pass, except credential patterns are redacted before the audit
 *   spine records them (the spine is the tracing base, never a secret sink).
 * - cross-domain: pii without a content grant is refused; with a grant it is
 *   redacted on the outbound copy; anything else is annotated with the domain
 *   boundary.
 * - outbound execute: an external-url / credential hit escalates to L1 (do not
 *   auto-execute); otherwise annotate with an instruction-isolation boundary.
 * - outbound plan / memory-consolidation: always annotate. The provenance is
 *   carried in the boundary so a consumer can see "another agent said this",
 *   never read it as an operator instruction (design-guardrails §3.3).
 */
export function classifyContentRisk(input: {
  provenance: ContentProvenance;
  destination: ContentDestination;
  signals: readonly ContentSignal[];
}): ContentHandling {
  const { destination: d, signals, provenance } = input;

  switch (d.kind) {
    case 'audit-log':
      return has(signals, 'credential-pattern')
        ? { action: 'redact', matches: signals.filter((s) => s === 'credential-pattern') }
        : { action: 'pass' };

    case 'cross-domain': {
      const pii = signals.filter((s) => s === 'pii-pattern');
      if (pii.length > 0) {
        return d.grantCoversContent
          ? { action: 'redact', matches: pii }
          : {
              action: 'refuse',
              reason: `cross-domain pii without content grant (${d.from} > ${d.to})`,
            };
      }
      return {
        action: 'annotate',
        boundary: `domain-boundary:${d.from}>${d.to}`,
        matches: signals,
      };
    }

    case 'outbound': {
      if (has(signals, 'external-url') || has(signals, 'credential-pattern')) {
        return { action: 'escalate', level: 1 };
      }
      return {
        action: 'annotate',
        boundary:
          d.mode === 'execute'
            ? `data-boundary:${provenance};instruction-isolation`
            : `data-boundary:${provenance}`,
        matches: signals,
      };
    }

    case 'memory-consolidation':
      return {
        action: 'annotate',
        boundary: `memory:${provenance}`,
        matches: signals,
      };
  }
}

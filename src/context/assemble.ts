import type { FactRecord, RecallHit } from '../memory/types.js';
import {
  classifyContentRisk,
  scanContentSignals,
  type ContentProvenance,
  type ContentSignal,
} from '../guardrails/content-risk.js';

/**
 * S1 context engineering V1+V2 (design-context-engineering §10): memory assembly
 * and shared-context trimming for the branch dispatch context.
 *
 * This module is a pure function over injected inputs — it holds no kernel
 * state, performs no retrieval, and never writes back. The caller has already
 * searched the memory store against the dispatch realm (domain isolation is
 * enforced by `MemoryStore.searchRecall`'s reader !== target rejection; this
 * assembler only consumes the hits it is handed).
 */

/** One memory recall entry forwarded to a branch as read-only context. */
export type ContextAppendixEntry = {
  /** Memory fact anchor (FactRecord.factId); the deduplication key. */
  claimId: string;
  /** Presented text: the fact's subject/predicate/object rendering. */
  text: string;
  source: 'memory-recall';
  /** Source realm; verified by the caller at retrieval time. */
  realmId: string;
  /** Retrieval relevance score (searchRecall's original value). */
  score: number;
  /**
   * S8 V2 (design-guardrails §3.3): content origin attached at assembly.
   * A recalled fact carries the classification fixed at consolidation
   * (agent-produced for every claim the consolidator produces), so the
   * branch consumer sees "another agent said this", never an operator
   * instruction. Facts written before the field existed fall back to
   * kernel-resolved-realm.
   */
  provenance: ContentProvenance;
};

export type ContextAssemblyEvent =
  | { kind: 'context-assembled'; appendixEntries: number; realmId?: string }
  | {
      kind: 'context-trimmed';
      trimmed: number;
      reason: 'duplicate' | 'sensitive' | 'unavailable' | 'relevance';
      /**
       * Which assembler trimmed it. `skill-inputs` marks a skill-declared
       * input left unavailable (design-context-engineering §10.3); absent
       * (i.e. memory) keeps the V1 audit wording.
       */
      source?: 'memory' | 'skill-inputs';
    }
  | {
      kind: 'context-budget-exceeded';
      kept: number;
      limit: number;
      /**
       * Which budget fired and which source was truncated. Absent for the V1
       * memory-appendix cap (assembleBranchContext's own maxEntries); present
       * for the V3 per-branch total-budget allocation (budget.ts, design §5),
       * where the value names the truncated source.
       */
      source?: 'memory' | 'realm' | 'skill-inputs';
    }
  | {
      /**
       * S8 V2 (design-guardrails §4/§5): a kept appendix entry ran through the
       * content-risk decision chain and was annotated with its data boundary.
       * Outbound plan-mode assembly annotates (the classifier never refuses a
       * kernel-resolved-realm memory entry); `pass` entries emit nothing. The
       * event kind is the audit decision (`guardrail-annotated`).
       */
      kind: 'guardrail-annotated';
      entry: string;
      boundary: string;
      signals: readonly ContentSignal[];
    };

/**
 * Credential-shaped text predicate. Same shape judgement as the operator log's
 * `redact` (src/util/logger.ts): key-driven credential names and bearer /
 * private-key value shapes. An appendix entry whose presented text matches is
 * dropped rather than forwarded — memory recall must not smuggle a secret into
 * a branch payload under the cover of a contextual fact.
 */
const SENSITIVE_TEXT =
  /(Bearer\s+\S+|-----BEGIN (?:RSA )?PRIVATE KEY-----|(?:token|secret|password|api[_-]?key|credential)\s*[:=]\s*\S+)/i;

/** Render a fact's presented text (subject predicate object). */
export function renderFactText(fact: FactRecord): string {
  const objectText =
    typeof fact.object === 'string'
      ? fact.object
      : JSON.stringify(fact.object ?? null);
  return `${fact.subject} ${fact.predicate} ${objectText}`;
}

/**
 * Assemble the memory appendix for one intent's branches.
 *
 * Rules (V2 scope, design §10.2/§10.4):
 * - deduplicate by factId, keeping the **newest** copy (updatedAt wins; the
 *   recall set may carry the same fact from multiple memory stages) — every
 *   dropped duplicate is audited as `context-trimmed (duplicate)`;
 * - apply the relevance gate: entries scoring below `minScore` never reach a
 *   branch — audited as `context-trimmed (relevance)`. `minScore` is
 *   `undefined` by default (gate off; score is hybrid 0..1, calibration is
 *   deferred to #9 once real-load distributions exist);
 * - drop entries whose presented text is credential-shaped — audited as
 *   `context-trimmed (sensitive)`;
 * - sort by relevance descending and cap at `maxEntries` — an over-limit cap
 *   is audited as `context-budget-exceeded`, never silent;
 * - always concludes with `context-assembled` carrying the kept count.
 *
 * Caller-supplied explicit payload is outside this function's scope: it is
 * passed through untouched as an invariant pinned by the existing fan-out
 * tests.
 */
export function assembleBranchContext(args: {
  memoryHits: RecallHit[];
  maxEntries: number;
  minScore?: number;
}): { appendix: ContextAppendixEntry[]; events: ContextAssemblyEvent[] } {
  const { memoryHits, maxEntries, minScore } = args;
  const events: ContextAssemblyEvent[] = [];
  const byFact = new Map<string, RecallHit>();

  for (const hit of memoryHits) {
    const factId = hit.fact.factId;
    const prev = byFact.get(factId);
    if (prev === undefined) {
      byFact.set(factId, hit);
    } else {
      // design §4: same claim assembles once, the newest copy wins. The losing
      // copy never reaches a branch; the drop is what gets audited.
      if (hit.fact.updatedAt > prev.fact.updatedAt) byFact.set(factId, hit);
      events.push({ kind: 'context-trimmed', trimmed: 1, reason: 'duplicate' });
    }
  }

  const sorted = [...byFact.values()].sort((a, b) => b.score - a.score);
  const kept: ContextAppendixEntry[] = [];
  for (const hit of sorted) {
    if (minScore !== undefined && hit.score < minScore) {
      events.push({ kind: 'context-trimmed', trimmed: 1, reason: 'relevance' });
      continue;
    }
    const text = renderFactText(hit.fact);
    if (SENSITIVE_TEXT.test(text)) {
      events.push({ kind: 'context-trimmed', trimmed: 1, reason: 'sensitive' });
      continue;
    }
    // S8 V2 (design-guardrails §3.3/§4): every forwarded entry carries its
    // provenance and has run through the content-risk decision chain. The
    // entry's provenance is the origin classification fixed on the fact at
    // consolidation (agent-produced for claims; kernel-resolved-realm for
    // facts written before the field existed). Plan-mode assembly annotates
    // rather than refusing; an escalate verdict (external-url / credential
    // hit) also degrades to annotation here — this assembly point never
    // executes, so the L1 escalation belongs to the execute-destination
    // wiring (V3). A `pass` verdict emits nothing.
    const signals = scanContentSignals(text);
    const provenance: ContentProvenance = hit.fact.origin ?? 'kernel-resolved-realm';
    const handling = classifyContentRisk({
      provenance,
      destination: { kind: 'outbound', mode: 'plan' },
      signals,
    });
    if (handling.action === 'annotate' || handling.action === 'escalate') {
      events.push({
        kind: 'guardrail-annotated',
        entry: hit.fact.factId,
        boundary: `data-boundary:${provenance}`,
        signals,
      });
    }
    kept.push({
      claimId: hit.fact.factId,
      text,
      source: 'memory-recall',
      realmId: hit.fact.realmId,
      score: hit.score,
      provenance,
    });
  }

  const appendix = kept.slice(0, maxEntries);
  if (kept.length > maxEntries) {
    events.push({ kind: 'context-budget-exceeded', kept: maxEntries, limit: maxEntries });
  }
  events.push({ kind: 'context-assembled', appendixEntries: appendix.length });
  return { appendix, events };
}

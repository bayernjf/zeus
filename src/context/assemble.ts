import type { FactRecord, RecallHit } from '../memory/types.js';

/**
 * S1 context engineering V1 (design-context-engineering §10): memory assembly
 * into the branch dispatch context.
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
};

export type ContextAssemblyEvent =
  | { kind: 'context-assembled'; appendixEntries: number; realmId?: string }
  | { kind: 'context-trimmed'; trimmed: number; reason: 'duplicate' | 'sensitive' }
  | { kind: 'context-budget-exceeded'; kept: number; limit: number };

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
 * Rules (V1 scope, design §10.2):
 * - deduplicate by factId, keeping the highest score — every dropped duplicate
 *   is audited as `context-trimmed (duplicate)`;
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
}): { appendix: ContextAppendixEntry[]; events: ContextAssemblyEvent[] } {
  const { memoryHits, maxEntries } = args;
  const events: ContextAssemblyEvent[] = [];
  const byFact = new Map<string, RecallHit>();

  for (const hit of memoryHits) {
    const factId = hit.fact.factId;
    const prev = byFact.get(factId);
    if (prev === undefined) {
      byFact.set(factId, hit);
    } else {
      // A duplicate is dropped either way — the losing copy never reaches a
      // branch. Which copy loses is irrelevant to the contract; the drop is
      // what gets audited.
      if (hit.score > prev.score) byFact.set(factId, hit);
      events.push({ kind: 'context-trimmed', trimmed: 1, reason: 'duplicate' });
    }
  }

  const sorted = [...byFact.values()].sort((a, b) => b.score - a.score);
  const kept: ContextAppendixEntry[] = [];
  for (const hit of sorted) {
    const text = renderFactText(hit.fact);
    if (SENSITIVE_TEXT.test(text)) {
      events.push({ kind: 'context-trimmed', trimmed: 1, reason: 'sensitive' });
      continue;
    }
    kept.push({
      claimId: hit.fact.factId,
      text,
      source: 'memory-recall',
      realmId: hit.fact.realmId,
      score: hit.score,
    });
  }

  const appendix = kept.slice(0, maxEntries);
  if (kept.length > maxEntries) {
    events.push({ kind: 'context-budget-exceeded', kept: maxEntries, limit: maxEntries });
  }
  events.push({ kind: 'context-assembled', appendixEntries: appendix.length });
  return { appendix, events };
}

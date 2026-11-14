// D3-2: run-level context watermark. The per-intent assembly events already
// say what one intent's branches received; the watermark folds them into one
// run-level total (entries assembled / trimmed / over-budget) and adds a token
// estimate over the assembled payload, so context growth is observable per
// fan-out and compaction can be decided on facts rather than impressions.
// Pure functions: no runtime state, byte-stable.

import type { ContextAssemblyEvent } from '../../context/assemble.js';

/** One run's folded context shape. */
export type ContextWatermark = {
  /** Memory appendix entries that actually reached branch dispatch. */
  assembled: number;
  /** Entries dropped by an assembler (duplicate/sensitive/unavailable/relevance). */
  trimmed: number;
  /** Tool events where a context budget fired (memory cap, per-branch total, source truncation). */
  budgetExceeded: number;
  /** Characters of the assembled branch payload (appendix + skill inputs + dataDomain hits). */
  chars: number;
  /** Order-of-magnitude token estimate (chars / 4), for a compaction signal only. */
  tokens: number;
};

/** Fold this intent's assembly events into the run running total. `prev` is
 *  never mutated — the caller stores the returned value. */
export function accumulateWatermark(
  prev: ContextWatermark | undefined,
  events: readonly ContextAssemblyEvent[],
  extraChars = 0,
): ContextWatermark {
  const totals: ContextWatermark = prev === undefined
    ? { assembled: 0, trimmed: 0, budgetExceeded: 0, chars: 0, tokens: 0 }
    : { ...prev };
  for (const event of events) {
    if (event.kind === 'context-assembled') totals.assembled += event.appendixEntries;
    else if (event.kind === 'context-trimmed') totals.trimmed += event.trimmed;
    else if (event.kind === 'context-budget-exceeded') totals.budgetExceeded += 1;
  }
  totals.chars += Math.max(0, extraChars);
  totals.tokens = estimateTokens(totals.chars);
  return totals;
}

/** Rough token estimate (four characters per token), never zero for non-empty input. */
export function estimateTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / 4);
}

/** Characters of the assembled branch payload. The caller's explicit payload is
 *  outside the budget and is deliberately not counted. */
export function estimateContextChars(parts: {
  appendixTexts: readonly string[];
  skillInputs: unknown;
  dataDomainHits: unknown;
}): number {
  const json = (value: unknown): string => {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  };
  return (
    parts.appendixTexts.reduce((sum, text) => sum + text.length, 0) +
    json(parts.skillInputs).length +
    json(parts.dataDomainHits).length
  );
}

/** Human-readable summary for the `context-watermark` audit row. */
export function watermarkDetail(totals: ContextWatermark, branches: number): string {
  return `${totals.assembled} context entries assembled, ${totals.trimmed} trimmed, ${totals.budgetExceeded} over budget, ~${totals.tokens} tokens across ${branches} branch(es)`;
}

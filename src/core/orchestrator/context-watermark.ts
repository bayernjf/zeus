// D3-2: run-level context watermark. The per-intent assembly events already
// say what one intent's branches received; the watermark folds them into one
// run-level total (entries assembled / trimmed / over-budget) so context
// growth is observable per fan-out and compaction can be decided on facts
// rather than impressions. Pure functions: no runtime state, byte-stable.

import type { ContextAssemblyEvent } from '../../context/assemble.js';

/** One run's folded context shape. */
export type ContextWatermark = {
  /** Memory appendix entries that actually reached branch dispatch. */
  assembled: number;
  /** Entries dropped by an assembler (duplicate/sensitive/unavailable/relevance). */
  trimmed: number;
  /** Tool events where a context budget fired (memory cap, per-branch total, source truncation). */
  budgetExceeded: number;
};

/** Fold this intent's assembly events into the run running total. `prev` is
 *  never mutated — the caller stores the returned value. */
export function accumulateWatermark(
  prev: ContextWatermark | undefined,
  events: readonly ContextAssemblyEvent[],
): ContextWatermark {
  const totals: ContextWatermark = prev === undefined
    ? { assembled: 0, trimmed: 0, budgetExceeded: 0 }
    : { ...prev };
  for (const event of events) {
    if (event.kind === 'context-assembled') totals.assembled += event.appendixEntries;
    else if (event.kind === 'context-trimmed') totals.trimmed += event.trimmed;
    else if (event.kind === 'context-budget-exceeded') totals.budgetExceeded += 1;
  }
  return totals;
}

/** Human-readable summary for the `context-watermark` audit row. */
export function watermarkDetail(totals: ContextWatermark, branches: number): string {
  return `${totals.assembled} context entries assembled, ${totals.trimmed} trimmed, ${totals.budgetExceeded} over budget across ${branches} branch(es)`;
}

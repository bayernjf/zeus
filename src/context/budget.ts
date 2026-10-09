import type { RealmHit } from '../realm/types.js';
import type { ContextAppendixEntry, ContextAssemblyEvent } from './assemble.js';
import type { SkillInputEntry } from './skill-inputs.js';

/**
 * S1 context engineering V3 (design-context-engineering §5): per-branch
 * context budget allocation across the assembled sources.
 *
 * The assembly model has four sources with fixed priority (high → low):
 *   1. caller explicit payload (params.message / a2aMetadata) — never counted
 *      and never trimmed; it is not even an input to this allocator;
 *   2. skill-declared input assembly (SkillInputEntry[]);
 *   3. realm read-only hits (RealmHit[], already gated by dataPolicy upstream);
 *   4. memory recall appendix (ContextAppendixEntry[]).
 *
 * When the per-branch entry budget is exhausted the lowest-priority source is
 * truncated first; every truncation emits `context-budget-exceeded` carrying
 * the truncated source — never silent. This budget is orthogonal to the V1
 * memory-appendix cap (assembleBranchContext's own maxEntries) and to S4's
 * branch-count budget: those bound one source / the fan-out width, this bounds
 * the total context size of one branch.
 *
 * Entry counting is structural (number of entries); byte count is an
 * observation metric with no hard cap. The default limit is a structural
 * guard, not a performance calibration — numeric tuning is deferred to #9
 * once real-load distributions exist.
 *
 * Pure function over injected inputs: no kernel state, no IO, no write-back.
 */

/**
 * Default per-branch context entry limit (structural guard). Deliberately
 * loose: it must not change current behaviour under the existing source-level
 * caps (memory appendix default 20); calibration is deferred to #9.
 */
export const DEFAULT_BRANCH_CONTEXT_LIMIT = 64;

export type BranchContextBudgetInput = {
  /** Source 2: skill-declared input assembly (highest budget priority). */
  skillInputs: SkillInputEntry[];
  /** Source 3: realm read-only hits. */
  realmHits: RealmHit[];
  /** Source 4: memory recall appendix (lowest budget priority). */
  contextAppendix: ContextAppendixEntry[];
  /** Per-branch total entry budget (maxContextEntriesPerBranch). */
  limit: number;
};

export type BranchContextBudget = {
  skillInputs: SkillInputEntry[];
  realmHits: RealmHit[];
  contextAppendix: ContextAppendixEntry[];
  /** One `context-budget-exceeded` event per truncated source. */
  events: ContextAssemblyEvent[];
};

/**
 * Allocate one branch's context budget across sources 2–4 in priority order.
 * Each source keeps a prefix of its entries (sources are already ordered by
 * their own rules: memory by relevance desc, realm by the store's ranking);
 * a source that does not fit is truncated to the remaining slots, and every
 * lower-priority source is dropped entirely when no slots remain.
 */
export function allocateContextBudget(args: BranchContextBudgetInput): BranchContextBudget {
  const events: ContextAssemblyEvent[] = [];
  let remaining = Math.max(0, args.limit);

  const take = <T>(
    entries: T[],
    source: 'skill-inputs' | 'realm' | 'memory',
  ): T[] => {
    if (entries.length <= remaining) {
      remaining -= entries.length;
      return entries;
    }
    const kept = entries.slice(0, remaining);
    if (entries.length > 0) {
      events.push({
        kind: 'context-budget-exceeded',
        kept: kept.length,
        limit: args.limit,
        source,
      });
    }
    remaining = 0;
    return kept;
  };

  // Priority high → low; the explicit payload (source 1) is never in scope.
  const skillInputs = take(args.skillInputs, 'skill-inputs');
  const realmHits = take(args.realmHits, 'realm');
  const contextAppendix = take(args.contextAppendix, 'memory');

  return { skillInputs, realmHits, contextAppendix, events };
}

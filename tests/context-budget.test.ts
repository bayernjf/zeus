import { describe, expect, it } from 'vitest';
import { allocateContextBudget, DEFAULT_BRANCH_CONTEXT_LIMIT } from '../src/context/budget.js';
import type { ContextAppendixEntry } from '../src/context/assemble.js';
import type { SkillInputEntry } from '../src/context/skill-inputs.js';
import type { RealmHit } from '../src/realm/types.js';

/**
 * S1 context engineering V3 (design-context-engineering §5): the per-branch
 * context budget allocator's contract — fixed priority (skill inputs > realm
 * hits > memory appendix), lowest-priority source truncated first, every
 * truncation audited with its source, caller explicit payload never in scope.
 * The allocator is a pure function over hand-built entries.
 */

function skillInput(name: string, source: 'explicit' | 'unavailable' = 'explicit'): SkillInputEntry {
  return source === 'explicit' ? { name, source, value: name } : { name, source };
}

function realmHit(itemId: string): RealmHit {
  return { itemId, tags: [], snippet: `snippet ${itemId}`, modifiedAt: '2026-10-09T00:00:00.000Z' };
}

function memoryEntry(claimId: string): ContextAppendixEntry {
  return { claimId, text: `fact ${claimId}`, source: 'memory-recall', realmId: 'personal', score: 0.5, provenance: 'kernel-resolved-realm' };
}

describe('allocateContextBudget', () => {
  it('keeps every source untouched when the budget fits, with zero events', () => {
    const out = allocateContextBudget({
      skillInputs: [skillInput('a'), skillInput('b')],
      realmHits: [realmHit('r1')],
      contextAppendix: [memoryEntry('m1'), memoryEntry('m2')],
      limit: DEFAULT_BRANCH_CONTEXT_LIMIT,
    });
    expect(out.skillInputs).toHaveLength(2);
    expect(out.realmHits).toHaveLength(1);
    expect(out.contextAppendix).toHaveLength(2);
    expect(out.events).toEqual([]);
  });

  it('truncates the memory appendix first (lowest priority), keeping skill inputs and realm hits', () => {
    const out = allocateContextBudget({
      skillInputs: [skillInput('a'), skillInput('b')],
      realmHits: [realmHit('r1'), realmHit('r2')],
      contextAppendix: [memoryEntry('m1'), memoryEntry('m2'), memoryEntry('m3')],
      limit: 5,
    });
    expect(out.skillInputs).toHaveLength(2);
    expect(out.realmHits.map(h => h.itemId)).toEqual(['r1', 'r2']);
    expect(out.contextAppendix.map(e => e.claimId)).toEqual(['m1']);
    expect(out.events).toEqual([
      { kind: 'context-budget-exceeded', kept: 1, limit: 5, source: 'memory' },
    ]);
  });

  it('drops memory entirely and truncates realm hits when the budget is tighter', () => {
    const out = allocateContextBudget({
      skillInputs: [skillInput('a'), skillInput('b')],
      realmHits: [realmHit('r1'), realmHit('r2'), realmHit('r3')],
      contextAppendix: [memoryEntry('m1')],
      limit: 4,
    });
    expect(out.skillInputs).toHaveLength(2);
    expect(out.realmHits.map(h => h.itemId)).toEqual(['r1', 'r2']);
    expect(out.contextAppendix).toEqual([]);
    expect(out.events).toEqual([
      { kind: 'context-budget-exceeded', kept: 2, limit: 4, source: 'realm' },
      { kind: 'context-budget-exceeded', kept: 0, limit: 4, source: 'memory' },
    ]);
  });

  it('truncates skill inputs last, only when nothing lower-priority remains', () => {
    const out = allocateContextBudget({
      skillInputs: [skillInput('a'), skillInput('b'), skillInput('c')],
      realmHits: [],
      contextAppendix: [],
      limit: 2,
    });
    expect(out.skillInputs.map(e => e.name)).toEqual(['a', 'b']);
    expect(out.events).toEqual([
      { kind: 'context-budget-exceeded', kept: 2, limit: 2, source: 'skill-inputs' },
    ]);
  });

  it('emits one event per dropped source at limit 0', () => {
    const out = allocateContextBudget({
      skillInputs: [skillInput('a')],
      realmHits: [realmHit('r1')],
      contextAppendix: [memoryEntry('m1')],
      limit: 0,
    });
    expect(out.skillInputs).toEqual([]);
    expect(out.realmHits).toEqual([]);
    expect(out.contextAppendix).toEqual([]);
    expect(out.events.map(e => e.kind)).toEqual([
      'context-budget-exceeded',
      'context-budget-exceeded',
      'context-budget-exceeded',
    ]);
  });

  it('does not truncate at the exact boundary (total entries === limit)', () => {
    const out = allocateContextBudget({
      skillInputs: [skillInput('a')],
      realmHits: [realmHit('r1')],
      contextAppendix: [memoryEntry('m1')],
      limit: 3,
    });
    expect(out.events).toEqual([]);
    expect(out.skillInputs).toHaveLength(1);
    expect(out.realmHits).toHaveLength(1);
    expect(out.contextAppendix).toHaveLength(1);
  });

  it('keeps a prefix of each source and never mutates the input arrays', () => {
    const skillInputs = [skillInput('a'), skillInput('b')];
    const realmHits = [realmHit('r1'), realmHit('r2'), realmHit('r3')];
    const contextAppendix = [memoryEntry('m1'), memoryEntry('m2')];
    const out = allocateContextBudget({ skillInputs, realmHits, contextAppendix, limit: 4 });
    expect(out.realmHits.map(h => h.itemId)).toEqual(['r1', 'r2']);
    expect(skillInputs).toHaveLength(2);
    expect(realmHits).toHaveLength(3);
    expect(contextAppendix).toHaveLength(2);
  });
});

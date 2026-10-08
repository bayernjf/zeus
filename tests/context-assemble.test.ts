import { describe, expect, it } from 'vitest';
import { assembleBranchContext, renderFactText } from '../src/context/assemble.js';
import type { RecallHit } from '../src/memory/types.js';

/**
 * S1 context engineering V1 (design-context-engineering §10.2): the pure
 * assembler's contract — deduplicate by fact, drop credential-shaped text,
 * cap by relevance score, and never trim silently. The kernel's retrieval and
 * domain isolation are exercised in boot-context-assembly.test.ts; here the
 * assembler is tested over hand-built hits.
 */

function hit(
  factId: string,
  score: number,
  subject: string,
  predicate: string,
  object: unknown,
  realmId = 'personal',
): RecallHit {
  return {
    fact: {
      factId,
      realmId,
      subject,
      predicate,
      object,
      status: 'active',
      provenance: [],
      confidence: 0.9,
      version: 1,
      updatedAt: '2026-10-09T00:00:00.000Z',
    },
    score,
    lexical: score,
    semantic: 0,
  };
}

const common = {
  source: 'memory-recall' as const,
};

describe('assembleBranchContext', () => {
  it('caps by relevance: keeps the top-N in descending score and audits the cap', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [
        hit('f5', 0.1, 'user', 'likes', 'tea'),
        hit('f1', 0.9, 'user', 'prefers', 'typescript'),
        hit('f2', 0.8, 'user', 'uses', 'node'),
        hit('f3', 0.7, 'user', 'edits', 'vim'),
        hit('f4', 0.6, 'user', 'hosts', 'zeus'),
      ],
      maxEntries: 3,
    });
    expect(appendix.map(entry => entry.claimId)).toEqual(['f1', 'f2', 'f3']);
    expect(appendix.map(entry => entry.score)).toEqual([0.9, 0.8, 0.7]);
    expect(events).toContainEqual({ kind: 'context-budget-exceeded', kept: 3, limit: 3 });
    expect(events.at(-1)).toEqual({ kind: 'context-assembled', appendixEntries: 3 });
  });

  it('deduplicates by factId keeping the highest score, and audits each drop', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [
        hit('f1', 0.4, 'user', 'prefers', 'rust'),
        hit('f1', 0.9, 'user', 'prefers', 'typescript'),
        hit('f2', 0.6, 'user', 'uses', 'node'),
      ],
      maxEntries: 20,
    });
    expect(appendix.map(entry => entry.claimId)).toEqual(['f1', 'f2']);
    expect(appendix[0]!.text).toContain('typescript');
    expect(events.filter(event => event.kind === 'context-trimmed')).toEqual([
      { kind: 'context-trimmed', trimmed: 1, reason: 'duplicate' },
    ]);
  });

  it('drops credential-shaped text as sensitive, keeping the rest', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [
        hit('f1', 0.9, 'user', 'stored', 'Bearer abc123def456'),
        hit('f2', 0.8, 'user', 'uses', 'api_key: sk-live-987'),
        hit('f3', 0.7, 'user', 'prefers', 'typescript'),
      ],
      maxEntries: 20,
    });
    expect(appendix.map(entry => entry.claimId)).toEqual(['f3']);
    expect(events.filter(event => event.kind === 'context-trimmed')).toEqual([
      { kind: 'context-trimmed', trimmed: 1, reason: 'sensitive' },
      { kind: 'context-trimmed', trimmed: 1, reason: 'sensitive' },
    ]);
  });

  it('does not over-trim ordinary text', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [hit('f1', 0.9, 'user', 'wrote', 'a secret plan for the token budget')],
      maxEntries: 20,
    });
    expect(appendix).toHaveLength(1);
    expect(events.filter(event => event.kind === 'context-trimmed')).toEqual([]);
  });

  it('audits the budget only when the cap is actually exceeded', () => {
    const atLimit = assembleBranchContext({
      memoryHits: [hit('f1', 0.9, 'user', 'a', 'x'), hit('f2', 0.8, 'user', 'b', 'y')],
      maxEntries: 2,
    });
    expect(atLimit.events.some(event => event.kind === 'context-budget-exceeded')).toBe(false);
    const over = assembleBranchContext({
      memoryHits: [hit('f1', 0.9, 'user', 'a', 'x'), hit('f2', 0.8, 'user', 'b', 'y')],
      maxEntries: 1,
    });
    expect(over.events).toContainEqual({ kind: 'context-budget-exceeded', kept: 1, limit: 1 });
  });

  it('empty hits produce an empty appendix and only the assembled event', () => {
    const { appendix, events } = assembleBranchContext({ memoryHits: [], maxEntries: 20 });
    expect(appendix).toEqual([]);
    expect(events).toEqual([{ kind: 'context-assembled', appendixEntries: 0 }]);
  });

  it('a zero cap assembles nothing and audits the refusal to keep entries', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [hit('f1', 0.9, 'user', 'a', 'x')],
      maxEntries: 0,
    });
    expect(appendix).toEqual([]);
    expect(events).toContainEqual({ kind: 'context-budget-exceeded', kept: 0, limit: 0 });
  });

  it('writes the memory-recall source and the fact realm onto every entry', () => {
    const { appendix } = assembleBranchContext({
      memoryHits: [hit('f1', 0.9, 'user', 'prefers', 'typescript', 'enterprise')],
      maxEntries: 20,
    });
    expect(appendix[0]).toMatchObject({
      ...common,
      claimId: 'f1',
      realmId: 'enterprise',
      score: 0.9,
    });
  });

  it('never receives or forwards caller payload — it only shapes the appendix', () => {
    // The explicit-payload passthrough invariant is pinned by the existing
    // fan-out tests; here we pin the negative: the assembler's output carries
    // exactly the appendix shape, no transport or caller fields.
    const { appendix, events } = assembleBranchContext({
      memoryHits: [hit('f1', 0.9, 'user', 'prefers', 'typescript')],
      maxEntries: 20,
    });
    for (const entry of appendix) {
      expect(Object.keys(entry).sort()).toEqual(['claimId', 'realmId', 'score', 'source', 'text']);
    }
    expect(events.at(-1)).toEqual({ kind: 'context-assembled', appendixEntries: 1 });
  });
});

describe('renderFactText', () => {
  it('renders a string object inline', () => {
    const text = renderFactText(hit('f1', 0.9, 'user', 'prefers', 'typescript').fact);
    expect(text).toBe('user prefers typescript');
  });

  it('serialises a non-scalar object', () => {
    const text = renderFactText(hit('f1', 0.9, 'user', 'holds', { role: 'driver' }).fact);
    expect(text).toBe('user holds {"role":"driver"}');
  });
});

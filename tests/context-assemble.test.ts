import { describe, expect, it } from 'vitest';
import { assembleBranchContext, renderFactText } from '../src/context/assemble.js';
import type { RecallHit } from '../src/memory/types.js';

/**
 * S1 context engineering V1+V2 (design-context-engineering §10.2/§10.4): the
 * pure assembler's contract — deduplicate by fact (newest copy wins), drop
 * credential-shaped text, gate by relevance, cap by score, and never trim
 * silently. The kernel's retrieval and domain isolation are exercised in
 * boot-context-assembly.test.ts; here the assembler is tested over hand-built
 * hits.
 */

function hit(
  factId: string,
  score: number,
  subject: string,
  predicate: string,
  object: unknown,
  realmId = 'personal',
  updatedAt = '2026-10-09T00:00:00.000Z',
  origin?: 'agent-produced' | 'kernel-resolved-realm',
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
      ...(origin !== undefined ? { origin } : {}),
      confidence: 0.9,
      version: 1,
      updatedAt,
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

  it('deduplicates by factId keeping the newest copy, and audits each drop', () => {
    // design §4: the same claim assembles once; when several recall hits carry
    // the same fact, the newest update wins (a later memory stage supersedes an
    // earlier rendering), not the highest score. Ordering after deduplication
    // is still relevance-descending.
    const { appendix, events } = assembleBranchContext({
      memoryHits: [
        hit('f1', 0.9, 'user', 'prefers', 'rust', 'personal', '2026-10-01T00:00:00.000Z'),
        hit('f1', 0.4, 'user', 'prefers', 'typescript', 'personal', '2026-10-08T00:00:00.000Z'),
        hit('f2', 0.6, 'user', 'uses', 'node'),
      ],
      maxEntries: 20,
    });
    expect(appendix.map(entry => entry.claimId)).toEqual(['f2', 'f1']);
    const newest = appendix.find(entry => entry.claimId === 'f1')!;
    expect(newest.text).toContain('typescript');
    expect(events.filter(event => event.kind === 'context-trimmed')).toEqual([
      { kind: 'context-trimmed', trimmed: 1, reason: 'duplicate' },
    ]);
  });

  it('gates by relevance: drops entries below minScore and audits each drop', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [
        hit('f1', 0.9, 'user', 'prefers', 'typescript'),
        hit('f2', 0.6, 'user', 'uses', 'node'),
        hit('f3', 0.2, 'user', 'likes', 'tea'),
        hit('f4', 0.1, 'user', 'owns', 'a cat'),
      ],
      maxEntries: 20,
      minScore: 0.3,
    });
    expect(appendix.map(entry => entry.claimId)).toEqual(['f1', 'f2']);
    expect(events.filter(event => event.kind === 'context-trimmed')).toEqual([
      { kind: 'context-trimmed', trimmed: 1, reason: 'relevance' },
      { kind: 'context-trimmed', trimmed: 1, reason: 'relevance' },
    ]);
  });

  it('keeps an entry scoring exactly at the gate threshold', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [hit('f1', 0.3, 'user', 'prefers', 'typescript')],
      maxEntries: 20,
      minScore: 0.3,
    });
    expect(appendix).toHaveLength(1);
    expect(events.filter(event => event.kind === 'context-trimmed')).toEqual([]);
  });

  it('leaves the gate off when minScore is absent — no relevance trimming', () => {
    const { appendix, events } = assembleBranchContext({
      memoryHits: [hit('f1', 0.01, 'user', 'likes', 'tea')],
      maxEntries: 20,
    });
    expect(appendix).toHaveLength(1);
    expect(events.filter(event => event.kind === 'context-trimmed')).toEqual([]);
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
      expect(Object.keys(entry).sort()).toEqual(['claimId', 'provenance', 'realmId', 'score', 'source', 'text']);
    }
    expect(events.at(-1)).toEqual({ kind: 'context-assembled', appendixEntries: 1 });
  });

  it('forwards the fact origin as the entry provenance (S8 V2)', () => {
    // design-guardrails §3.3: the classification fixed at consolidation
    // travels with the fact into recall, so the branch sees "another agent
    // said this" — agent-produced — never an operator instruction.
    const { appendix } = assembleBranchContext({
      memoryHits: [
        hit('f1', 0.9, 'alpha', 'reported', 'the build is green', 'personal', '2026-10-09T00:00:00.000Z', 'agent-produced'),
        hit('f2', 0.8, 'user', 'prefers', 'typescript', 'personal', '2026-10-09T00:00:00.000Z', 'kernel-resolved-realm'),
      ],
      maxEntries: 20,
    });
    expect(appendix.find(e => e.claimId === 'f1')!.provenance).toBe('agent-produced');
    expect(appendix.find(e => e.claimId === 'f2')!.provenance).toBe('kernel-resolved-realm');
  });

  it('falls back to kernel-resolved-realm for facts written before origin existed', () => {
    const { appendix } = assembleBranchContext({
      memoryHits: [hit('f1', 0.9, 'user', 'prefers', 'typescript')],
      maxEntries: 20,
    });
    expect(appendix[0]!.provenance).toBe('kernel-resolved-realm');
  });

  it('carries the agent-produced boundary on an annotated recall (S8 V2)', () => {
    const { events } = assembleBranchContext({
      memoryHits: [
        hit('f1', 0.9, 'alpha', 'says', 'see https://external.example.com/x', 'personal', '2026-10-09T00:00:00.000Z', 'agent-produced'),
      ],
      maxEntries: 20,
    });
    expect(events).toContainEqual({
      kind: 'guardrail-annotated',
      entry: 'f1',
      boundary: 'data-boundary:agent-produced',
      signals: ['external-url'],
    });
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

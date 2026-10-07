import { describe, expect, it, vi } from 'vitest';
import { rankCandidates, recognizeIntent, tokenize } from '../src/intent/recognize.js';
import type { DecisionBackend } from '../src/decision/types.js';

const CATALOG = [
  { id: 'code-review', name: 'Code Review', description: 'review a pull request for defects and style' },
  { id: 'research', name: 'Deep Research', description: 'multi-source research across web and documents' },
  { id: 'release', name: 'Release Notes', description: 'draft changelog and release notes' },
];

function mockBackend(overrides: Partial<DecisionBackend> = {}): DecisionBackend & { choice: ReturnType<typeof vi.fn> } {
  const choice = vi.fn(async () => ({
    choice: 'research',
    probabilities: { research: 0.92 },
    confidence: 0.92,
    calibrated: false,
    decisionAt: '2026-10-03T00:00:00.000Z',
  }));
  const backend = {
    kind: 'llm' as const,
    model: 'agnes-2.5-flash',
    noul: vi.fn(async () => ({ probability: 0.5, confidence: 0.5, calibrated: false, decisionAt: 'x' })),
    score: vi.fn(async () => ({ score: 50, distribution: {}, confidence: 0.5, calibrated: false, decisionAt: 'x' })),
    choice,
    ...overrides,
  };
  return backend as DecisionBackend & { choice: typeof choice };
}

describe('tokenize', () => {
  it('keeps ASCII words and CJK runs', () => {
    expect(tokenize('帮我 review 一下 PR')).toEqual(['帮我', 'review', '一下', 'pr']);
  });
  it('lowercases and drops punctuation', () => {
    expect(tokenize('Research, please!')).toEqual(['research', 'please']);
  });
  it('returns [] on empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('rankCandidates', () => {
  it('weights id/name above description', () => {
    const ranked = rankCandidates(CATALOG, 'research the web');
    expect(ranked[0]?.skill).toBe('research');
  });
  it('caps at the limit and keeps deterministic order', () => {
    const ranked = rankCandidates(CATALOG, 'review', 1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.skill).toBe('code-review');
  });
  it('drops entries with zero overlap', () => {
    const ranked = rankCandidates(CATALOG, 'unrelated topic');
    expect(ranked).toHaveLength(0);
  });
});

describe('recognizeIntent (local rule path)', () => {
  it('fails closed with no candidates', async () => {
    const result = await recognizeIntent({ text: 'unrelated', catalog: CATALOG });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-candidates');
  });

  it('resolves a unique best match locally with zero model involvement', async () => {
    const result = await recognizeIntent({ text: 'review this pull request', catalog: CATALOG });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent).toEqual({ skill: 'code-review', params: {}, mode: 'plan' });
      expect(result.confidence).toBe(0.5);
      expect(result.backend).toBeNull();
    }
  });

  it('fails closed on a tie', async () => {
    const tieCatalog = [
      { id: 'alpha', name: 'Alpha Task', description: 'generic alpha' },
      { id: 'beta', name: 'Beta Task', description: 'generic beta' },
    ];
    const result = await recognizeIntent({ text: 'generic task', catalog: tieCatalog });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous');
  });

  it('does NOT touch the backend by default, even when one exists (data sovereignty)', async () => {
    const backend = mockBackend();
    const result = await recognizeIntent({ text: 'review this pr', catalog: CATALOG, backend });
    expect(result.ok).toBe(true);
    expect(backend.choice).not.toHaveBeenCalled();
  });

  it('reports no-backend when useModel is requested but none is configured', async () => {
    const result = await recognizeIntent({ text: 'review this pr', catalog: CATALOG, useModel: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-backend');
  });
});

describe('recognizeIntent (model path, explicit opt-in)', () => {
  it('yields an intent on a high-confidence in-candidate choice', async () => {
    const backend = mockBackend();
    const result = await recognizeIntent({ text: 'deep research on agents', catalog: CATALOG, backend, useModel: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.skill).toBe('research');
      expect(result.intent.mode).toBe('plan');
      expect(result.backend).toEqual({ kind: 'llm', model: 'agnes-2.5-flash' });
    }
  });

  it('asks over the whole catalogue when the ranker finds no lexical match', async () => {
    // A CJK instruction against an English catalogue has zero literal overlap, so
    // the ranker offers nothing. That used to end the call before the model was
    // ever asked - the one case where an explicitly consulted model was the only
    // thing that could answer.
    const backend = mockBackend();
    const result = await recognizeIntent({ text: '整理今天的部署状态', catalog: CATALOG, backend, useModel: true });
    expect(backend.choice).toHaveBeenCalledTimes(1);
    const request = backend.choice.mock.calls[0]![0];
    expect(request.options).toEqual(['code-review', 'release', 'research']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.intent.skill).toBe('research');
  });

  it('caps the fallback options deterministically', async () => {
    const wide = Array.from({ length: 35 }, (_, i) => ({
      id: `skill-${String(i).padStart(2, '0')}`,
      name: `Skill ${i}`,
      description: 'nothing lexically shared with the instruction',
    }));
    const backend = mockBackend({
      choice: vi.fn(async () => ({ choice: 'skill-05', probabilities: {}, confidence: 0.9, calibrated: false, decisionAt: 'x' })),
    });
    const result = await recognizeIntent({ text: '部署状态', catalog: wide, backend, useModel: true });
    const request = backend.choice.mock.calls[0]![0];
    expect(request.options).toHaveLength(30);
    expect(request.options[0]).toBe('skill-00');
    expect(request.options).toContain('skill-05');
    expect(request.options).not.toContain('skill-34');
    expect(result.ok).toBe(true);
  });

  it('still refuses when there is no catalogue to offer the model', async () => {
    const result = await recognizeIntent({ text: '部署状态', catalog: [], backend: mockBackend(), useModel: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-candidates');
  });

  it('reports no-candidates (not no-backend) when neither a match nor a backend exists', async () => {
    // Which of the two fail-closed reasons wins is a contract: the ranker had
    // nothing to say, and that is what the operator needs to hear first.
    const result = await recognizeIntent({ text: '部署状态', catalog: CATALOG, useModel: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-candidates');
  });

  it('sends the instruction as declared state keys only', async () => {
    const backend = mockBackend();
    await recognizeIntent({ text: 'review the pr', catalog: CATALOG, backend, useModel: true, realm: 'enterprise' });
    expect(backend.choice).toHaveBeenCalledTimes(1);
    const request = backend.choice.mock.calls[0]![0];
    expect(request.state).toEqual({ instruction: 'review the pr', realm: 'enterprise' });
    expect(request.stateKeys).toEqual(['instruction', 'realm']);
    expect(request.options).toContain('code-review');
    expect(request.realm).toBe('enterprise');
  });

  it('fails closed when the model answers outside the candidates', async () => {
    const backend = mockBackend({ choice: vi.fn(async () => ({ choice: 'not-a-skill', probabilities: {}, confidence: 0.99, calibrated: false, decisionAt: 'x' })) });
    const result = await recognizeIntent({ text: 'review this pr', catalog: CATALOG, backend, useModel: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-choice');
  });

  it('fails closed below the confidence threshold', async () => {
    const backend = mockBackend({ choice: vi.fn(async () => ({ choice: 'research', probabilities: {}, confidence: 0.4, calibrated: false, decisionAt: 'x' })) });
    const result = await recognizeIntent({ text: 'research agents', catalog: CATALOG, backend, useModel: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('low-confidence');
  });

  it('fails closed when the backend errors', async () => {
    const backend = mockBackend({ choice: vi.fn(async () => { throw new Error('upstream 500'); }) });
    const result = await recognizeIntent({ text: 'research agents', catalog: CATALOG, backend, useModel: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('backend-unavailable');
  });
});

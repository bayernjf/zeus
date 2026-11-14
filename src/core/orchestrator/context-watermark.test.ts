import { describe, expect, it } from 'vitest';
import type { ContextAssemblyEvent } from '../../context/assemble.js';
import {
  accumulateWatermark,
  estimateContextChars,
  estimateTokens,
  watermarkDetail,
} from './context-watermark.js';

const EVENTS: ContextAssemblyEvent[] = [
  { kind: 'context-trimmed', trimmed: 2, reason: 'duplicate' },
  { kind: 'context-trimmed', trimmed: 1, reason: 'relevance' },
  { kind: 'context-budget-exceeded', kept: 3, limit: 3 },
  { kind: 'context-assembled', appendixEntries: 3 },
  // A guardrail event shape-changes the appendix annotation, not its size —
  // it must never move the watermark.
  { kind: 'guardrail-annotated', entry: 'fact-1', boundary: 'agent-produced', signals: [] },
];

describe('run-level context watermark (D3-2)', () => {
  it('folds assembly events and the assembled payload size into totals', () => {
    expect(accumulateWatermark(undefined, EVENTS, 40)).toEqual({
      assembled: 3,
      trimmed: 3,
      budgetExceeded: 1,
      chars: 40,
      tokens: 10,
    });
  });

  it('is immutable: the previous run total is never mutated', () => {
    const prev = { assembled: 1, trimmed: 0, budgetExceeded: 0, chars: 8, tokens: 2 };
    const next = accumulateWatermark(prev, EVENTS, 40);
    expect(next).toEqual({ assembled: 4, trimmed: 3, budgetExceeded: 1, chars: 48, tokens: 12 });
    expect(prev).toEqual({ assembled: 1, trimmed: 0, budgetExceeded: 0, chars: 8, tokens: 2 });
  });

  it('starts from zero when no run total exists yet', () => {
    expect(accumulateWatermark(undefined, [])).toEqual({ assembled: 0, trimmed: 0, budgetExceeded: 0, chars: 0, tokens: 0 });
  });

  it('estimates tokens conservatively and never rounds a non-empty payload to zero', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(3)).toBe(1);
    expect(estimateTokens(40)).toBe(10);
  });

  it('measures appendix text plus assembled skill inputs and dataDomain hits', () => {
    expect(estimateContextChars({
      appendixTexts: ['abc'],
      skillInputs: undefined,
      dataDomainHits: [],
    })).toBe(5); // 3 + '' + '[]' (2)
  });

  it('renders a stable human-readable detail for the audit row', () => {
    expect(watermarkDetail({ assembled: 3, trimmed: 3, budgetExceeded: 1, chars: 40, tokens: 10 }, 4))
      .toBe('3 context entries assembled, 3 trimmed, 1 over budget, ~10 tokens across 4 branch(es)');
  });
});

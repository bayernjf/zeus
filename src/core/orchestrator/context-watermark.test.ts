import { describe, expect, it } from 'vitest';
import type { ContextAssemblyEvent } from '../../context/assemble.js';
import { accumulateWatermark, watermarkDetail } from './context-watermark.js';

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
  it('folds assembly events into assembled/trimmed/over-budget totals', () => {
    expect(accumulateWatermark(undefined, EVENTS)).toEqual({ assembled: 3, trimmed: 3, budgetExceeded: 1 });
  });

  it('is immutable: the previous run total is never mutated', () => {
    const prev = { assembled: 1, trimmed: 0, budgetExceeded: 0 };
    const next = accumulateWatermark(prev, EVENTS);
    expect(next).toEqual({ assembled: 4, trimmed: 3, budgetExceeded: 1 });
    expect(prev).toEqual({ assembled: 1, trimmed: 0, budgetExceeded: 0 });
  });

  it('starts from zero when no run total exists yet', () => {
    expect(accumulateWatermark(undefined, [])).toEqual({ assembled: 0, trimmed: 0, budgetExceeded: 0 });
  });

  it('renders a stable human-readable detail for the audit row', () => {
    expect(watermarkDetail({ assembled: 3, trimmed: 3, budgetExceeded: 1 }, 4))
      .toBe('3 context entries assembled, 3 trimmed, 1 over budget across 4 branch(es)');
  });
});

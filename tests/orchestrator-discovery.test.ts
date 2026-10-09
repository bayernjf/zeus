// design-tool-discovery (tech map S11) V1: selectCandidates orders the unified
// skill/tool candidate face (named pin -> automatic -> trust -> capability),
// and recoverChain walks the fixed four-step recovery chain. Every input is a
// caller-supplied snapshot; the module touches no live process (design §6 V1).
import { describe, expect, it } from 'vitest';
import { AUDIT_DECISIONS } from '../src/dispatch/dispatcher.js';
import {
  recoverChain,
  selectCandidates,
  type ChainFailure,
  type SelectionContext,
} from '../src/orchestrator/discovery.js';

const ctx = (over: Partial<SelectionContext>): SelectionContext => ({
  skillId: 'research',
  tier: 'tier-3',
  readOnlyTagged: true,
  capabilityGranted: true,
  load: {
    inFlightOf: () => 0,
    capOf: () => Infinity,
  },
  ...over,
});

describe('selectCandidates (S11 V1)', () => {
  it('explicit names are a hard pin, returned first and never saturated-filtered', () => {
    const c = ctx({
      named: ['a1', 'a2'],
      candidatePool: ['b1', 'b2'],
      load: {
        // named providers are saturated; automatic candidates are idle — the
        // pin must survive, the auto face must still be filtered normally.
        inFlightOf: (p) => (p.startsWith('a') ? 99 : 0),
        capOf: () => 1,
      },
    });
    expect(selectCandidates('research', c).map((x) => x.provider)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('automatic candidates drop saturated providers', () => {
    const c = ctx({
      candidatePool: ['p1', 'p2', 'p3'],
      load: {
        inFlightOf: (p) => (p === 'p2' ? 5 : 0),
        capOf: () => 4,
      },
    });
    expect(selectCandidates('research', c).map((x) => x.provider)).toEqual(['p1', 'p3']);
  });

  it('excluded names are omitted from both faces', () => {
    const c = ctx({
      named: ['a1', 'a2'],
      candidatePool: ['a1', 'b2'],
      excludedNames: ['a1'],
    });
    expect(selectCandidates('research', c).map((x) => x.provider)).toEqual(['a2', 'b2']);
  });

  it('tier-1 callers fail closed on a non-read-only skill (zero candidates)', () => {
    const c = ctx({ tier: 'tier-1', readOnlyTagged: false, named: ['a1'], candidatePool: ['b1'] });
    expect(selectCandidates('research', c)).toEqual([]);
  });

  it('tier-1 callers may reach read-only tagged skills', () => {
    const c = ctx({ tier: 'tier-1', readOnlyTagged: true, candidatePool: ['b1'] });
    expect(selectCandidates('research', c).map((x) => x.provider)).toEqual(['b1']);
  });

  it('capability face: no grant constrains every candidate to plan', () => {
    const c = ctx({ capabilityGranted: false, named: ['a1'], candidatePool: ['b1'] });
    const out = selectCandidates('research', c);
    expect(out.every((x) => x.mode === 'plan')).toBe(true);
  });

  it('capability face: a grant allows execute', () => {
    const c = ctx({ capabilityGranted: true, named: ['a1'] });
    expect(selectCandidates('research', c)[0]!.mode).toBe('execute');
  });

  it('no named, no pool: empty face, not a crash', () => {
    expect(selectCandidates('research', ctx({}))).toEqual([]);
  });

  it('every candidate carries the skill id and an optional tool slot', () => {
    const c = ctx({ candidatePool: ['b1'] });
    const out = selectCandidates('research', c);
    expect(out[0]!.skillId).toBe('research');
    expect(out[0]!.tool).toBeUndefined();
  });
});

describe('recoverChain (S11 V1)', () => {
  const fail = (over: Partial<ChainFailure>): ChainFailure => ({
    step: 's1',
    idempotent: true,
    retriesLeft: 1,
    highStakes: false,
    circuitOpen: false,
    hasAlternateProvider: true,
    requiredStep: true,
    ...over,
  });

  it('high-stakes skips retry entirely (escalate)', () => {
    expect(recoverChain(fail({ highStakes: true }))).toBe('escalate');
  });

  it('idempotent with retries left and circuit closed retries', () => {
    expect(recoverChain(fail({ idempotent: true, retriesLeft: 2 }))).toBe('retry');
  });

  it('non-idempotent failure switches to an alternate provider', () => {
    expect(recoverChain(fail({ idempotent: false, hasAlternateProvider: true }))).toBe('switch');
  });

  it('a non-required step degrades (skips the step, keeps converging)', () => {
    expect(
      recoverChain(fail({ idempotent: false, hasAlternateProvider: false, requiredStep: false })),
    ).toBe('degrade');
  });

  it('otherwise escalates to the operator exit', () => {
    expect(recoverChain(fail({ idempotent: false, hasAlternateProvider: false, requiredStep: true }))).toBe(
      'escalate',
    );
  });

  it('circuit open refuses automatic retry (falls through)', () => {
    expect(recoverChain(fail({ circuitOpen: true, idempotent: true, retriesLeft: 3 }))).not.toBe('retry');
  });

  it('circuit open refuses automatic switch for an optional step', () => {
    expect(
      recoverChain(fail({ circuitOpen: true, idempotent: false, hasAlternateProvider: true, requiredStep: false })),
    ).toBe('degrade');
  });

  it('the selection/recovery chain is audited on the governance spine', () => {
    for (const d of ['tool-selected', 'tool-failed', 'chain-retried', 'chain-switched', 'chain-degraded'] as const) {
      expect(AUDIT_DECISIONS).toContain(d);
    }
  });
});

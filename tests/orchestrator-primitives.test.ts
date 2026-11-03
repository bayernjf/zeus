import { describe, expect, it } from 'vitest';
import { mergeBranches } from '../src/orchestrator/merge.js';
import { aggregate, extractPositions, extractStance } from '../src/orchestrator/aggregate.js';
import { detectConflicts } from '../src/orchestrator/conflict.js';
import type { BranchOutcome } from '../src/orchestrator/types.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';

function statusEvent(vassal: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId: `${vassal}-task`, contextId: 'ctx', status: { state }, final: state === 'completed' };
}

function taskWithStance(id: string, stance: unknown, extra: Record<string, unknown> = {}): Task {
  return {
    kind: 'task',
    id,
    contextId: 'ctx',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { ...extra, stance } }] }],
  };
}

function branch(vassal: string, overrides: Partial<BranchOutcome> = {}): BranchOutcome {
  return {
    vassal,
    runId: `run:${vassal}`,
    ok: true,
    taskId: `${vassal}-task`,
    state: 'completed',
    events: [statusEvent(vassal, 'working'), statusEvent(vassal, 'completed')],
    ...overrides,
  };
}

describe('mergeBranches', () => {
  it('concatenates branches in selection order, keeping in-branch order and source tags', () => {
    const merged = mergeBranches([branch('loom'), branch('atlas')]);
    expect(merged.map(e => e.source.vassal)).toEqual(['loom', 'loom', 'atlas', 'atlas']);
    expect(merged.map(e => e.event.kind)).toEqual(['status-update', 'status-update', 'status-update', 'status-update']);
    expect(merged[0]!.source).toEqual({ vassal: 'loom', taskId: 'loom-task', runId: 'run:loom' });
    expect(merged[2]!.source.taskId).toBe('atlas-task');
  });

  it('returns an empty stream for no branches', () => {
    expect(mergeBranches([])).toEqual([]);
  });

  it('includes events from failed branches that streamed before failing', () => {
    const merged = mergeBranches([
      branch('loom', { ok: false, reason: 'boom', events: [statusEvent('loom', 'working')] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source.vassal).toBe('loom');
  });
});

describe('extractStance / extractPositions', () => {
  it('reads stance or verdict from data parts, with rationale', () => {
    expect(extractStance(taskWithStance('t', 'approve'))?.stance).toBe('approve');
    expect(extractStance(taskWithStance('t', undefined, { verdict: 'reject' }))?.stance).toBe('reject');
    const rich = extractStance(taskWithStance('t', 'approve', { rationale: 'tests pass' }));
    expect(rich).toEqual({ stance: 'approve', rationale: 'tests pass' });
  });

  it('never ingests a vassal-reported weight (the artifact contract is stance + rationale)', () => {
    // deep review 2026-11-02 P1-2: Position.weight is a platform/caller-side
    // voting weight; a vassal self-reporting one — benign or adversarial — is
    // ignored at the trust boundary instead of validated after the fact.
    for (const weight of [2, 0, 1e9, -5, NaN, Infinity, -Infinity]) {
      expect(extractStance(taskWithStance('t', 'approve', { weight }))).toEqual({ stance: 'approve' });
    }
    const positions = extractPositions([branch('loom', { task: taskWithStance('loom-task', 'approve', { weight: 1e9 }) })]);
    expect(positions).toEqual([{ vassal: 'loom', stance: 'approve' }]);
  });

  it('returns null for tasks without a stance', () => {
    const task: Task = { kind: 'task', id: 't', contextId: 'ctx', status: { state: 'completed' }, artifacts: [{ artifactId: 'a', name: 'n', parts: [{ kind: 'text', text: 'done' }] }] };
    expect(extractStance(task)).toBeNull();
  });

  it('collects positions only from successful branches with a stance', () => {
    const positions = extractPositions([
      branch('loom', { task: taskWithStance('loom-task', 'approve') }),
      branch('atlas', { ok: false, reason: 'down' }),
      branch('job-agent', { task: { kind: 'task', id: 'j', contextId: 'ctx', status: { state: 'completed' }, artifacts: [] } }),
    ]);
    expect(positions.map(p => p.vassal)).toEqual(['loom']);
  });
});

describe('aggregate', () => {
  const pos = (vassal: string, stance: string, weight?: number) => ({ vassal, stance, ...(weight ? { weight } : {}) });

  it('reports no stance when nobody voted', () => {
    const decision = aggregate([]);
    expect(decision.conclusion).toBeNull();
    expect(decision.reason).toMatch(/no vassal returned a stance/);
  });

  it('unanimous: concludes only when all agree', () => {
    expect(aggregate([pos('a', 'go'), pos('b', 'go')], { kind: 'unanimous' }).conclusion).toBe('go');
    const split = aggregate([pos('a', 'go'), pos('b', 'stop')], { kind: 'unanimous' });
    expect(split.conclusion).toBeNull();
    expect(split.reason).toMatch(/not unanimous/);
  });

  it('majority: strict majority wins; ties and pluralities do not', () => {
    expect(aggregate([pos('a', 'go'), pos('b', 'go'), pos('c', 'stop')]).conclusion).toBe('go');
    const tie = aggregate([pos('a', 'go'), pos('b', 'stop')]);
    expect(tie.conclusion).toBeNull();
    expect(tie.reason).toMatch(/tie/);
    // 4 voters: 2 go / 1 stop / 1 wait — unique plurality but not a strict majority
    const plurality = aggregate([pos('a', 'go'), pos('b', 'go'), pos('c', 'stop'), pos('d', 'wait')]);
    expect(plurality.conclusion).toBeNull();
    expect(plurality.reason).toMatch(/no strict majority/);
  });

  it('weighted: respects weights and the threshold', () => {
    const decided = aggregate([pos('a', 'go', 0.8), pos('b', 'stop', 0.1)], { kind: 'weighted' });
    expect(decided.conclusion).toBe('go');
    const below = aggregate([pos('a', 'go', 0.4), pos('b', 'stop', 0.4)], { kind: 'weighted', threshold: 0.6 });
    expect(below.conclusion).toBeNull();
  });

  it('weighted: defaults to threshold 0.5 and weight 1 when absent', () => {
    // 60/40 split: 0.6 >= 0.5 default threshold -> concludes
    const decided = aggregate([pos('a', 'go', 0.6), pos('b', 'stop', 0.4)], { kind: 'weighted' });
    expect(decided.conclusion).toBe('go');
    expect(decided.margin).toEqual({ winner: 'go', winnerCount: 1, total: 2 });
    // missing weights fall back to 1 each -> 50/50 tie -> no conclusion
    const tie = aggregate([pos('a', 'go'), pos('b', 'stop')], { kind: 'weighted' });
    expect(tie.conclusion).toBeNull();
  });

  it('weighted: reports the margin in voters, like the majority rule', () => {
    // "go" carries 1.0 of 1.1 weight -> concludes, but only 2 of 3 vassals voted go
    const decided = aggregate([pos('a', 'go', 0.8), pos('b', 'go', 0.2), pos('c', 'stop', 0.1)], { kind: 'weighted' });
    expect(decided.conclusion).toBe('go');
    expect(decided.margin).toEqual({ winner: 'go', winnerCount: 2, total: 3 });
  });

  it('weighted: equal top weights do not win even above threshold', () => {
    // both at exactly the threshold but tied -> null (split, never silently picks)
    const tie = aggregate([pos('a', 'go', 0.5), pos('b', 'stop', 0.5)], { kind: 'weighted' });
    expect(tie.conclusion).toBeNull();
    expect(tie.reason).toMatch(/tied/);
  });

  describe('weighted: adversarial weights (deep review 2026-11-02 P1-2)', () => {
    // `pos` drops falsy weights by design; `raw` keeps NaN/0 for attack cases.
    const raw = (vassal: string, stance: string, weight: number) => ({ vassal, stance, weight });

    it('isolates NaN / ±Infinity / negative weights and still aggregates the rest', () => {
      const decision = aggregate(
        [raw('a', 'go', NaN), raw('b', 'go', Infinity), raw('c', 'go', -Infinity), raw('d', 'go', -3), pos('e', 'stop')],
        { kind: 'weighted' },
      );
      // only 'e' carries a valid weight -> stop holds 1/1 and concludes
      expect(decision.conclusion).toBe('stop');
      expect(decision.reason).toMatch(/excluded 4 position\(s\) with non-finite or negative weight \(a, b, c, d\)/);
      // every position is still echoed for explainability
      expect(decision.positions).toHaveLength(5);
    });

    it('defeats the reported attack: [100, -99] can no longer inflate the top share', () => {
      // pre-fix: totalWeight collapsed to 1, so "go" held 100x the total and
      // force-concluded; now the negative ballot is disenfranchised instead.
      const decision = aggregate([pos('a', 'go', 100), raw('b', 'stop', -99)], { kind: 'weighted' });
      expect(decision.conclusion).toBe('go');
      expect(decision.reason).toMatch(/excluded 1 position\(s\).*\(b\)/);
      expect(decision.reason).toMatch(/100\/100/);
    });

    it('treats a huge finite weight as a valid platform-side vote (the ratio rule is scale-invariant)', () => {
      const decision = aggregate([pos('a', 'go', 1e9), pos('b', 'stop', 1)], { kind: 'weighted' });
      expect(decision.conclusion).toBe('go');
    });

    it('fails closed when finite weights overflow the sum', () => {
      const decision = aggregate([raw('a', 'go', 1e308), raw('b', 'stop', 1e308)], { kind: 'weighted' });
      expect(decision.conclusion).toBeNull();
    });

    it('concludes nothing when no position carries a valid weight', () => {
      const decision = aggregate([raw('a', 'go', -1), raw('b', 'stop', NaN)], { kind: 'weighted' });
      expect(decision.conclusion).toBeNull();
      expect(decision.reason).toMatch(/excluded 2 position\(s\)/);
      expect(decision.reason).toMatch(/no position carries a valid weight/);
    });

    it('zero weight is valid and simply does not vote', () => {
      const decision = aggregate([raw('a', 'go', 0), pos('b', 'stop', 1)], { kind: 'weighted' });
      expect(decision.conclusion).toBe('stop');
      expect(decision.reason).not.toMatch(/excluded/);
    });
  });

  it('majority: exactly half is not a strict majority', () => {
    // 2 go / 2 stop: top count 2 is not strictly greater than 4/2 = 2 -> tie
    const split = aggregate([pos('a', 'go'), pos('b', 'go'), pos('c', 'stop'), pos('d', 'stop')]);
    expect(split.conclusion).toBeNull();
    expect(split.reason).toMatch(/tie/);
  });

  it('always echoes every position for explainability', () => {
    const decision = aggregate([pos('a', 'go'), pos('b', 'stop')]);
    expect(decision.positions).toHaveLength(2);
  });
});

describe('detectConflicts', () => {
  const pos = (vassal: string, stance: string) => ({ vassal, stance });

  it('flags an unresolved split grouped by stance', () => {
    const positions = [pos('a', 'go'), pos('b', 'stop'), pos('c', 'go')];
    const decision = aggregate(positions); // 2 go vs 1 stop -> majority go, no conflict
    expect(detectConflicts(positions, decision)).toEqual([]);

    const split = aggregate([pos('a', 'go'), pos('b', 'stop')]); // tie
    const conflicts = detectConflicts([pos('a', 'go'), pos('b', 'stop')], split);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.stances).toEqual([
      { stance: 'go', vassals: ['a'] },
      { stance: 'stop', vassals: ['b'] },
    ]);
  });

  it('does not flag when the rule already concluded or only one stance exists', () => {
    const decided = aggregate([pos('a', 'go'), pos('b', 'go')]);
    expect(detectConflicts([pos('a', 'go'), pos('b', 'go')], decided)).toEqual([]);
    const noStance = aggregate([]);
    expect(detectConflicts([], noStance)).toEqual([]);
  });
});

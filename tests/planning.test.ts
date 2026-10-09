// design-planning (tech map S12) V1: validatePlan / scorePlans / selectPlan /
// replanDelta pure functions. Acceptance (design-planning §5): one rejection
// example per class (invalid graph / missing skill / unsatisfiable input);
// ranking order and tie-conflict; the "completed nodes are frozen" invariant
// for any current/revised pair; re-plan never touches running nodes; zero
// runtime behaviour change (V1 is pure functions only).

import { describe, expect, it } from 'vitest';
import {
  replanDelta,
  scorePlans,
  selectPlan,
  validatePlan,
  type PlanCandidate,
  type PlanGoal,
} from '../src/orchestrator/planning.js';
import type { DagNode } from '../src/orchestrator/dag.js';
import type { SkillSpec } from '../src/skills/types.js';

function spec(id: string, tags: string[] = [], inputs: Record<string, unknown> = {}, providedBy: string[] = ['a1']): SkillSpec {
  return {
    id, name: id, description: id, version: '1.0.0', tags, inputs, providedBy,
    status: 'active', registeredAt: 't0',
  };
}

const catalogue: SkillSpec[] = [
  spec('research', ['search', 'compare'], { query: {} }, ['a1', 'a2']),
  spec('writeup', ['write'], { draft: {} }, ['a1']),
];

const goal: PlanGoal = { description: 'research and compare then write up' };

function node(id: string, skill: string, params: Record<string, unknown> = {}, dependsOn?: string[]): DagNode {
  return { id, skill, params, ...(dependsOn === undefined ? {} : { dependsOn }) };
}

function candidate(planner: string, nodes: DagNode[], malformed?: string): PlanCandidate {
  return { planner, spec: { realm: 'personal', nodes }, ...(malformed === undefined ? {} : { malformed }) };
}

describe('validatePlan (S12 V1)', () => {
  it('accepts a feasible plan and scores its dimensions', () => {
    const p = candidate('p1', [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])]);
    const s = validatePlan(p, catalogue, goal);
    expect(s.feasible).toBe(true);
    expect(s.rejects).toEqual([]);
    expect(s.criticalPathLength).toBeGreaterThan(0);
    expect(s.estimatedCost).toBe(2);
    expect(s.singlePoints).toBe(0); // every skill here has at least one provider
  });

  it('rejects an invalid graph (cycle / missing dependency)', () => {
    const p = candidate('p1', [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', {}, ['nope'])]);
    const s = validatePlan(p, catalogue, goal);
    expect(s.feasible).toBe(false);
    expect(s.rejects.join(' ')).toContain('graph invalid');
  });

  it('rejects a plan referencing a skill missing from the catalogue', () => {
    const p = candidate('p1', [node('n1', 'nonsense-skill')]);
    const s = validatePlan(p, catalogue, goal);
    expect(s.feasible).toBe(false);
    expect(s.rejects.join(' ')).toContain('nonsense-skill');
  });

  it('rejects a node whose required input is neither in params nor produced upstream', () => {
    const p = candidate('p1', [node('n1', 'research')]);
    const s = validatePlan(p, catalogue, goal);
    expect(s.feasible).toBe(false);
    expect(s.rejects.join(' ')).toContain('query');
  });

  it('accepts an input supplied by an upstream node', () => {
    const p = candidate('p1', [
      node('n1', 'research', { query: 'x', draft: 'draft-text' }),
      node('n2', 'writeup', { draft: 'ok' }, ['n1']),
    ]);
    const s = validatePlan(p, catalogue, goal);
    expect(s.feasible).toBe(true);
  });

  it('marks a malformed draft infeasible', () => {
    const p = candidate('p1', [], 'not a dag spec');
    const s = validatePlan(p, catalogue, goal);
    expect(s.feasible).toBe(false);
    expect(s.rejects.join(' ')).toContain('malformed');
  });

  it('scores coverage from goal-token matches', () => {
    const p = candidate('p1', [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])]);
    const s = validatePlan(p, catalogue, goal);
    expect(s.coverage).toBeGreaterThan(0);
  });
});

describe('scorePlans + selectPlan (S12 V1)', () => {
  it('ranks feasible plans above infeasible ones', () => {
    const good = candidate('p1', [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])]);
    const bad = candidate('p2', [node('n1', 'nope')]);
    const ranking = scorePlans([bad, good], catalogue, goal);
    expect(ranking.scores[0]!.planner).toBe('p1');
  });

  it('selects the top plan when its coverage lead exceeds the tie threshold', () => {
    const better = candidate('p1', [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])]);
    const worse = candidate('p2', [node('n1', 'writeup', { draft: 'x' })]);
    const ranking = scorePlans([worse, better], catalogue, goal);
    const r = selectPlan(ranking, 0.1);
    expect(r).toEqual({ kind: 'selected', planner: 'p1' });
  });

  it('declares a conflict when two feasible candidates are close (plan-conflict)', () => {
    const a = candidate('p1', [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])]);
    const b = candidate('p2', [node('n1', 'research', { query: 'y' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])]);
    const ranking = scorePlans([b, a], catalogue, goal);
    const r = selectPlan(ranking, 0.01);
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') expect([...r.planners].sort()).toEqual(['p1', 'p2']);
  });

  it('declares unplannable when no candidate is feasible', () => {
    const bad = candidate('p1', [node('n1', 'nope')]);
    const ranking = scorePlans([bad], catalogue, goal);
    expect(selectPlan(ranking, 0.1)).toEqual({ kind: 'unplannable' });
  });
});

describe('replanDelta (S12 V1)', () => {
  it('keeps completed nodes, adds new nodes and removes only never-started ones', () => {
    const current = ['n1', 'n2', 'n3'];
    const statusOf = (id: string) => (id === 'n1' ? 'completed' : id === 'n2' ? 'pending' : 'pending') as 'completed' | 'pending';
    const delta = replanDelta(current, (id) => (id === 'n1' ? ['n0'] : id === 'n2' ? ['n1'] : []), {
      realm: 'personal',
      nodes: [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1']), node('n4', 'research', { query: 'z' })],
    }, statusOf);
    expect(delta.kept).toEqual(['n1']);
    expect(delta.added.map((n) => n.id)).toEqual(['n4']);
    expect(delta.removed).toEqual(['n3']);
  });

  it('never removes a running node from the revised graph', () => {
    const current = ['n1', 'n2'];
    const delta = replanDelta(current, () => [], { realm: 'personal', nodes: [node('n1', 'research', { query: 'x' })] },
      (id) => (id === 'n2' ? 'running' : undefined));
    expect(delta.removed).toEqual([]);
  });

  it('never re-runs a completed node: kept nodes are exactly the completed ones', () => {
    const current = ['n1', 'n2'];
    const revised = { realm: 'personal' as const, nodes: [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])] };
    const delta = replanDelta(current, () => [], revised, (id) => (id === 'n1' ? 'completed' : 'pending') as 'completed' | 'pending');
    expect(delta.kept).toEqual(['n1']);
    expect(delta.removed).toEqual([]);
    // n2 stays in the graph (pending) — not removed, not re-added.
    expect(delta.added).toEqual([]);
  });

  it('reports dependency rewiring for non-completed nodes whose edges changed', () => {
    const current = ['n1', 'n2'];
    const delta = replanDelta(current, (id) => (id === 'n2' ? ['n0'] : []), {
      realm: 'personal',
      nodes: [node('n1', 'research', { query: 'x' }), node('n2', 'writeup', { draft: 'ok' }, ['n1'])],
    }, (id) => (id === 'n1' ? 'completed' : 'pending') as 'completed' | 'pending');
    expect(delta.rewired).toEqual([{ id: 'n2', deps: ['n1'] }]);
  });
});

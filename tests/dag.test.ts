import { describe, expect, it } from 'vitest';
import { DagRunner } from '../src/orchestrator/dag-runner.js';
import {
  criticalPath,
  topologicalLayers,
  validateDag,
  DagValidationError,
  type DagNode,
  type DagSpec,
} from '../src/orchestrator/dag.js';
import type { DispatchPort } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function completed(vassal: string, skill: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-${skill}`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'result', parts: [{ kind: 'data', data: { producedBy: skill, stance: 'go' } }] }],
  };
  const event: A2AEvent = { kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'completed' }, final: true };
  return { ok: true, task, events: [event], injectedHits: [] };
}
function failed(): DispatchResult {
  return { ok: false, reason: 'boom', audit: { ts: 't', vassal: 'v', decision: 'dispatch-failed' } };
}

/** Dispatch keyed by skill, with a per-skill delay; records an ordered start/end log. */
function loggingPort(routes: Record<string, { result: DispatchResult; delayMs?: number }>, log: string[]): DispatchPort {
  return {
    async dispatch(req: DispatchRequest) {
      const skill = req.skill;
      log.push(`${skill}:start`);
      const route = routes[skill] ?? { result: completed(req.vassal!, skill) };
      if (route.delayMs) await delay(route.delayMs);
      log.push(`${skill}:end`);
      return route.result;
    },
    async cancel() {},
  };
}

const lookup = { findBySkill: () => [] };
const baseSpec = (nodes: DagNode[], realm: 'personal' = 'personal'): DagSpec => ({ dagId: 'dag1', realm, nodes });

describe('DAG graph functions', () => {
  it('rejects duplicate ids, unknown dependencies and cycles', () => {
    expect(() => validateDag([{ id: 'a', skill: 's' }, { id: 'a', skill: 's' }])).toThrow(DagValidationError);
    expect(() => validateDag([{ id: 'a', skill: 's', dependsOn: ['x'] }])).toThrow(/unknown node x/);
    const cycle: DagNode[] = [
      { id: 'a', skill: 's', dependsOn: ['b'] },
      { id: 'b', skill: 's', dependsOn: ['a'] },
    ];
    expect(() => validateDag(cycle)).toThrow(/cycle/);
    expect(() => validateDag([])).toThrow(/no nodes/);
  });

  it('computes topological layers and critical path', () => {
    // A -> B, A -> C, C -> D ; B and C are the same wave after A.
    const nodes: DagNode[] = [
      { id: 'D', skill: 'd', dependsOn: ['C'] },
      { id: 'B', skill: 'b', dependsOn: ['A'] },
      { id: 'C', skill: 'c', dependsOn: ['A'] },
      { id: 'A', skill: 'a' },
    ];
    expect(topologicalLayers(nodes)).toEqual([['A'], ['B', 'C'], ['D']]);
    // critical path is A-C-D (3 nodes), longer than A-B (2).
    expect(criticalPath(nodes)).toEqual(['A', 'C', 'D']);
  });
});

describe('DagRunner', () => {
  it('runs waves in dependency order with same-wave nodes in parallel', async () => {
    const log: string[] = [];
    const port = loggingPort({ 'skill-A': { result: completed('v1', 'skill-A'), delayMs: 30 } }, log);
    const runner = new DagRunner(lookup, port, { newRunId: () => 'r1' });
    const nodes: DagNode[] = [
      { id: 'A', skill: 'skill-A', vassals: ['v1'] },
      { id: 'B', skill: 'skill-B', vassals: ['v2'], dependsOn: ['A'] },
      { id: 'C', skill: 'skill-C', vassals: ['v3'], dependsOn: ['A'] },
    ];
    const result = await runner.run(baseSpec(nodes));
    expect(result.state).toBe('completed');
    expect(result.criticalPath).toEqual(['A', 'B']); // A-B and A-C tie; lexicographic picks B path
    // A fully ended before either dependent started
    expect(log.indexOf('skill-A:end')).toBeLessThan(log.indexOf('skill-B:start'));
    expect(log.indexOf('skill-A:end')).toBeLessThan(log.indexOf('skill-C:start'));
    // every node ran
    expect(result.nodes.map(n => n.nodeId).sort()).toEqual(['A', 'B', 'C']);
    expect(result.nodes.every(n => n.state === 'completed')).toBe(true);
  });

  it('skips downstream of a failed node while independent branches continue', async () => {
    const log: string[] = [];
    const port = loggingPort({ 'skill-B': { result: failed() } }, log);
    const runner = new DagRunner(lookup, port, { newRunId: () => 'r1' });
    const nodes: DagNode[] = [
      { id: 'A', skill: 'skill-A', vassals: ['v1'] },
      { id: 'B', skill: 'skill-B', vassals: ['v2'], dependsOn: ['A'] },
      { id: 'C', skill: 'skill-C', vassals: ['v3'], dependsOn: ['B'] }, // blocked by B
      { id: 'D', skill: 'skill-D', vassals: ['v4'], dependsOn: ['A'] }, // independent of B, still runs
    ];
    const result = await runner.run(baseSpec(nodes));
    expect(result.state).toBe('partial');
    const byId = new Map(result.nodes.map(n => [n.nodeId, n]));
    expect(byId.get('A')?.state).toBe('completed');
    expect(byId.get('B')?.state).toBe('failed');
    expect(byId.get('C')?.state).toBe('skipped');
    expect(byId.get('C')?.skippedReason).toContain('B');
    expect(byId.get('D')?.state).toBe('completed');
    // C never dispatched
    expect(log).not.toContain('skill-C:start');
    expect(log).toContain('skill-D:start');
  });

  it('bubbles needs-driver to the DAG state', async () => {
    // two vassals disagree on the same node -> needs-driver
    const port: DispatchPort = {
      async dispatch(req) {
        const stance = req.vassal === 'v-yes' ? 'go' : 'stop';
        const task: Task = {
          kind: 'task', id: `${req.vassal}`, contextId: 'ctx', status: { state: 'completed' },
          artifacts: [{ artifactId: 'a', name: 'result', parts: [{ kind: 'data', data: { stance } }] }],
        };
        return { ok: true, task, events: [], injectedHits: [] };
      },
      async cancel() {},
    };
    const runner = new DagRunner(lookup, port, { newRunId: () => 'r1' });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v-yes', 'v-no'] }]));
    expect(result.state).toBe('needs-driver');
    expect(result.nodes[0].state).toBe('needs-driver');
  });

  it('passes upstream results to downstream params via resolveParams', async () => {
    const seen: Record<string, unknown>[] = [];
    const port: DispatchPort = {
      async dispatch(req) {
        seen.push(req.params);
        return completed(req.vassal!, req.skill);
      },
      async cancel() {},
    };
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      resolveParams: (node, upstream) =>
        node.id === 'B' ? { fromA: upstream.get('A')?.branches?.[0]?.vassal ?? null } : {},
    });
    const nodes: DagNode[] = [
      { id: 'A', skill: 'a', vassals: ['v1'] },
      { id: 'B', skill: 'b', vassals: ['v2'], dependsOn: ['A'] },
    ];
    await runner.run(baseSpec(nodes));
    expect(seen[1]).toMatchObject({ fromA: 'v1' });
  });
});

import { describe, expect, it } from 'vitest';
import { DagRunner, DagIdInUseError } from '../src/orchestrator/dag-runner.js';
import {
  criticalPath,
  dependenciesSatisfied,
  firstUnsatisfiedDependency,
  topologicalLayers,
  validateDag,
  DagValidationError,
  type DagNode,
  type DagNodeState,
  type DagSpec,
} from '../src/orchestrator/dag.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, FanOutResult } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function completed(executor: string, skill: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${executor}-${skill}`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'result', parts: [{ kind: 'data', data: { producedBy: skill, stance: 'go' } }] }],
  };
  const event: A2AEvent = { kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'completed' }, final: true };
  return { ok: true, task, events: [event], injectedHits: [] };
}
function failed(): DispatchResult {
  return { ok: false, reason: 'boom', audit: { ts: 't', executor: 'v', decision: 'dispatch-failed' } };
}

/** Dispatch keyed by skill, with a per-skill delay; records an ordered start/end log. */
function loggingPort(routes: Record<string, { result: DispatchResult; delayMs?: number }>, log: string[]): DispatchPort {
  return {
    async dispatch(req: DispatchRequest) {
      const skill = req.skill;
      log.push(`${skill}:start`);
      const route = routes[skill] ?? { result: completed(req.executor!, skill) };
      if (route.delayMs) await delay(route.delayMs);
      log.push(`${skill}:end`);
      return route.result;
    },
    async cancel() {},
  };
}

const lookup = { findBySkill: () => [] };
const baseSpec = (nodes: DagNode[], dataDomain: 'personal' = 'personal'): DagSpec => ({ dagId: 'dag1', dataDomain, nodes });

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

  it('names the first unsatisfied dependency through one shared check', () => {
    const node: DagNode = { id: 'C', skill: 'c', dependsOn: ['A', 'B'] };
    const states = new Map<string, DagNodeState>([['A', 'completed'], ['B', 'failed']]);
    const statusOf = (id: string) => states.get(id);

    expect(firstUnsatisfiedDependency(node, statusOf)).toBe('B');
    expect(dependenciesSatisfied(node, statusOf)).toBe(false);

    states.set('B', 'completed');
    expect(firstUnsatisfiedDependency(node, statusOf)).toBeUndefined();
    expect(dependenciesSatisfied(node, statusOf)).toBe(true);
    // a node with no dependencies is always ready
    expect(dependenciesSatisfied({ id: 'X', skill: 'x' }, statusOf)).toBe(true);
  });
});

describe('DagRunner', () => {
  it('runs waves in dependency order with same-wave nodes in parallel', async () => {
    const log: string[] = [];
    const port = loggingPort({ 'skill-A': { result: completed('v1', 'skill-A'), delayMs: 30 } }, log);
    const runner = new DagRunner(lookup, port, { newRunId: () => 'r1' });
    const nodes: DagNode[] = [
      { id: 'A', skill: 'skill-A', executors: ['v1'] },
      { id: 'B', skill: 'skill-B', executors: ['v2'], dependsOn: ['A'] },
      { id: 'C', skill: 'skill-C', executors: ['v3'], dependsOn: ['A'] },
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
      { id: 'A', skill: 'skill-A', executors: ['v1'] },
      { id: 'B', skill: 'skill-B', executors: ['v2'], dependsOn: ['A'] },
      { id: 'C', skill: 'skill-C', executors: ['v3'], dependsOn: ['B'] }, // blocked by B
      { id: 'D', skill: 'skill-D', executors: ['v4'], dependsOn: ['A'] }, // independent of B, still runs
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

  it('bubbles needs-operator to the DAG state', async () => {
    // two executors disagree on the same node -> needs-operator
    const port: DispatchPort = {
      async dispatch(req) {
        const stance = req.executor === 'v-yes' ? 'go' : 'stop';
        const task: Task = {
          kind: 'task', id: `${req.executor}`, contextId: 'ctx', status: { state: 'completed' },
          artifacts: [{ artifactId: 'a', name: 'result', parts: [{ kind: 'data', data: { stance } }] }],
        };
        return { ok: true, task, events: [], injectedHits: [] };
      },
      async cancel() {},
    };
    const runner = new DagRunner(lookup, port, { newRunId: () => 'r1' });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', executors: ['v-yes', 'v-no'] }]));
    expect(result.state).toBe('needs-operator');
    expect(result.nodes[0]!.state).toBe('needs-operator');
  });

  it('passes upstream results to downstream params via resolveParams', async () => {
    const seen: Record<string, unknown>[] = [];
    const port: DispatchPort = {
      async dispatch(req) {
        seen.push(req.params);
        return completed(req.executor!, req.skill);
      },
      async cancel() {},
    };
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      resolveParams: (node, upstream) =>
        node.id === 'B' ? { fromA: upstream.get('A')?.branches?.[0]?.executor ?? null } : {},
    });
    const nodes: DagNode[] = [
      { id: 'A', skill: 'a', executors: ['v1'] },
      { id: 'B', skill: 'b', executors: ['v2'], dependsOn: ['A'] },
    ];
    await runner.run(baseSpec(nodes));
    expect(seen[1]).toMatchObject({ fromA: 'v1' });
  });
});

function fanOutFor(intentId: string): FanOutResult {
  return {
    intentId, runId: 'r', skill: 's', dataDomain: 'personal', branches: [], stream: [], positions: [],
    decision: { rule: 'unanimous', conclusion: 'go', positions: [], reason: 'ok' },
    conflicts: [], status: 'completed', createdAt: 't',
  };
}

/** A stand-in orchestrator that records node fan-outs and cancellations. */
function stubOrchestrator(overrides: {
  fanOut?: (req: { intentId?: string }) => Promise<FanOutResult>;
  cancelIntent?: (id: string) => Promise<void>;
}): Orchestrator {
  return {
    async fanOut(req: { intentId?: string }) { return overrides.fanOut ? overrides.fanOut(req) : fanOutFor(req.intentId!); },
    async cancelIntent(id: string) { return overrides.cancelIntent ? overrides.cancelIntent(id) : undefined; },
  } as unknown as Orchestrator;
}

const noopPort: DispatchPort = { async dispatch() { return completed('v', 's'); }, async cancel() {} };

describe('DagRunner lifecycle guards', () => {
  it('registers node intents before the run settles, so cancelDag reaches them mid-run', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelled: string[] = [];
    const orchestrator = stubOrchestrator({
      fanOut: async req => { await gate; return fanOutFor(req.intentId!); },
      cancelIntent: async id => { cancelled.push(id); },
    });
    const runner = new DagRunner(lookup, noopPort, { newRunId: () => 'r1' }, orchestrator);
    const spec: DagSpec = { dagId: 'D-cancel', dataDomain: 'personal', nodes: [{ id: 'A', skill: 's' }] };

    const running = runner.run(spec);
    await delay(0); // the node has started; its intent must already be registered
    await runner.cancelDag('D-cancel');
    expect(cancelled).toEqual(['D-cancel::A']);

    release();
    await running;
  });

  it('fails only the throwing node and lets independent siblings finish', async () => {
    const orchestrator = stubOrchestrator({
      fanOut: async req => {
        if (req.intentId!.endsWith('::B')) throw new Error('node exploded');
        return fanOutFor(req.intentId!);
      },
    });
    const runner = new DagRunner(lookup, noopPort, { newRunId: () => 'r1' }, orchestrator);
    const result = await runner.run({
      dagId: 'D-throw',
      dataDomain: 'personal',
      nodes: [
        { id: 'A', skill: 'a' },
        { id: 'B', skill: 'b' },
        { id: 'C', skill: 'c', dependsOn: ['B'] },
      ],
    });
    const byId = new Map(result.nodes.map(n => [n.nodeId, n]));
    expect(byId.get('A')?.state).toBe('completed');
    expect(byId.get('B')?.state).toBe('failed');
    expect(byId.get('B')?.error).toMatch(/exploded/);
    expect(byId.get('C')?.state).toBe('skipped');
  });

  it('refuses to re-run a settled dag id instead of replaying it', async () => {
    let calls = 0;
    const orchestrator = stubOrchestrator({ fanOut: async req => { calls += 1; return fanOutFor(req.intentId!); } });
    const runner = new DagRunner(lookup, noopPort, { newRunId: () => 'r1' }, orchestrator);
    const spec: DagSpec = { dagId: 'D-reuse', dataDomain: 'personal', nodes: [{ id: 'A', skill: 's' }] };

    await runner.run(spec);
    expect(calls).toBe(1);
    await expect(runner.run(spec)).rejects.toBeInstanceOf(DagIdInUseError);
    expect(calls).toBe(1); // the refused run dispatched nothing
  });

  it('collapses concurrent runs that share a dag id into one wave', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const orchestrator = stubOrchestrator({ fanOut: async req => { calls += 1; await gate; return fanOutFor(req.intentId!); } });
    const runner = new DagRunner(lookup, noopPort, { newRunId: () => 'r1' }, orchestrator);
    const spec: DagSpec = { dagId: 'D-concurrent', dataDomain: 'personal', nodes: [{ id: 'A', skill: 's' }] };

    const first = runner.run(spec);
    const second = runner.run(spec);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(b).toBe(a); // the second caller joined the first run
  });

  it('mints reproducible-proof dag and run ids (uuid, not Math.random)', async () => {
    const runner = new DagRunner(lookup, noopPort, {});
    const result = await runner.run({ dataDomain: 'personal', nodes: [{ id: 'A', skill: 's' }] });
    expect(result.dagId).toMatch(/^dag-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.runId).toMatch(/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('passes concurrency limits through to the isolated orchestrator', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const port: DispatchPort = {
      async dispatch() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(15);
        inFlight -= 1;
        return completed('v', 's');
      },
      async cancel() {},
    };
    const nodes: DagNode[] = [
      { id: 'A', skill: 'a', executors: ['v1'] },
      { id: 'B', skill: 'b', executors: ['v2'] },
    ];
    const runner = new DagRunner(lookup, port, { newRunId: () => 'r1', maxConcurrentBranches: 1 });
    await runner.run(baseSpec(nodes));
    // The cap is honoured only if the runner forwarded it to the orchestrator it
    // built; dropping the option leaves the two branches unbounded (maxInFlight 2).
    expect(maxInFlight).toBe(1);
  });
});

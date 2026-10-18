// design-tool-discovery (tech map S11) V3 slice 2: the executable chain
// recovery. buildChainPlan maps a DAG spec to a chain plan (one step per node,
// node's own candidate face); with `chainRecovery` configured, a node whose
// fan-out fails is resolved by the fixed chain and retry/switch are *executed*
// as a re-dispatch under a fresh intent id, degrade marks the node `degraded`
// (dependents still run), escalate keeps the existing failed semantics.
// Without the option the runner behaves exactly as before (zero regression).

import { describe, expect, it } from 'vitest';
import { DagRunner, type ChainRecoveryAudit } from '../src/orchestrator/dag-runner.js';
import { buildChainPlan, type DispatchCandidate } from '../src/orchestrator/discovery.js';
import type { DagNode, DagSpec } from '../src/orchestrator/dag.js';
import type { DispatchPort } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

function completed(vassal: string, skill: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-${skill}`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'result', parts: [{ kind: 'data', data: { producedBy: skill, stance: 'go' } }] }],
  };
  const event: A2AEvent = { kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'completed' }, final: true };
  return { ok: true, task, events: [event], injectedHits: [] };
}
function failureResult(): DispatchResult {
  return { ok: false, reason: 'boom', audit: { ts: 't', vassal: 'v', decision: 'dispatch-failed' } };
}

/** Returns script[i] for the i-th dispatch (last entry repeats); records the
 *  vassal pinned for every call so a re-dispatch is observable. */
function scriptedPort(script: DispatchResult[], calls: Array<{ skill: string; vassal?: string }>): DispatchPort {
  let i = 0;
  return {
    async dispatch(req: DispatchRequest) {
      calls.push(req.vassal === undefined ? { skill: req.skill } : { skill: req.skill, vassal: req.vassal });
      const result = script[Math.min(i, script.length - 1)]!;
      i++;
      return result;
    },
    async cancel() {},
  };
}

const lookup = { findBySkill: () => [] };
const baseSpec = (nodes: DagNode[]): DagSpec => ({ dagId: 'dag1', realm: 'personal', nodes });

/** Candidate face by skill; defaults to the named providers. */
function face(providers: Record<string, string[]>): (skillId: string) => DispatchCandidate[] {
  return skillId => (providers[skillId] ?? []).map(provider => ({ provider, skillId, mode: 'plan' as const }));
}

function noAudit(): (entry: ChainRecoveryAudit) => void {
  return () => {};
}

describe('buildChainPlan (S11 V3 slice 2)', () => {
  it('maps one step per node in spec order, required defaulting to true', () => {
    const spec = baseSpec([
      { id: 'A', skill: 'research' },
      { id: 'B', skill: 'writeup', required: false, dependsOn: ['A'] },
    ]);
    const plan = buildChainPlan(spec, face({ research: ['a1', 'a2'], writeup: ['b1'] }));
    expect(plan.policy).toBe('dag');
    expect(plan.steps).toEqual([
      { skillId: 'research', candidates: [{ provider: 'a1', skillId: 'research', mode: 'plan' }, { provider: 'a2', skillId: 'research', mode: 'plan' }], required: true },
      { skillId: 'writeup', candidates: [{ provider: 'b1', skillId: 'writeup', mode: 'plan' }], required: false },
    ]);
  });

  it('an unknown skill yields an empty candidate face (no alternate, no retry target)', () => {
    const plan = buildChainPlan(baseSpec([{ id: 'A', skill: 'ghost' }]), face({}));
    expect(plan.steps[0]!.candidates).toEqual([]);
    expect(plan.steps[0]!.required).toBe(true);
  });
});

describe('DagRunner chain recovery (S11 V3 slice 2)', () => {
  it('without chainRecovery the failed/skipped semantics are unchanged (zero regression)', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const port = scriptedPort([completed('a', 's'), failureResult()], calls);
    const runner = new DagRunner(lookup, port, { newRunId: () => 'r1' });
    const result = await runner.run(baseSpec([
      { id: 'A', skill: 's', vassals: ['a'] },
      { id: 'B', skill: 's', vassals: ['b'], dependsOn: ['A'] },
      { id: 'C', skill: 's', vassals: ['c'], dependsOn: ['B'] },
    ]));
    const byId = new Map(result.nodes.map(n => [n.nodeId, n]));
    expect(byId.get('B')?.state).toBe('failed');
    expect(byId.get('C')?.state).toBe('skipped');
    expect(result.state).toBe('partial');
  });

  it('retries an idempotent node on the same provider and settles completed', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const audits: ChainRecoveryAudit[] = [];
    const port = scriptedPort([failureResult(), completed('v1', 's')], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['v1', 'v2'] })),
        audit: entry => audits.push(entry),
      },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'], idempotent: true }]));
    expect(result.nodes[0]!.state).toBe('completed');
    // same provider pinned for the re-dispatch; exactly two dispatches, never a third
    expect(calls.map(c => c.vassal)).toEqual(['v1', 'v1']);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('retry');
    expect(audits[0]!.intentId).toBe('dag1::A');
    expect(audits[0]!.vassal).toBe('v1');
    expect(audits[0]!.detail).toContain('retried on');
  });

  it('spends the retry budget and settles failed when the re-dispatch also fails', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const port = scriptedPort([failureResult(), failureResult()], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: { buildPlan: spec => buildChainPlan(spec, face({ s: ['v1'] })), audit: noAudit() },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'], idempotent: true }]));
    expect(result.nodes[0]!.state).toBe('failed');
    expect(calls).toHaveLength(2); // one re-dispatch, then the budget is spent
  });

  it('switches to the first alternate provider when retry is unavailable', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const audits: ChainRecoveryAudit[] = [];
    const port = scriptedPort([failureResult(), completed('v2', 's')], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['v1', 'v2', 'v3'] })),
        audit: entry => audits.push(entry),
      },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'] }]));
    expect(result.nodes[0]!.state).toBe('completed');
    expect(calls.map(c => c.vassal)).toEqual(['v1', 'v2']);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('switch');
    expect(audits[0]!.detail).toContain("switched from 'v1' to 'v2'");
  });

  it('never switches back to a tried provider (ping-pong guard)', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const port = scriptedPort([failureResult(), failureResult(), failureResult()], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['v1', 'v2', 'v3'] })),
        maxRetries: 3,
        audit: noAudit(),
      },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'] }]));
    expect(result.nodes[0]!.state).toBe('failed');
    // v1 -> v2 -> v3, and never back to v1: three dispatches, not four
    expect(calls.map(c => c.vassal)).toEqual(['v1', 'v2', 'v3']);
  });

  it('degrades a non-required node and lets its dependents run', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const audits: ChainRecoveryAudit[] = [];
    const port = scriptedPort([failureResult(), completed('c', 's')], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['b'] })),
        audit: entry => audits.push(entry),
      },
    });
    const result = await runner.run(baseSpec([
      { id: 'B', skill: 's', vassals: ['b'], required: false },
      { id: 'C', skill: 's', vassals: ['c'], dependsOn: ['B'] },
    ]));
    const byId = new Map(result.nodes.map(n => [n.nodeId, n]));
    expect(byId.get('B')?.state).toBe('degraded');
    expect(byId.get('B')?.skippedReason).toContain('degraded by recovery chain');
    expect(byId.get('C')?.state).toBe('completed'); // dependent runs on reduced scope
    expect(calls).toHaveLength(2); // B once, C once — no re-dispatch for B
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('degrade');
  });

  it('escalates a required node with no alternate and skips its dependents', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const port = scriptedPort([completed('a', 's'), failureResult()], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: { buildPlan: spec => buildChainPlan(spec, face({ s: ['b'] })), audit: noAudit() },
    });
    const result = await runner.run(baseSpec([
      { id: 'A', skill: 's', vassals: ['a'] },
      { id: 'B', skill: 's', vassals: ['b'], dependsOn: ['A'] },
      { id: 'C', skill: 's', vassals: ['c'], dependsOn: ['B'] },
    ]));
    const byId = new Map(result.nodes.map(n => [n.nodeId, n]));
    expect(byId.get('B')?.state).toBe('failed');
    expect(byId.get('C')?.state).toBe('skipped');
    expect(calls.map(c => c.vassal)).toEqual(['a', 'b']); // no re-dispatch
  });

  it('high-stakes nodes escalate before any retry is considered', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const audits: ChainRecoveryAudit[] = [];
    const port = scriptedPort([failureResult()], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['v1', 'v2'] })),
        audit: entry => audits.push(entry),
      },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'], idempotent: true, highStakes: true }]));
    expect(result.nodes[0]!.state).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(audits).toHaveLength(0); // escalate emits no chain line
  });

  it('an open circuit refuses retry and switch, degrading optional steps', async () => {
    const port = scriptedPort([failureResult()], []);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['v1', 'v2'] })),
        circuitOpen: () => true,
        audit: noAudit(),
      },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'], idempotent: true, required: false }]));
    expect(result.nodes[0]!.state).toBe('degraded');
  });

  it('an open circuit refuses retry and switch, escalating required steps', async () => {
    const port = scriptedPort([failureResult()], []);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['v1', 'v2'] })),
        circuitOpen: () => true,
        audit: noAudit(),
      },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'], idempotent: true }]));
    expect(result.nodes[0]!.state).toBe('failed');
  });

  it('maxRetries 0 disables re-dispatch entirely', async () => {
    const calls: Array<{ skill: string; vassal?: string }> = [];
    const port = scriptedPort([failureResult()], calls);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: { buildPlan: spec => buildChainPlan(spec, face({ s: ['v1', 'v2'] })), maxRetries: 0, audit: noAudit() },
    });
    const result = await runner.run(baseSpec([{ id: 'A', skill: 's', vassals: ['v1'] }]));
    expect(result.nodes[0]!.state).toBe('failed');
    expect(calls).toHaveLength(1);
  });

  it('a run with a degraded node is partial, never silently completed', async () => {
    const port = scriptedPort([failureResult(), completed('c', 's')], []);
    const runner = new DagRunner(lookup, port, {
      newRunId: () => 'r1',
      chainRecovery: {
        buildPlan: spec => buildChainPlan(spec, face({ s: ['b'] })),
        audit: noAudit(),
      },
    });
    const result = await runner.run(baseSpec([
      { id: 'B', skill: 's', vassals: ['b'], required: false },
      { id: 'C', skill: 's', vassals: ['c'], dependsOn: ['B'] },
    ]));
    expect(result.state).toBe('partial');
  });
});

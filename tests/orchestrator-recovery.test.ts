import { describe, expect, it, vi } from 'vitest';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent } from '../src/a2a/types.js';
import { bootKernel } from '../src/state/boot.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * S11 V3 (design-tool-discovery §5): the recovery chain wired onto the
 * failed-branch runtime. V1 covered the pure classifier (16 cases in
 * orchestrator-discovery.test.ts). These cases drive the *runtime*: a failed
 * branch must emit the tool-failed audit and the fixed-order verdict through
 * the hook, escalate keeping the existing needs-driver semantics (no chain-*
 * line), high-stakes execute branches never retry, and an open circuit still
 * falls through to escalate. The executable retry/switch/degrade actions
 * belong to the ChainPlan/DAG step face (V3 slice 2), where a step has an
 * un-dispatched alternate — intent-level fan-out dispatches the whole face,
 * so the verdict here is escalate.
 */

function statusEvent(taskId: string): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true };
}

function taskResult(vassal: string, ok: boolean): DispatchResult {
  if (!ok) {
    return {
      ok: false,
      reason: `vassal ${vassal} failed`,
      audit: { ts: new Date().toISOString(), vassal, decision: 'branch-aborted', detail: 'test failure' },
    };
  }
  const task = {
    kind: 'task' as const, id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' as const },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data' as const, data: { stance: 'go' } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id)], injectedHits: [] };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

/** Port that settles every dispatch immediately with the given outcome. */
function settlingPort(ok: boolean): DispatchPort & { started: string[] } {
  const started: string[] = [];
  return {
    async dispatch(req: DispatchRequest) {
      started.push(req.vassal!);
      return taskResult(req.vassal!, ok);
    },
    async cancel() {},
    started,
  };
}

function build(names: string[], options: OrchestratorOptions = {}, port: DispatchPort & { started: string[] } = settlingPort(true)) {
  const orchestrator = new Orchestrator(lookupFor(names), port, {
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    ...options,
  });
  return { orchestrator, port };
}

const request = { skill: 'review', realm: 'personal' as const, params: {} };

describe('S11 V3 recovery-chain runtime (design-tool-discovery §5)', () => {
  it('a failed branch emits tool-failed and the escalate verdict, settles failed, no chain line', async () => {
    const port = settlingPort(false);
    const recovered = vi.fn();
    const { orchestrator } = build(['a'], { onChainRecovered: recovered }, port);

    const result = await orchestrator.fanOut(request);

    expect(result.status).toBe('failed');
    expect(port.started).toEqual(['a']);
    expect(recovered).toHaveBeenCalledTimes(1);
    const entry = recovered.mock.calls[0]![0];
    expect(entry.action).toBe('escalate');
    expect(entry.vassal).toBe('a');
    expect(entry.skill).toBe('review');
    expect(entry.reason).toContain('failed');
    expect(entry.alternateProvider).toBeUndefined();
  });

  it('two failed branches each emit their own verdict on the same intent', async () => {
    const port = settlingPort(false);
    const recovered = vi.fn();
    const { orchestrator } = build(['a', 'b'], { onChainRecovered: recovered }, port);

    const result = await orchestrator.fanOut(request);

    expect(result.status).toBe('failed');
    expect(recovered).toHaveBeenCalledTimes(2);
    const vassals = recovered.mock.calls.map(call => call[0]!.vassal).sort();
    expect(vassals).toEqual(['a', 'b']);
  });

  it('an execute-mode failure never retries: high-stakes escalates with zero outbound', async () => {
    // No executionDelegation anchor → the execute gate refuses before dispatch;
    // the refusal is still a failed branch, and high-stakes must escalate
    // without a retry verdict (retrying an irreversible write can duplicate it).
    const port = settlingPort(true);
    const recovered = vi.fn();
    const { orchestrator } = build(['a'], { onChainRecovered: recovered }, port);

    const result = await orchestrator.fanOut({ ...request, mode: 'execute' });

    expect(result.status).toBe('failed');
    expect(port.started).toHaveLength(0); // zero outbound: refused at the gate
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(recovered.mock.calls[0]![0].action).toBe('escalate');
    expect(recovered.mock.calls[0]![0].reason).toContain('no-trust-anchor');
  });

  it('an open circuit still falls through to escalate (no switch on auto paths)', async () => {
    // failureStreak at the breaker threshold with an explicit name: the
    // dispatch gate lets the explicit branch through, but the recovery chain
    // sees the open circuit and refuses retry/switch — escalate is the exit.
    const port = settlingPort(false);
    const recovered = vi.fn();
    const { orchestrator } = build(['a'], { maxConsecutiveBranchFailures: 2, maxBranchesPerIntent: 3, onChainRecovered: recovered }, port);
    orchestrator.importState({
      intents: [], requests: [],
      budgets: { 'intent-1': { used: 1, failureStreak: 2 } },
    });

    const result = await orchestrator.fanOut({ ...request, intentId: 'intent-1', vassals: ['a'] });

    expect(result.status).toBe('failed');
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(recovered.mock.calls[0]![0].action).toBe('escalate');
  });

  it('boot: a failed branch lands tool-failed on the audit spine, no chain line for escalate', async () => {
    const audits: AuditEntry[] = [];

    function failingFetch(): typeof fetch {
      return (async (input: unknown) => {
        const url = String(input);
        const name = url.split('/')[3]!;
        if (url.includes('/api/a2a/agent-card')) {
          return new Response(JSON.stringify({
            name,
            url: `http://127.0.0.1/${name}/api/a2a/tasks`,
            version: '0.1.0',
            provider: { organization: 'bayjf', url: 'http://bayjf.test' },
            capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            skills: [{ id: 'review', name: 'Review', description: '', tags: [] }],
            authentication: { schemes: ['bearer'] },
            preferredTransport: 'JSONRPC',
            'x-zeus-fealty': {
              version: '1', swornTo: 'zeus', domain: 'test-domain',
              dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
              reportBack: true, escalationPolicy: 'auto',
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error('transport failed: peer unreachable');
      }) as typeof fetch;
    }

    const kernel = await bootKernel({
      fetchImpl: failingFetch(),
      vassalSeeds: ['http://127.0.0.1/loom/api/a2a/agent-card'],
      dispatchAudit: entry => audits.push(entry),
    });

    const result = await kernel.orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });

    expect(result.status).toBe('failed');
    const failed = audits.find(entry => entry.decision === 'tool-failed');
    expect(failed).toBeDefined();
    expect(failed?.vassal).toBe('loom');
    expect(failed?.detail).toContain('transport failed');
    // escalate keeps the existing needs-driver semantics: no chain line
    expect(audits.some(entry => entry.decision === 'chain-retried')).toBe(false);
    expect(audits.some(entry => entry.decision === 'chain-switched')).toBe(false);
    expect(audits.some(entry => entry.decision === 'chain-degraded')).toBe(false);
  });
});

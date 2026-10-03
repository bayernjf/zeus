import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { ExecutionDelegationNonceLedger, issueExecutionDelegation } from '../src/delegation/execution-delegation.js';
import type { DispatchPort, FanOutRequest, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const T0 = new Date('2026-10-03T00:00:00.000Z');

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function done(vassal: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
  };
  return { ok: true, task, events: [] as A2AEvent[], injectedHits: [] };
}

/** Recording port: asserts on how many outbound dispatches actually happened. */
function recordingPort() {
  const dispatchCalls: Array<{ vassal: string; skill: string }> = [];
  const port: DispatchPort = {
    async dispatch(req) {
      dispatchCalls.push({ vassal: req.vassal!, skill: req.skill });
      return done(req.vassal!);
    },
    async cancel() {},
  };
  return { port, dispatchCalls };
}

function harness(withAnchor = true) {
  const signer = new Ed25519MemorySigner('zeus-rsk-dev');
  const ledger = new ExecutionDelegationNonceLedger();
  const { port, dispatchCalls } = recordingPort();
  const refused: Array<{ vassal: string; reason: string }> = [];
  const orchestrator = new Orchestrator(lookupFor(['pr-helper']), port, {
    now: () => T0,
    ...(withAnchor
      ? {
          executionDelegation: {
            verifier: signer.verifier(),
            ledger,
            acceptedKeyIds: [signer.keyId],
            now: () => T0,
          },
        }
      : {}),
    onExecutionDelegationRefused: entry => {
      refused.push({ vassal: entry.vassal, reason: entry.reason });
    },
  });
  return { signer, ledger, orchestrator, dispatchCalls, refused };
}

function executeRequest(delegation?: FanOutRequest['executionDelegation']): FanOutRequest {
  return {
    skill: 'deployment-health',
    realm: 'personal',
    params: {},
    mode: 'execute',
    ...(delegation ? { executionDelegation: delegation } : {}),
  };
}

describe('deferred #33 execute-mode dispatch gate', () => {
  it('refuses execute without a delegation and never dispatches outbound', async () => {
    const { orchestrator, dispatchCalls, refused } = harness();
    const result = await orchestrator.fanOut(executeRequest());
    expect(dispatchCalls).toHaveLength(0);
    expect(refused[0]?.reason).toBe('missing');
    expect(result.branches[0]?.ok).toBe(false);
    expect(result.branches[0]?.reason).toBe('execute refused: missing');
  });

  it('admits an execute backed by a verified, unconsumed delegation (one dispatch, nonce consumed)', async () => {
    const { signer, ledger, orchestrator, dispatchCalls, refused } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'operator@zeus', skill: 'deployment-health', capabilities: ['execute'] },
      { signer, now: () => T0 },
    );
    const result = await orchestrator.fanOut(executeRequest(d));
    expect(refused).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toEqual({ vassal: expect.any(String), skill: 'deployment-health' });
    expect(result.branches[0]?.ok).toBe(true);
    // The delegation is single-use: the same credential cannot authorize again.
    expect(ledger.consume(d.nonce)).toBe(false);
  });

  it('rejects a replayed (already consumed) delegation without dispatching', async () => {
    const { signer, orchestrator, dispatchCalls, refused } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', capabilities: ['execute'] },
      { signer, now: () => T0 },
    );
    await orchestrator.fanOut(executeRequest(d));
    expect(dispatchCalls).toHaveLength(1);
    await orchestrator.fanOut(executeRequest(d));
    expect(dispatchCalls).toHaveLength(1);
    expect(refused[0]?.reason).toBe('replayed');
  });

  it('binds the delegation to the branch skill; a mismatch is refused before dispatch', async () => {
    const { signer, orchestrator, dispatchCalls, refused } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'database-migration', capabilities: ['execute'] },
      { signer, now: () => T0 },
    );
    const result = await orchestrator.fanOut(executeRequest(d));
    expect(dispatchCalls).toHaveLength(0);
    expect(refused[0]?.reason).toBe('wrong-skill');
    expect(result.branches[0]?.reason).toBe('execute refused: wrong-skill');
  });

  it('requires the delegation to cover the execute capability', async () => {
    const { signer, orchestrator, dispatchCalls, refused } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', capabilities: ['github:pull-request:merge'] },
      { signer, now: () => T0 },
    );
    await orchestrator.fanOut(executeRequest(d));
    expect(dispatchCalls).toHaveLength(0);
    expect(refused[0]?.reason).toBe('capability-not-covered');
  });

  it('fails closed with no trust anchor assembled (no signer -> execute impossible)', async () => {
    const { orchestrator, dispatchCalls, refused } = harness(false);
    const result = await orchestrator.fanOut(executeRequest());
    expect(dispatchCalls).toHaveLength(0);
    expect(refused[0]?.reason).toBe('no-trust-anchor');
    expect(result.branches[0]?.reason).toBe('execute refused: no-trust-anchor');
  });

  it('leaves the default plan mode unchanged: no delegation, dispatch proceeds', async () => {
    const { orchestrator, dispatchCalls, refused } = harness();
    const result = await orchestrator.fanOut({ skill: 'deployment-health', realm: 'personal', params: {} });
    expect(refused).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(1);
    expect(result.branches[0]?.ok).toBe(true);
  });
});

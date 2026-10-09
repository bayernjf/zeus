import { describe, expect, it } from 'vitest';
import { OversightDesk, extractEscalation } from '../src/oversight/oversight.js';
import type { OversightAuditEntry, CancelTaskFn } from '../src/oversight/types.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';

const request: DispatchRequest = {
  vassal: 'pr-helper',
  skill: 'merge-pr',
  params: { mode: 'execute' },
  realm: 'enterprise',
  runId: 'zeus-run-1',
};

/** Every test desk gets a deterministic escalation id. */
function desk(options: { audit?: (e: OversightAuditEntry) => void; cancelTask?: CancelTaskFn; now?: () => Date } = {}) {
  return new OversightDesk({ newId: () => 'esc-1', ...options });
}

function taskResult(state: Task['status']['state'], events: A2AEvent[] = [], id = 'task-1'): DispatchResult {
  return {
    ok: true,
    task: { kind: 'task', id, contextId: 'ctx', status: { state }, artifacts: [] },
    events,
    injectedHits: [],
  };
}

function escalationEvent(reason = 'irreversible: merge to main', options = ['approve', 'reject']): A2AEvent {
  return {
    kind: 'status-update',
    taskId: 'task-1',
    contextId: 'ctx',
    status: { state: 'input-required' },
    final: true,
    'x-zeus-escalation': { level: 'driver', reason, options },
  };
}

function failedResult(): DispatchResult {
  return { ok: false, reason: 'boom', audit: { ts: 't', runId: 'r', vassal: 'pr-helper', skill: 'merge-pr', realm: 'enterprise', decision: 'dispatch-failed' } };
}

describe('OversightDesk.ingest', () => {
  it('opens an escalation for an input-required dispatch and reads the payload', () => {
    const audit: OversightAuditEntry[] = [];
    const deskInstance = desk({ now: () => new Date('2026-09-21T00:00:00Z'), audit: e => audit.push(e) });
    const escalation = deskInstance.ingest(taskResult('input-required', [escalationEvent()]), request);

    expect(escalation).toMatchObject({
      id: 'esc-1',
      runId: 'zeus-run-1',
      vassal: 'pr-helper',
      skill: 'merge-pr',
      taskId: 'task-1',
      realm: 'enterprise',
      status: 'pending',
      reason: 'irreversible: merge to main',
      options: ['approve', 'reject'],
    });
    expect(audit[0]).toMatchObject({ escalationId: 'esc-1', action: 'escalated' });
  });

  it('ignores completed and failed dispatches', () => {
    const deskInstance = desk();
    expect(deskInstance.ingest(taskResult('completed', []), request)).toBeNull();
    expect(deskInstance.ingest(failedResult(), request)).toBeNull();
    expect(deskInstance.list()).toHaveLength(0);
  });

  it('is idempotent per taskId', () => {
    const deskInstance = desk();
    const result = taskResult('input-required', [escalationEvent()]);
    const first = deskInstance.ingest(result, request);
    const second = deskInstance.ingest(result, request);
    expect(second?.id).toBe(first?.id);
    expect(deskInstance.list()).toHaveLength(1);
  });

  it('falls back to a neutral reason when no escalation payload is present', () => {
    const bareEvent: A2AEvent = {
      kind: 'status-update',
      taskId: 'task-1',
      contextId: 'ctx',
      status: { state: 'input-required' },
      final: true,
    };
    const deskInstance = desk();
    const escalation = deskInstance.ingest(taskResult('input-required', [bareEvent]), request);
    expect(escalation?.reason).toBe('vassal requests human input');
    expect(escalation?.options).toEqual([]);
    expect(extractEscalation([bareEvent]).reason).toBe('vassal requests human input');
  });
});

describe('OversightDesk decisions', () => {
  it('approves a pending escalation and records the note', async () => {
    const audit: OversightAuditEntry[] = [];
    const deskInstance = desk({ now: () => new Date('2026-09-21T00:00:00Z'), audit: e => audit.push(e) });
    deskInstance.ingest(taskResult('input-required', [escalationEvent()]), request);

    const approved = deskInstance.approve('esc-1', 'driver supplied merge sha');
    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).toBe('2026-09-21T00:00:00.000Z');
    expect(approved.decisionNote).toBe('driver supplied merge sha');
    expect(deskInstance.list('pending')).toHaveLength(0);
    expect(deskInstance.list('approved')).toHaveLength(1);
    expect(audit.at(-1)).toMatchObject({ action: 'approved', note: 'driver supplied merge sha' });
  });

  it('rejects a pending escalation and cancels the vassal-side task', async () => {
    const canceled: Array<[string, string]> = [];
    const deskInstance = desk({
      cancelTask: async (vassal, taskId) => {
        canceled.push([vassal, taskId]);
      },
    });
    deskInstance.ingest(taskResult('input-required', [escalationEvent()]), request);

    const rejected = await deskInstance.reject('esc-1', 'too risky');
    expect(rejected.status).toBe('rejected');
    expect(canceled).toEqual([['pr-helper', 'task-1']]);
    expect(deskInstance.list('rejected')).toHaveLength(1);
  });

  it('keeps the escalation pending when the cancel call fails, and records the failure on the audit trail', async () => {
    const auditEvents: OversightAuditEntry[] = [];
    const deskInstance = desk({
      audit: e => auditEvents.push(e),
      cancelTask: async () => {
        throw new Error('vassal unreachable');
      },
    });
    deskInstance.ingest(taskResult('input-required', [escalationEvent()]), request);

    await expect(deskInstance.reject('esc-1')).rejects.toThrow(/vassal unreachable/);
    expect(deskInstance.list('pending')).toHaveLength(1);
    // C-audit 22: a failed downstream cancel is governance-relevant and must
    // reach the audit trail with the reason, even though the escalation stayed
    // pending and no rejection was recorded.
    expect(auditEvents.at(-1)).toMatchObject({
      escalationId: 'esc-1',
      action: 'rejected',
      detail: 'task cancel failed: vassal unreachable',
    });
  });

  it('refuses to decide an unknown or already-decided escalation', () => {
    const deskInstance = desk();
    deskInstance.ingest(taskResult('input-required', [escalationEvent()]), request);
    expect(() => deskInstance.approve('nope')).toThrow(/unknown escalation/);
    deskInstance.approve('esc-1');
    expect(() => deskInstance.approve('esc-1')).toThrow(/already approved/);
  });
});

describe('S10 V2 interruption levels on the escalation queue', () => {
  it('levels a task-input escalation L1 via the classifier chain', () => {
    const esc = desk().ingest(taskResult('input-required', [escalationEvent()]), request);
    expect(esc!.interruptLevel).toBe(1);
  });

  it('levels an unresolvable intent-conflict L1 (auto-resolvable splits never reach the desk)', () => {
    const esc = desk().ingestConflict({
      intentId: 'intent-1',
      runId: 'run-1',
      skill: 'decide',
      realm: 'personal',
      conflict: { reason: 'split', stances: [{ stance: 'approve', vassals: ['a'] }, { stance: 'reject', vassals: ['b'] }] },
    });
    expect(esc.interruptLevel).toBe(1);
  });

  it('levels a memory dispute L1 (async ruling, never blocks other intents)', () => {
    const esc = desk().ingestMemoryDispute({
      id: 'disp-1',
      runId: 'run-1',
      realm: 'personal',
      realmId: 'personal',
      factId: 'f1',
      conflictingFacts: ['f1', 'f2'],
      reason: 'contradictory reliability',
    });
    expect(esc.interruptLevel).toBe(1);
  });

  it('levels a delegation-limit escalation L1 by default and accepts the tick classifier verdict', () => {
    const defaulted = desk().ingestDelegationLimit({
      watchId: 'w1', delegationId: 'c1', skill: 'merge', realm: 'personal',
      limitReason: 'revoked', tickSeq: 1,
    });
    expect(defaulted.interruptLevel).toBe(1);
    const blocking = desk().ingestDelegationLimit({
      watchId: 'w2', delegationId: 'c2', skill: 'merge', realm: 'personal',
      limitReason: 'no-contract', tickSeq: 1, interruptLevel: 2,
    });
    expect(blocking.interruptLevel).toBe(2);
  });

  it('carries the level on the escalated audit action and through snapshots', () => {
    const audits: OversightAuditEntry[] = [];
    const instance = desk({ audit: entry => audits.push(entry) });
    const esc = instance.ingest(taskResult('input-required', [escalationEvent()]), request)!;
    expect(audits.find(entry => entry.action === 'escalated')?.interruptLevel).toBe(1);
    const restored = new OversightDesk({ newId: () => 'esc-x' });
    restored.importState(instance.exportState());
    expect(restored.get(esc.id)?.interruptLevel).toBe(1);
  });
});

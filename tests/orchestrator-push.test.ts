import { describe, expect, it, vi } from 'vitest';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

/**
 * E4.11 (design-a2a-push): a push-armed branch dispatches via plain tasks/send
 * (ack only) and settles only when the peer pushes the final task back through
 * `Orchestrator.receivePushNotification`. The classification (input-required →
 * onTaskInput, failed → branch failure, else ok) is identical to the streaming
 * path; idempotency is per taskId with the first settlement winning.
 */

function statusEvent(taskId: string, state: Task['status']['state'] = 'completed'): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: true };
}

/** The ack a plain tasks/send returns — not a final task, just acceptance. */
function ack(vassal: string, state: Task['status']['state'] = 'working'): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state },
    artifacts: [],
  };
  return { ok: true, task, events: [statusEvent(task.id, state)], injectedHits: [] };
}

function pushTask(vassal: string, state: Task['status']['state'], message?: string): Task {
  return {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx',
    status: { state, ...(message ? { message: { code: 'E', message } } : {}) },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
  };
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function immediatePort(started: string[] = []) {
  const cancelled: Array<{ vassal: string; taskId: string }> = [];
  const port: DispatchPort = {
    async dispatch(req: DispatchRequest) {
      started.push(req.vassal!);
      return ack(req.vassal!);
    },
    async cancel(vassal: string, taskId: string) {
      cancelled.push({ vassal, taskId });
    },
  };
  return { port, started, cancelled };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function build(names: string[], options: OrchestratorOptions = {}) {
  const started: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const onTaskInput = vi.fn();
  const { port, cancelled } = immediatePort(started);
  const orchestrator = new Orchestrator(lookupFor(names), port, {
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    audit: entry => audits.push({ ...entry }),
    onTaskInput,
    ...options,
  });
  return { orchestrator, started, cancelled, audits, onTaskInput };
}

const PUSH_RECEIVER = { url: 'http://127.0.0.1:8787/api/a2a/push-notifications', token: 't' };

describe('E4.11 A2A push notification — arming and refusal', () => {
  it('refuses an armed intent when no receiver is configured (push-unconfigured, zero dispatch)', async () => {
    const { orchestrator, started } = build(['a']);
    const result = await orchestrator.fanOut({
      skill: 'review', realm: 'personal', params: {}, pushNotification: true,
    });
    expect(result.status).toBe('failed');
    expect(result.refused?.reason).toBe('push-unconfigured');
    expect(started).toEqual([]);
  });

  it('keeps unarmed intents on the streaming path (no push config attached, settles immediately)', async () => {
    const { orchestrator } = build(['a'], { pushReceiver: PUSH_RECEIVER });
    const result = await orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });
    expect(result.status).toBe('completed');
    expect(result.branches[0]?.ok).toBe(true);
  });
});

describe('E4.11 A2A push notification — branch settlement via the callback', () => {
  it('an armed branch stays pending until the push lands, then settles completed', async () => {
    const { orchestrator, audits } = build(['a'], { pushReceiver: PUSH_RECEIVER });
    let settled = false;
    const fanOut = orchestrator
      .fanOut({ skill: 'review', realm: 'personal', params: {}, pushNotification: true })
      .then(result => { settled = true; return result; });
    await flush();
    expect(settled).toBe(false);

    const pushed = pushTask('a', 'completed');
    const received = await orchestrator.receivePushNotification(pushed);
    expect(received.ok).toBe(true);
    if (received.ok) expect(received.idempotent).toBe(false);

    const result = await fanOut;
    expect(result.status).toBe('completed');
    expect(result.branches[0]).toMatchObject({ vassal: 'a', ok: true, state: 'completed', taskId: 'a-t' });
    expect(audits).toContainEqual(
      expect.objectContaining({
        decision: 'push-notification-received', taskId: 'a-t', state: 'completed',
        runId: expect.stringMatching(/run-1:a$/), vassal: 'a',
      }),
    );
  });

  it('an input-required push reaches the E6.1 desk exactly once (onTaskInput), mirroring the stream path', async () => {
    const { orchestrator, onTaskInput } = build(['a'], { pushReceiver: PUSH_RECEIVER });
    const fanOut = orchestrator.fanOut({
      skill: 'review', realm: 'personal', params: {}, pushNotification: true,
      aggregation: { kind: 'unanimous' },
    });
    await flush();

    const pushed = pushTask('a', 'input-required');
    const first = await orchestrator.receivePushNotification(pushed);
    expect(first.ok).toBe(true);
    const second = await orchestrator.receivePushNotification(pushed);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.idempotent).toBe(true);

    const result = await fanOut;
    // The escalation is the desk's handle; the branch itself is ok like the
    // streaming path, so the intent completes (E6.1 owns the follow-up).
    expect(result.branches[0]).toMatchObject({ ok: true, state: 'input-required' });
    expect(onTaskInput).toHaveBeenCalledTimes(1);
    expect(onTaskInput.mock.calls[0]![0].task.id).toBe('a-t');
    // The desk-ingest contract (DispatchResult) is what the boot wires into
    // OversightDesk.ingest — idempotent per taskId on its own side.
    expect(onTaskInput.mock.calls[0]![0].task.status.state).toBe('input-required');
  });

  it('a failed push settles the branch as a failure with the agent own reason', async () => {
    const { orchestrator } = build(['a'], { pushReceiver: PUSH_RECEIVER });
    const fanOut = orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {}, pushNotification: true });
    await flush();
    await orchestrator.receivePushNotification(pushTask('a', 'failed', 'vassal-side failure'));
    const result = await fanOut;
    expect(result.status).toBe('failed');
    expect(result.branches[0]).toMatchObject({ ok: false, state: 'failed', reason: 'vassal-side failure' });
  });

  it('an unknown task is refused and audited (bearer-valid anomaly, not transport noise)', async () => {
    const { orchestrator, audits } = build([], { pushReceiver: PUSH_RECEIVER });
    const received = await orchestrator.receivePushNotification(pushTask('ghost', 'completed'));
    expect(received.ok).toBe(false);
    if (!received.ok) expect(received.reason).toBe('unknown-task');
    expect(audits).toContainEqual(
      expect.objectContaining({ decision: 'push-notification-refused', taskId: 'ghost-t' }),
    );
  });

  it('a branch whose push never arrives times out, and the ack task id is cancellable', async () => {
    const { orchestrator, cancelled } = build(['a'], { pushReceiver: PUSH_RECEIVER });
    const result = await orchestrator.fanOut({
      skill: 'review', realm: 'personal', params: {}, pushNotification: true, branchTimeoutMs: 30,
    });
    expect(result.branches[0]).toMatchObject({ ok: false, timedOut: true });
    // Unlike the stream case (which has no task id at timeout), the ack task id
    // is known — so the timed-out branch is cancelled by its real id.
    await flush();
    expect(cancelled).toContainEqual({ vassal: 'a', taskId: 'a-t' });
  });
});

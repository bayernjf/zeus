import { describe, expect, it } from 'vitest';
import { Dispatcher, type AuditEntry } from '../src/dispatch/dispatcher.js';
import { memoryAuditSink } from '../src/dispatch/audit.js';
import type { AgentCard, Fealty, Task } from '../src/a2a/types.js';
import type { VassalLike, VassalLookup } from '../src/dispatch/types.js';

function fealty(overrides: Partial<Fealty> = {}): Fealty {
  return { version: '1', swornTo: 'zeus', domain: 'pr-release-control', dataRealms: ['enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto', ...overrides };
}

function vassal(overrides: Partial<VassalLike> = {}): VassalLike {
  return {
    name: 'pr-helper',
    taskUrl: 'http://pr-helper.internal/api/a2a/tasks',
    card: { name: 'pr-helper', url: '', skills: [{ id: 'create-pr', name: '', description: '', tags: [] }] },
    fealty: fealty(),
    ...overrides,
  };
}

function sseResponse(events: unknown[], finalTask: Task): Response {
  const chunks = [...events.map(event => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: event })}\n\n`), `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: finalTask })}\n\n`];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function task(state: Task['status']['state'], id = 'task-1'): Task {
  return { kind: 'task', id, contextId: 'ctx', status: { state }, artifacts: [] };
}

function fakeVassalServer(options: { seenBodies?: unknown[]; token?: string; status?: Task['status']['state']; escalate?: boolean } = {}) {
  const seenBodies: unknown[] = (options.seenBodies = options.seenBodies ?? []);
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (init?.method !== 'POST') throw new Error(`unexpected method on ${url}`);
    if (options.token && init.headers && (init.headers as Record<string, string>).Authorization !== `Bearer ${options.token}`) {
      return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seenBodies.push(body);
    if (options.escalate) {
      return sseResponse(
        [
          { kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'input-required' }, final: true, 'x-zeus': { runId: 'r' }, 'x-zeus-escalation': { level: 'driver', reason: 'irreversible: merge', options: ['approve', 'reject'] } },
        ],
        task('input-required')
      );
    }
    return sseResponse(
      [
        { kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'working' }, final: false },
        { kind: 'artifact-update', taskId: 'task-1', contextId: 'ctx', artifact: { artifactId: 'a1', name: 'plan', parts: [] } },
      ],
      task(options.status ?? 'completed')
    );
  };
}

function dispatcher(vassalMap: Map<string, VassalLike>, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, token?: string) {
  const { log, sink } = memoryAuditSink();
  const dispatcherInstance = new Dispatcher(vassalMap, { audit: sink, fetchImpl, tokenFor: () => token });
  return { dispatcherInstance, audit: log };
}

describe('Dispatcher', () => {
  it('dispatches a task, streams events, and audits dispatched + final state', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: { owner: 'acme', repo: 'app' }, realm: 'enterprise' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status.state).toBe('completed');
    expect(result.events.map(event => event.kind)).toEqual(['status-update', 'artifact-update']);

    const body = seenBodies[0] as { params: { message: { metadata: Record<string, string>; parts: Array<{ data: Record<string, unknown> }> } } };
    expect(body.params.message.metadata['x-zeus-runId']).toMatch(/^zeus-run-/);
    expect(body.params.message.parts[0].data.skill).toBe('create-pr');

    const decisions = audit.map((entry: AuditEntry) => entry.decision);
    expect(decisions).toEqual(['dispatched', 'dispatched']);
    expect(audit[1]).toMatchObject({ vassal: 'pr-helper', taskId: 'task-1', state: 'completed' });
  });

  it('refuses personal-realm tasks for an enterprise-only vassal (data diode)', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'personal' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('excludes personal');
    expect(audit[0].decision).toBe('refused-realm-policy');
    expect(seenBodies).toHaveLength(0);
  });

  it('does not relabel an audit-write failure as a vassal dispatch failure', async () => {
    const seenBodies: unknown[] = [];
    const log: AuditEntry[] = [];
    let writes = 0;
    const sink = (entry: AuditEntry): void => {
      writes += 1;
      // First write is the pre-dispatch record; the second is the post-dispatch
      // one, which now sits outside the transport try/catch.
      if (writes === 2) throw new Error('ENOSPC: audit volume is full');
      log.push(entry);
    };
    const d = new Dispatcher(new Map([['pr-helper', vassal()]]), { audit: sink, fetchImpl: fakeVassalServer({ seenBodies }) });

    await expect(d.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' })).rejects.toThrow(/ENOSPC/);
    expect(log.map(entry => entry.decision)).not.toContain('dispatch-failed');
  });

  it('refuses unknown vassals and unknown skills', async () => {
    const { dispatcherInstance, audit } = dispatcher(new Map(), fakeVassalServer({}));
    const byName = await dispatcherInstance.dispatch({ vassal: 'ghost', skill: 'create-pr', params: {}, realm: 'enterprise' });
    expect(byName.ok).toBe(false);
    const bySkill = await dispatcherInstance.dispatch({ skill: 'does-not-exist', params: {}, realm: 'enterprise' });
    expect(bySkill.ok).toBe(false);
    expect(audit.map(entry => entry.decision)).toEqual(['refused-unknown-vassal', 'refused-unknown-vassal']);
  });

  it('redacts realm content when fealty.dataPolicy is none', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['loom', vassal({ name: 'loom', fealty: fealty({ domain: 'content-production', dataRealms: ['personal'], dataPolicy: 'none' }), card: { name: 'loom', url: '', skills: [{ id: 'generate-content', name: '', description: '', tags: [] }] } })]]);
    const { dispatcherInstance } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ skill: 'generate-content', params: {}, realm: 'personal', realmHits: [{ itemId: 'diary-1', snippet: 'secret' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.injectedHits).toEqual([]);
    const body = seenBodies[0] as { params: { message: { parts: Array<{ data: Record<string, unknown> }> } } };
    expect(body.params.message.parts[0].data.realmHits).toBeUndefined();
  });

  it('injects task-scoped realm hits for read-task-scope vassals', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise', realmHits: [{ itemId: 'hit-1', snippet: 'pr context' }] });

    expect(result.ok).toBe(true);
    const body = seenBodies[0] as { params: { message: { parts: Array<{ data: Record<string, unknown> }> } } };
    expect(body.params.message.parts[0].data.realmHits).toEqual([{ itemId: 'hit-1', snippet: 'pr context' }]);
  });

  it('honors a revoked entry in a Map-wired lookup', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal({ revoked: true })]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));

    const named = await dispatcherInstance.dispatch({ vassal: 'pr-helper', skill: 'create-pr', params: {}, realm: 'enterprise' });
    const auto = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });

    expect(named.ok).toBe(false);
    expect(auto.ok).toBe(false);
    expect(audit.map(entry => entry.decision)).toEqual(['refused-revoked', 'refused-unknown-vassal']);
    expect(seenBodies).toHaveLength(0);
  });

  it('refuses when the vassal is revoked between the gate and credential issuance', async () => {
    const active = vassal();
    let statusCalls = 0;
    const lookup: VassalLookup = {
      get: () => active,
      // 'active' for the governance gate, 'revoked' by the time the credential is read
      statusOf: () => (statusCalls++ === 0 ? 'active' : 'revoked'),
      findBySkill: () => [active],
    };
    const seenBodies: unknown[] = [];
    const { log, sink } = memoryAuditSink();
    const d = new Dispatcher(lookup, { audit: sink, fetchImpl: fakeVassalServer({ seenBodies }), tokenFor: () => 'zeus-secret' });

    const result = await d.dispatch({ vassal: 'pr-helper', skill: 'create-pr', params: {}, realm: 'enterprise' });

    expect(result.ok).toBe(false);
    expect(log[0].decision).toBe('refused-revoked');
    expect(seenBodies).toHaveLength(0);
  });

  it('refuses an explicitly named vassal that does not declare the skill', async () => {
    const seenBodies: unknown[] = [];
    const { dispatcherInstance, audit } = dispatcher(new Map([['pr-helper', vassal()]]), fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ vassal: 'pr-helper', skill: 'merge-pr', params: {}, realm: 'enterprise' });

    expect(result.ok).toBe(false);
    expect(audit[0].decision).toBe('refused-skill-uninstalled');
    expect(seenBodies).toHaveLength(0);
  });

  it('audits escalations as input-required terminal states', async () => {
    const map = new Map([['pr-helper', vassal({ card: { name: 'pr-helper', url: '', skills: [{ id: 'create-pr', name: '', description: '', tags: [] }, { id: 'merge-pr', name: '', description: '', tags: [] }] } })]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ escalate: true }));
    const result = await dispatcherInstance.dispatch({ vassal: 'pr-helper', skill: 'merge-pr', params: { mode: 'execute' }, realm: 'enterprise' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status.state).toBe('input-required');
    const escalation = result.events[0] as Record<string, unknown>;
    expect(escalation['x-zeus-escalation']).toMatchObject({ level: 'driver' });
    expect(audit[1].state).toBe('input-required');
  });

  it('sends the bearer token when configured', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance } = dispatcher(map, fakeVassalServer({ seenBodies, token: 'zeus-secret' }), 'zeus-secret');
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });
    expect(result.ok).toBe(true);
  });

  it('requires an explicit vassal name when several provide the same skill', async () => {
    const twin = vassal({ name: 'pr-helper-2', taskUrl: 'http://twin.internal/api/a2a/tasks' });
    const map = new Map([['pr-helper', vassal()], ['pr-helper-2', twin]]);
    const { dispatcherInstance } = dispatcher(map, fakeVassalServer({}));
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('pr-helper-2');
  });

  describe('sla.ackSeconds enforcement', () => {
    function dispatcherWithClock(
      map: Map<string, VassalLike>,
      fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
      elapsed: () => number
    ) {
      const { log, sink } = memoryAuditSink();
      const dispatcherInstance = new Dispatcher(map, { audit: sink, fetchImpl, elapsed });
      return { dispatcherInstance, audit: log };
    }

    /** Two-call monotonic clock: dispatch start -> first streamed event. */
    function steppingClock(firstEventMs: number): () => number {
      let call = 0;
      return () => (call++ === 0 ? 0 : firstEventMs);
    }

    it('stays silent when the first event arrives within ackSeconds', async () => {
      const map = new Map([['pr-helper', vassal({ fealty: fealty({ sla: { ackSeconds: 5 } }) })]]);
      const { dispatcherInstance, audit } = dispatcherWithClock(map, fakeVassalServer({}), steppingClock(100));
      const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });
      expect(result.ok).toBe(true);
      expect(audit.map((entry: AuditEntry) => entry.decision)).not.toContain('sla-ack-breached');
    });

    it('audits sla-ack-breached (without failing the task) when the first event is late', async () => {
      const map = new Map([['pr-helper', vassal({ fealty: fealty({ sla: { ackSeconds: 5 } }) })]]);
      const { dispatcherInstance, audit } = dispatcherWithClock(map, fakeVassalServer({}), steppingClock(6000));
      const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });

      expect(result.ok).toBe(true);
      const breach = audit.find((entry: AuditEntry) => entry.decision === 'sla-ack-breached');
      expect(breach).toBeDefined();
      expect(breach).toMatchObject({ vassal: 'pr-helper', taskId: 'task-1' });
      expect(breach?.detail).toContain('6000ms');
      expect(breach?.detail).toContain('ackSeconds=5');
    });

    it('does not measure anything when the vassal declares no sla', async () => {
      const map = new Map([['pr-helper', vassal()]]);
      const { dispatcherInstance, audit } = dispatcherWithClock(map, fakeVassalServer({}), steppingClock(60_000));
      const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });
      expect(result.ok).toBe(true);
      expect(audit.map((entry: AuditEntry) => entry.decision)).not.toContain('sla-ack-breached');
    });
  });
});

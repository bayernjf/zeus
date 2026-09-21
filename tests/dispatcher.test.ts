import { describe, expect, it } from 'vitest';
import { Dispatcher, type AuditEntry } from '../src/dispatch/dispatcher.js';
import { memoryAuditSink } from '../src/dispatch/audit.js';
import type { AgentCard, Fealty, Task } from '../src/a2a/types.js';
import type { VassalLike } from '../src/dispatch/types.js';

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

  it('audits escalations as input-required terminal states', async () => {
    const map = new Map([['pr-helper', vassal()]]);
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
});

import { describe, expect, it } from 'vitest';
import { Dispatcher, type AuditEntry, type DispatchResult } from '../src/dispatch/dispatcher.js';
import { memoryAuditSink } from '../src/dispatch/audit.js';
import type { Fealty, Task } from '../src/a2a/types.js';
import type { VassalLike, VassalLookup } from '../src/dispatch/types.js';
import type { RealmHit } from '../src/realm/types.js';

function hit(itemId: string, snippet: string): RealmHit {
  return { itemId, tags: [], modifiedAt: '2026-09-25T00:00:00.000Z', snippet };
}

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
  it('§7: aborts a live stream when the caller signal fires and audits branch-aborted', async () => {
    const map = new Map([['pr-helper', vassal()]]);
    const controller = new AbortController();
    const { dispatcherInstance, audit } = dispatcher(map, async (_url, init) => {
      // A stream that never ends unless the caller aborts it, like a healthy
      // long-lived A2A subscription a driver cancels mid-flight.
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          const encoder = new TextEncoder();
          stream.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`));
          init?.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const resultPromise = dispatcherInstance.dispatch({
      vassal: 'pr-helper', skill: 'create-pr', params: {}, realm: 'enterprise', signal: controller.signal,
    });
    controller.abort();
    const result = await resultPromise;
    expect(result).toMatchObject({ ok: false, reason: 'aborted by the driver' });
    expect(audit.some(entry => entry.decision === 'branch-aborted')).toBe(true);
  });

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
    expect(body.params.message.parts[0]!.data.skill).toBe('create-pr');

    const decisions = audit.map((entry: AuditEntry) => entry.decision);
    // One dispatch, one record. A second, taskId-less 'dispatched' used to be
    // written before the request left, so every governance view that counts by
    // decision read double.
    expect(decisions).toEqual(['dispatched']);
    expect(audit[0]!).toMatchObject({ vassal: 'pr-helper', taskId: 'task-1', state: 'completed' });
  });

  it('refuses personal-realm tasks for an enterprise-only vassal (data diode)', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'personal' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('excludes personal');
    expect(audit[0]!.decision).toBe('refused-realm-policy');
    expect(seenBodies).toHaveLength(0);
  });

  it('does not relabel an audit-write failure as a vassal dispatch failure', async () => {
    const seenBodies: unknown[] = [];
    const log: AuditEntry[] = [];
    let writes = 0;
    const sink = (entry: AuditEntry): void => {
      writes += 1;
      // The single success record sits outside the transport try/catch, so a
      // failure to write it must escape as itself rather than be relabelled.
      if (writes === 1) throw new Error('ENOSPC: audit volume is full');
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

  it('refuses realm content for a none-policy vassal instead of dropping it silently', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['loom', vassal({ name: 'loom', fealty: fealty({ domain: 'content-production', dataRealms: ['personal'], dataPolicy: 'none' }), card: { name: 'loom', url: '', skills: [{ id: 'generate-content', name: '', description: '', tags: [] }] } })]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ skill: 'generate-content', params: {}, realm: 'personal', realmHits: [hit('diary-1', 'secret')], realmHitsOrigin: 'caller-asserted' });

    // design-realm §3.1: none accepts no realm content at all; the request is
    // refused and audited rather than silently stripped.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.audit.decision).toBe('refused-data-policy');
    expect(result.audit.detail).toMatch(/dataPolicy=none/);
    expect(seenBodies).toHaveLength(0);
    expect(audit.map(entry => entry.decision)).toEqual(['refused-data-policy']);
  });

  it('refuses self-asserted hits for a read-task-scope vassal (only kernel-resolved may pass)', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise', realmHits: [hit('hit-1', 'pr context')], realmHitsOrigin: 'caller-asserted' });

    // "Belongs to this task" is only verifiable when the kernel itself resolved
    // the hits; a caller's claim cannot be checked, so it is refused outright.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.audit.decision).toBe('refused-data-policy');
    expect(result.audit.detail).toMatch(/self-asserted/);
    expect(result.audit.detail).toMatch(/read-task-scope/);
    expect(seenBodies).toHaveLength(0);
    expect(audit.map(entry => entry.decision)).toEqual(['refused-data-policy']);
  });

  it('injects kernel-resolved hits for a read-task-scope vassal and audits the injection', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const hits = [hit('hit-1', 'pr context')];
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise', realmHits: hits, realmHitsOrigin: 'kernel-resolved' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.injectedHits).toEqual(hits);
    const body = seenBodies[0] as { params: { message: { parts: Array<{ data: Record<string, unknown> }> } } };
    expect(body.params.message.parts[0]!.data.realmHits).toEqual(hits);
    const injected = audit.find(entry => entry.decision === 'content-injected');
    expect(injected).toBeDefined();
    expect(injected?.detail).toMatch(/dataPolicy=read-task-scope, origin=kernel-resolved, hits=1/);
  });

  it('injects caller-asserted hits for a read-realm vassal (the operator is the data sovereign)', async () => {
    const seenBodies: unknown[] = [];
    const map = new Map([['pr-helper', vassal({ fealty: fealty({ dataPolicy: 'read-realm' }) })]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({ seenBodies }));
    const hits = [hit('hit-1', 'pr context')];
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise', realmHits: hits, realmHitsOrigin: 'caller-asserted' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = seenBodies[0] as { params: { message: { parts: Array<{ data: Record<string, unknown> }> } } };
    expect(body.params.message.parts[0]!.data.realmHits).toEqual(hits);
    expect(audit.map(entry => entry.decision)).toContain('content-injected');
  });

  it('fails closed when hits carry no origin', async () => {
    const map = new Map([['pr-helper', vassal()]]);
    const { dispatcherInstance, audit } = dispatcher(map, fakeVassalServer({}));
    const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise', realmHits: [hit('hit-1', 'pr context')] });

    // A path that forgets to tag provenance must not silently degrade into
    // "anything goes"; the dispatch is refused instead.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.audit.decision).toBe('refused-data-policy');
    expect(result.audit.detail).toMatch(/no origin/);
    expect(audit.map(entry => entry.decision)).toEqual(['refused-data-policy']);
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
    expect(log[0]!.decision).toBe('refused-revoked');
    expect(seenBodies).toHaveLength(0);
  });

  it('refuses an explicitly named vassal that does not declare the skill', async () => {
    const seenBodies: unknown[] = [];
    const { dispatcherInstance, audit } = dispatcher(new Map([['pr-helper', vassal()]]), fakeVassalServer({ seenBodies }));
    const result = await dispatcherInstance.dispatch({ vassal: 'pr-helper', skill: 'merge-pr', params: {}, realm: 'enterprise' });

    expect(result.ok).toBe(false);
    expect(audit[0]!.decision).toBe('refused-skill-uninstalled');
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
    expect(audit[0]!.state).toBe('input-required');
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

  // The declared hit shape dropped `snippet` while every returned hit carries one,
  // so a consumer could not read a field that is always there. Type-level guard:
  // it fails `tsc --noEmit`, not the runtime assertion.
  it('declares the snippet on the injected hits it returns', () => {
    type Hit = Extract<DispatchResult, { ok: true }>['injectedHits'][number];
    type HasSnippet = 'snippet' extends keyof Hit ? 'yes' : 'no';
    const declared: HasSnippet = 'yes';
    expect(declared).toBe('yes');
  });

  describe('cancel', () => {
    it('audits a forwarded cancellation so the governance surface sees it', async () => {
      const map = new Map([['pr-helper', vassal()]]);
      const fetches: string[] = [];
      const fetchImpl = async (url: string): Promise<Response> => {
        fetches.push(url);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: task('canceled') }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const { log, sink } = memoryAuditSink();
      const d = new Dispatcher(map, { audit: sink, fetchImpl });

      const cancelled = await d.cancel('pr-helper', 'task-1');

      expect(fetches).toEqual(['http://pr-helper.internal/api/a2a/tasks']);
      expect(cancelled.status.state).toBe('canceled');
      // A dispatch is audited; a cancellation used to vanish from the trail.
      expect(log.map(entry => entry.decision)).toEqual(['cancel-requested']);
      expect(log[0]).toMatchObject({ vassal: 'pr-helper', taskId: 'task-1' });
    });

    it('refuses to cancel through a revoked vassal, and audits the refusal', async () => {
      const map = new Map([['pr-helper', vassal({ revoked: true })]]);
      const { log, sink } = memoryAuditSink();
      let reached = false;
      const d = new Dispatcher(map, {
        audit: sink,
        fetchImpl: async () => {
          reached = true;
          return new Response('{}', { status: 200 });
        },
      });

      await expect(d.cancel('pr-helper', 'task-1')).rejects.toThrow(/revoked/);
      expect(reached).toBe(false);
      expect(log.map(entry => entry.decision)).toEqual(['refused-revoked']);
      expect(log[0]).toMatchObject({ vassal: 'pr-helper', taskId: 'task-1' });
    });

    it('audits a cancel aimed at a vassal that is not registered', async () => {
      const { log, sink } = memoryAuditSink();
      const d = new Dispatcher(new Map<string, VassalLike>(), { audit: sink, fetchImpl: fakeVassalServer({}) });
      await expect(d.cancel('ghost', 'task-1')).rejects.toThrow(/ghost/);
      expect(log.map(entry => entry.decision)).toEqual(['refused-unknown-vassal']);
    });
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

    it('audits sla-ack-breached for a peer that returns only a terminal snapshot', async () => {
      const map = new Map([['pr-helper', vassal({ fealty: fealty({ sla: { ackSeconds: 5 } }) })]]);
      // No intermediate events at all: the only acceptance signal is the snapshot.
      const fetchImpl = async () => sseResponse([], task('completed'));
      const { dispatcherInstance, audit } = dispatcherWithClock(map, fetchImpl, steppingClock(6000));
      const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });

      expect(result.ok).toBe(true);
      const breach = audit.find((entry: AuditEntry) => entry.decision === 'sla-ack-breached');
      expect(breach).toMatchObject({ vassal: 'pr-helper', taskId: 'task-1' });
      expect(breach?.detail).toContain('6000ms');
    });

    it('stays silent for a prompt non-streaming peer', async () => {
      const map = new Map([['pr-helper', vassal({ fealty: fealty({ sla: { ackSeconds: 5 } }) })]]);
      const fetchImpl = async () => sseResponse([], task('completed'));
      const { dispatcherInstance, audit } = dispatcherWithClock(map, fetchImpl, steppingClock(100));
      const result = await dispatcherInstance.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise' });
      expect(result.ok).toBe(true);
      expect(audit.map((entry: AuditEntry) => entry.decision)).not.toContain('sla-ack-breached');
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

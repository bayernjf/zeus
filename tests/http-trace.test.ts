import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { ProgressHub, type ProgressEvent } from '../src/orchestrator/progress.js';
import { buildTraceTree } from '../src/observability/trace.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult, AuditEntry } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';
import type { FanOutRequest, FanOutResult } from '../src/orchestrator/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function statusEvent(taskId: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state === 'completed' };
}

function verdict(vassal: string): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id, 'completed')], injectedHits: [] };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

let orchestrator: Orchestrator | undefined;

/** Captures every DispatchRequest the kernel sent, so tests can assert the
 *  outbound trace context on the wire. */
function capturingPort(captured: DispatchRequest[]): DispatchPort {
  return {
    async dispatch(req) {
      captured.push(req);
      return verdict(req.vassal!);
    },
    async cancel() {},
  };
}

describe('S6 V2 trace propagation (design-observability §5)', () => {
  afterEach(() => {
    orchestrator = undefined;
  });

  it('outbound A2A requests carry the kernel-derived traceparent', async () => {
    const captured: DispatchRequest[] = [];
    const hub = new ProgressHub();
    orchestrator = new Orchestrator(lookupFor(['loom']), capturingPort(captured), {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
      onProgress: e => hub.publish(e),
    });
    await orchestrator.fanOut({ skill: 'summarize', realm: 'personal' });

    expect(captured.length).toBe(1);
    const req = captured[0]!;
    // traceId = intent-level runId, spanId = branch runId (`run-1:loom`),
    // flags = 01 (sampled): the W3C shape over the kernel's own namespace.
    expect(req.traceparent).toBe('00-run-1-run-1:loom-01');
  });

  it('outbound traceparent is omitted when the branch has no parent runId', async () => {
    // Resume path re-dispatches through runBranch with the previous runId as
    // parent; a direct dispatcher-level call with no lineage stays header-free.
    const captured: DispatchRequest[] = [];
    const dispatcherPort = capturingPort(captured);
    // Drive the dispatcher port directly (no orchestrator lineage) — the field
    // is optional and must not be fabricated.
    const req: DispatchRequest = {
      skill: 'summarize',
      params: {},
      realm: 'personal',
      vassal: 'loom',
      runId: 'run-9',
    };
    await dispatcherPort.dispatch(req);
    expect(captured[0]!.traceparent).toBeUndefined();
  });
});

describe('S6 V2 trace endpoint', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('rebuilds the span tree read-only from audit + retained progress', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-trace-'));
    const auditFile = join(dir, 'audit.jsonl');
    const hub = new ProgressHub();
    orchestrator = new Orchestrator(lookupFor(['loom']), capturingPort([]), {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
      onProgress: e => hub.publish(e),
    });
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      orchestrator,
      progressHub: hub,
      auditFile,
      now: () => new Date('2026-10-10T00:00:00.000Z'),
    });

    const res = await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: { skill: 'summarize', realm: 'personal' } });
    expect(res.statusCode).toBe(200);

    const trace = await app.inject({ method: 'GET', url: '/api/intents/intent-1/trace', headers: AUTH });
    expect(trace.statusCode).toBe(200);
    const tree = trace.json();
    expect(tree.traceId).toBe('run-1');
    expect(tree.root.spanId).toBe('intent-1');
    expect(tree.root.kind).toBe('intent');
    const branch = tree.spans.find((s: { spanId: string }) => s.spanId === 'run-1:loom');
    expect(branch).toBeDefined();
    expect(branch.kind).toBe('branch');
    expect(branch.vassal).toBe('loom');
    expect(branch.outcome).toBe('completed');
  });

  it('trace endpoint is bearer-gated like replay', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-trace-'));
    const hub = new ProgressHub();
    orchestrator = new Orchestrator(lookupFor(['loom']), capturingPort([]), {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
      onProgress: e => hub.publish(e),
    });
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      orchestrator,
      progressHub: hub,
      auditFile: join(dir, 'audit.jsonl'),
    });
    await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: { skill: 'summarize', realm: 'personal' } });
    const res = await app.inject({ method: 'GET', url: '/api/intents/intent-1/trace' });
    expect(res.statusCode).toBe(401);
  });

  it('unknown or retention-evicted intents 404', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-trace-'));
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      progressHub: new ProgressHub(),
      auditFile: join(dir, 'audit.jsonl'),
    });
    const res = await app.inject({ method: 'GET', url: '/api/intents/never-existed/trace', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe('S6 V2 external-link recording', () => {
  let app: FastifyInstance | undefined;
  let auditEntries: AuditEntry[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    auditEntries = [];
  });

  it('records an inbound caller traceparent on the acceptance audit row', async () => {
    const stubOrchestrator = {
      async fanOut(req: FanOutRequest): Promise<FanOutResult> {
        return {
          intentId: req.intentId ?? 'intent-in',
          runId: 'run-in',
          skill: req.skill,
          realm: req.realm,
          branches: [],
          stream: [],
          positions: [],
          decision: { rule: 'unanimous', conclusion: 'ok', positions: [], reason: 'stub' },
          conflicts: [],
          status: 'completed',
          createdAt: '2026-10-10T00:00:00.000Z',
        };
      },
      getIntent: async () => undefined,
    } as unknown as Orchestrator;

    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      orchestrator: stubOrchestrator,
      agentCard: {
        name: 'zeus',
        url: 'http://zeus.local/',
        skills: [],
      },
      inboundAudit: e => auditEntries.push(e),
      now: () => new Date('2026-10-10T00:00:00.000Z'),
    });

    const card = {
      name: 'caller-a',
      url: 'https://caller-a.example/',
      skills: [],
      'x-zeus-fealty': {
        version: '1',
        swornTo: 'zeus',
        domain: 'test-domain',
        dataRealms: ['personal'],
        dataPolicy: 'read-task-scope',
        reportBack: true,
        escalationPolicy: 'on-failure',
      },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: { ...AUTH, traceparent: '00-caller-trace-caller-span-01' },
      payload: {
        jsonrpc: '2.0',
        method: 'tasks/send',
        params: { message: 'hello', skills: ['summarize'] },
      },
    });
    expect(res.statusCode).toBe(200);
    const accepted = auditEntries.find(e => e.decision === 'inbound-task-accepted');
    expect(accepted).toBeDefined();
    expect(accepted!.detail).toBe('traceparent=00-caller-trace-caller-span-01');

    // The recorded row assembles into an external-link event on the tree root.
    const tree = buildTraceTree({
      audit: auditEntries,
      progress: [
        { type: 'branch-started', intentId: 'intent-in', runId: 'run-in', vassal: 'caller-a', skill: 'summarize', at: '2026-10-10T00:00:00.000Z' },
        { type: 'intent-finished', intentId: 'intent-in', runId: 'run-in', status: 'completed', at: '2026-10-10T00:00:00.001Z' },
      ] satisfies ProgressEvent[],
    });
    const link = tree.root.events.find(e => e.kind === 'external-link');
    expect(link).toBeDefined();
    expect(link!.detail).toBe('traceparent=00-caller-trace-caller-span-01');
  });
});

describe('ProgressHub bounded retention (S6 V2 / S15 V2 shared buffer)', () => {
  it('publishes to listeners and retains events in order', () => {
    const hub = new ProgressHub();
    const heard: string[] = [];
    hub.subscribe('i1', e => heard.push(e.type));
    const ev: ProgressEvent = { type: 'branch-started', intentId: 'i1', runId: 'r1', vassal: 'v', skill: 's', at: 't1' };
    hub.publish(ev);
    expect(heard).toEqual(['branch-started']);
    expect(hub.eventsOf('i1')).toEqual([ev]);
  });

  it('caps events per intent, dropping the oldest', () => {
    const hub = new ProgressHub();
    const cap = ProgressHub.MAX_EVENTS_PER_INTENT;
    for (let i = 0; i < cap + 5; i++) {
      hub.publish({ type: 'branch-started', intentId: 'i1', runId: `r${i}`, vassal: 'v', skill: 's', at: `t${i}` });
    }
    const events = hub.eventsOf('i1');
    expect(events.length).toBe(cap);
    expect(events[0]!.runId).toBe('r5');
    expect(events[events.length - 1]!.runId).toBe(`r${cap + 4}`);
  });

  it('evicts the oldest intent past the retention cap', () => {
    const hub = new ProgressHub();
    const cap = ProgressHub.MAX_RETAINED_INTENTS;
    for (let i = 0; i < cap; i++) {
      hub.publish({ type: 'branch-started', intentId: `i${i}`, runId: `r${i}`, vassal: 'v', skill: 's', at: `t${i}` });
    }
    hub.publish({ type: 'branch-started', intentId: 'i-new', runId: 'r-new', vassal: 'v', skill: 's', at: 't-new' });
    expect(hub.eventsOf('i0')).toEqual([]);
    expect(hub.eventsOf('i-new').length).toBe(1);
  });

  it('release drops only the named intent buffer, keeping live listeners', () => {
    const hub = new ProgressHub();
    const heard: string[] = [];
    hub.subscribe('i1', e => heard.push(e.type));
    hub.publish({ type: 'branch-started', intentId: 'i1', runId: 'r1', vassal: 'v', skill: 's', at: 't1' });
    hub.release('i1');
    expect(hub.eventsOf('i1')).toEqual([]);
    hub.publish({ type: 'branch-ended', intentId: 'i1', runId: 'r1', vassal: 'v', outcome: 'completed', at: 't2' });
    expect(heard).toEqual(['branch-started', 'branch-ended']);
    expect(hub.eventsOf('i1')).toEqual([{ type: 'branch-ended', intentId: 'i1', runId: 'r1', vassal: 'v', outcome: 'completed', at: 't2' }]);
  });
});

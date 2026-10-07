import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { FanOutRequest, FanOutResult } from '../src/orchestrator/types.js';
import type { AgentCard, Fealty } from '../src/a2a/types.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

let app: FastifyInstance | undefined;
let auditEntries: AuditEntry[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  auditEntries = [];
});

const TOKEN = { authorization: 'Bearer driver-secret' };

function makeCard(name: string, fealty: Fealty | undefined): AgentCard {
  return {
    name,
    url: `https://${name}.example/`,
    skills: [],
    ...(fealty ? { 'x-zeus-fealty': fealty } : {}),
  };
}

const VALID_FEALTY: Fealty = {
  version: '1',
  swornTo: 'zeus',
  domain: 'test-domain',
  dataRealms: ['personal'],
  dataPolicy: 'read-task-scope',
  reportBack: true,
  escalationPolicy: 'on-failure',
};

/** Minimal in-process orchestrator stub: answers with a deterministic result. */
function makeOrchestrator(status: FanOutResult['status']): Orchestrator {
  return {
    fanOut: async (request: FanOutRequest): Promise<FanOutResult> => ({
      intentId: request.intentId ?? 'intent-1',
      runId: 'run-1',
      skill: request.skill,
      realm: request.realm,
      branches: [],
      stream: [],
      positions: [],
      decision: { rule: 'unanimous', conclusion: 'ok', positions: [], reason: 'stub' },
      conflicts: [],
      status,
      createdAt: '2026-10-07T00:00:00.000Z',
    }),
    getIntent: async () => undefined,
  } as unknown as Orchestrator;
}

async function mount(status: FanOutResult['status'] = 'completed'): Promise<FastifyInstance> {
  app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
    internalToken: 'driver-secret',
    orchestrator: makeOrchestrator(status),
    agentCard: makeCard('zeus', undefined),
    inboundAudit: entry => auditEntries.push(entry),
  });
  return app;
}

function rpc(id: number | string, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}

describe('Inbound A2A face (design-inbound-a2a v0.1, deferred #19)', () => {
  it('does not mount the inbound face when agentCard is not configured (default unchanged)', async () => {
    const server = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
      internalToken: 'driver-secret',
    });
    app = server;
    const get = await server.inject({ method: 'GET', url: '/.well-known/agent-card.json' });
    expect(get.statusCode).toBe(404);
  });

  it('serves the Zeus agent card publicly with no fealty of its own', async () => {
    const server = await mount();
    const res = await server.inject({ method: 'GET', url: '/.well-known/agent-card.json' });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.name).toBe('zeus');
    expect(card.skills).toEqual([]);
    expect(card['x-zeus-fealty']).toBeUndefined();
    expect(res.headers['cache-control']).toContain('public');
  });

  it('rejects tasks/send without the bearer token', async () => {
    const server = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      payload: rpc(1, 'tasks/send', { message: 'hello', skills: ['summarize'] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-tasks/send JSON-RPC method', async () => {
    const server = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: TOKEN,
      payload: rpc(1, 'ping'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('refuses a caller card without a valid zeus fealty (fail-closed, audited)', async () => {
    const server = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: { ...TOKEN, 'x-zeus-caller-card': JSON.stringify(makeCard('rogue', { version: '1', swornTo: 'other', domain: 'x', dataRealms: ['personal'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'on-failure' })) },
      payload: rpc(1, 'tasks/send', { skills: ['summarize'] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('caller_refused');
    expect(auditEntries.some(entry => entry.decision === 'inbound-task-refused' && entry.vassal === 'rogue')).toBe(true);
  });

  it('refuses a caller card whose fealty fails the oath shape gate', async () => {
    const server = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: { ...TOKEN, 'x-zeus-caller-card': JSON.stringify(makeCard('sloppy', { ...VALID_FEALTY, domain: '   ' })) },
      payload: rpc(1, 'tasks/send', { skills: ['summarize'] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('caller_refused');
  });

  it('rejects an unparsable caller card header as malformed input', async () => {
    const server = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: { ...TOKEN, 'x-zeus-caller-card': '{not json' },
      payload: rpc(1, 'tasks/send', { skills: ['summarize'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires a non-empty skills array', async () => {
    const server = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: TOKEN,
      payload: rpc(1, 'tasks/send', { message: 'hello' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('skills');
    expect(auditEntries.some(entry => entry.decision === 'inbound-task-refused')).toBe(true);
  });

  it('lands a valid tasks/send on the intent surface and returns a task receipt', async () => {
    const server = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: { ...TOKEN, 'x-zeus-caller-card': JSON.stringify(makeCard('helper', VALID_FEALTY)) },
      payload: rpc(1, 'tasks/send', { taskId: 'caller-task-7', message: 'summarize the diary', skills: ['summarize'] }),
    });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(task.kind).toBe('task');
    expect(task.id).toBe('caller-task-7');
    expect(task.status.state).toBe('completed');
    // The caller's correlation id and identity ride along in params.
    expect(auditEntries.some(entry => entry.decision === 'inbound-task-accepted' && entry.vassal === 'helper' && entry.taskId === 'caller-task-7')).toBe(true);
  });

  it('defaults realm to personal and maps needs-driver to input-required', async () => {
    const server = await mount('needs-driver');
    const res = await server.inject({
      method: 'POST',
      url: '/.well-known/agent-card.json',
      headers: TOKEN,
      payload: rpc(1, 'tasks/send', { taskId: 'caller-task-9', skills: ['arbitrate'] }),
    });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(task.status.state).toBe('input-required');
    const accepted = auditEntries.find(entry => entry.decision === 'inbound-task-accepted');
    expect(accepted?.realm).toBe('personal');
  });
});

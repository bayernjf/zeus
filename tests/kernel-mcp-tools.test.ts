// G6 (design-observability §5): the read-only kernel tool face over MCP.
// POST /api/mcp serves memory.recall (namespace-bound, MemoryPort v1 §7
// semantics, cross-realm refused through MemoryBoundaryError) and traces.query
// (driver-only, transparent pass-through of the TracePort v1 §5 query).
// Writes have no MCP surface: remember/forget stay on the HTTP consumer face.

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import type { MemoryEvent } from '../src/memory/types.js';
import { JsonlTraceExporter } from '../src/observability/exporter.js';
import { buildTraceTree } from '../src/observability/trace.js';

const DRIVER_TOKEN = 'driver-secret';
const MEMORY_TOKEN = 'consumer-secret-one';
const REALM = 'realm-personal';
const DRIVER_AUTH = { authorization: `Bearer ${DRIVER_TOKEN}` };
const CONSUMER_AUTH = { authorization: `Bearer ${MEMORY_TOKEN}` };

function claim(eventId: string, subject: string, predicate: string, object: unknown): MemoryEvent {
  return {
    eventId,
    realmId: REALM,
    runId: `run-${eventId}`,
    source: { agentId: subject },
    kind: 'claim',
    content: { subject, predicate, object },
    refs: [],
    confidence: 0.7,
    occurredAt: '2026-10-31T00:00:00.000Z',
  };
}

function traceTree(traceId: string, vassal: string, cents = 0.1) {
  return buildTraceTree({
    audit: [],
    progress: [
      { type: 'branch-started', intentId: `intent-${traceId}`, runId: traceId, vassal, skill: 'research', at: '2026-10-31T00:00:00.000Z' },
      { type: 'branch-ended', intentId: `intent-${traceId}`, runId: traceId, vassal, outcome: 'completed', at: '2026-10-31T00:00:05.000Z' },
    ],
    traces: [{
      runId: traceId,
      backend: 'hub',
      model: 'm1',
      request: { kind: 'noul', question: 'q', stateKeys: [] },
      latencyMs: 100,
      cost: { inputTokens: 10, outputTokens: 5, cents },
      decidedAt: '2026-10-31T00:00:01.000Z',
    }],
  });
}

type Harness = { app: FastifyInstance; cleanup: () => Promise<void> };

async function mount(options: {
  memory?: boolean;
  traces?: boolean;
  consumerToken?: boolean;
}): Promise<Harness> {
  const store = new MemoryStore();
  store.append(claim('evt-1', 'pr-helper', 'language', 'typescript'));
  store.append(claim('evt-2', 'loom', 'language', 'python'));
  store.consolidateRealm(REALM);
  const dir = mkdtempSync(join(tmpdir(), 'zeus-kernel-mcp-'));
  const exporter = new JsonlTraceExporter(join(dir, 'traces.jsonl'));
  await exporter.export(traceTree('t1', 'a1'));
  await exporter.export(traceTree('t2', 'a2', 0.5));
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: DRIVER_TOKEN,
    ...(options.consumerToken ? { memoryServiceTokens: { [REALM]: MEMORY_TOKEN, other: 'consumer-secret-two' } } : {}),
    ...(options.memory ? { memoryStore: store } : {}),
    ...(options.traces ? { traceExporter: exporter } : {}),
    kernelToolsMcp: true,
    ...(options.consumerToken || options.memory ? { memoryServiceAudit: () => {} } : {}),
  });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

async function call(app: FastifyInstance, headers: Record<string, string>, params: unknown) {
  return app.inject({ method: 'POST', url: '/api/mcp', headers, payload: rpc(1, 'tools/call', params) });
}

/** Unwrap a tools/call result to the parsed JSON payload of its first text part. */
function toolJson(res: { json: () => any }): any {
  return JSON.parse(res.json().result.content[0].text);
}

afterEach(async () => {
  // harnesses close themselves inside each test to keep local cleanup order
});

describe('G6 kernel tool face over MCP (POST /api/mcp)', () => {
  it('is not mounted without kernelToolsMcp or a backing store', async () => {
    const bare = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: DRIVER_TOKEN,
    });
    try {
      const res = await bare.inject({ method: 'POST', url: '/api/mcp', headers: DRIVER_AUTH, payload: rpc(1, 'tools/list') });
      expect(res.statusCode).toBe(404);
    } finally {
      await bare.close();
    }

    const flaggedButBackingless = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: DRIVER_TOKEN,
      kernelToolsMcp: true,
    });
    try {
      const res = await flaggedButBackingless.inject({ method: 'POST', url: '/api/mcp', headers: DRIVER_AUTH, payload: rpc(1, 'tools/list') });
      expect(res.statusCode).toBe(404);
    } finally {
      await flaggedButBackingless.close();
    }
  });

  it('challenges unauthenticated callers and serves public metadata on GET', async () => {
    const h = await mount({ memory: true, traces: true, consumerToken: true });
    try {
      const anon = await h.app.inject({ method: 'POST', url: '/api/mcp', payload: rpc(1, 'tools/list') });
      expect(anon.statusCode).toBe(401);
      expect(anon.headers['www-authenticate']).toBe('Bearer');
      const wrong = await h.app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: 'Bearer nope' }, payload: rpc(1, 'tools/list') });
      expect(wrong.statusCode).toBe(401);

      const meta = await h.app.inject({ method: 'GET', url: '/api/mcp' });
      expect(meta.statusCode).toBe(200);
      expect(meta.json().serverInfo).toMatchObject({ name: 'zeus-kernel' });
    } finally {
      await h.cleanup();
    }
  });

  it('advertises exactly the two read-only tools', async () => {
    const h = await mount({ memory: true, traces: true, consumerToken: true });
    try {
      const res = await h.app.inject({ method: 'POST', url: '/api/mcp', headers: CONSUMER_AUTH, payload: rpc(1, 'tools/list') });
      expect(res.statusCode).toBe(200);
      const tools = res.json().result.tools as Array<{ name: string; description: string }>;
      expect(tools.map(t => t.name)).toEqual(['memory.recall', 'traces.query']);
      expect(tools.every(t => /read-only/i.test(t.description))).toBe(true);
      // The write face is deliberately absent from the MCP list.
      expect(tools.some(t => /remember|forget/.test(t.name))).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it('answers initialize and ping for both actor classes', async () => {
    const h = await mount({ memory: true, consumerToken: true });
    try {
      for (const headers of [DRIVER_AUTH, CONSUMER_AUTH]) {
        const init = await h.app.inject({ method: 'POST', url: '/api/mcp', headers, payload: rpc(2, 'initialize') });
        expect(init.json().result.protocolVersion).toBe('2025-06-18');
        const ping = await h.app.inject({ method: 'POST', url: '/api/mcp', headers, payload: rpc(3, 'ping') });
        expect(ping.json().result).toEqual({});
      }
    } finally {
      await h.cleanup();
    }
  });

  it('recalls memory for the driver with an explicit namespace', async () => {
    const h = await mount({ memory: true, consumerToken: true });
    try {
      const res = await call(h.app, DRIVER_AUTH, { name: 'memory.recall', arguments: { namespace: REALM, query: 'typescript' } });
      expect(res.statusCode).toBe(200);
      const body = toolJson(res);
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0]).toMatchObject({ kind: 'fact', subject: 'pr-helper', predicate: 'language', object: 'typescript' });
      expect(typeof body.hits[0].score).toBe('number');

      const noNamespace = await call(h.app, DRIVER_AUTH, { name: 'memory.recall', arguments: { query: 'typescript' } });
      expect(noNamespace.json().error.code).toBe(-32602);

      const badArgs = await call(h.app, DRIVER_AUTH, { name: 'memory.recall', arguments: { namespace: REALM, query: 'x', k: 0 } });
      expect(badArgs.json().error.code).toBe(-32602);

      const unknownParam = await call(h.app, DRIVER_AUTH, { name: 'memory.recall', arguments: { namespace: REALM, query: 'x', write: true } });
      expect(unknownParam.json().error.code).toBe(-32602);
    } finally {
      await h.cleanup();
    }
  });

  it('binds a memory consumer to its token namespace and refuses cross-realm claims', async () => {
    const h = await mount({ memory: true, consumerToken: true });
    try {
      // No namespace argument: the bound one is used.
      const bound = await call(h.app, CONSUMER_AUTH, { name: 'memory.recall', arguments: { query: 'typescript' } });
      expect(toolJson(bound).hits).toHaveLength(1);
      expect(toolJson(bound).hits[0].subject).toBe('pr-helper');

      // Claiming the bound namespace explicitly is fine.
      const explicit = await call(h.app, CONSUMER_AUTH, { name: 'memory.recall', arguments: { namespace: REALM, query: 'python' } });
      expect(toolJson(explicit).hits[0].subject).toBe('loom');

      // Claiming another namespace is the cross-realm refusal, by the same
      // error class the store raises everywhere else.
      const other = await call(h.app, CONSUMER_AUTH, { name: 'memory.recall', arguments: { namespace: 'other', query: 'x' } });
      expect(other.json().error.code).toBe(-32004);
      expect(other.json().error.message).toContain(`realm ${REALM} cannot read memory of realm other`);
    } finally {
      await h.cleanup();
    }
  });

  it('filters recall hits by kind', async () => {
    const h = await mount({ memory: true, consumerToken: true });
    try {
      const all = await call(h.app, DRIVER_AUTH, { name: 'memory.recall', arguments: { namespace: REALM, query: 'language' } });
      const hits = toolJson(all).hits as Array<{ kind: string }>;
      expect(hits.length).toBeGreaterThan(0);
      const filtered = await call(h.app, DRIVER_AUTH, { name: 'memory.recall', arguments: { namespace: REALM, query: 'language', kinds: 'preference' } });
      expect(toolJson(filtered).hits).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it('fails memory.recall closed by name when no memory store is mounted', async () => {
    const h = await mount({ traces: true });
    try {
      const res = await call(h.app, DRIVER_AUTH, { name: 'memory.recall', arguments: { namespace: REALM, query: 'x' } });
      expect(res.json().error.code).toBe(-32005);
      expect(res.json().error.message).toContain('not mounted');
    } finally {
      await h.cleanup();
    }
  });

  it('serves the trace query pass-through for the driver', async () => {
    const h = await mount({ traces: true });
    try {
      const res = await call(h.app, DRIVER_AUTH, { name: 'traces.query', arguments: { agent: 'a2' } });
      expect(res.statusCode).toBe(200);
      const body = toolJson(res);
      expect(body.traces.map((t: { traceId: string }) => t.traceId)).toEqual(['t2']);
      expect(body.summary).toEqual({ totalLatencyMs: 100, totalCostMicros: 5000, errorCount: 0, count: 1 });

      const byId = await call(h.app, DRIVER_AUTH, { name: 'traces.query', arguments: { trace_id: 't1' } });
      expect(toolJson(byId).traces.map((t: { traceId: string }) => t.traceId)).toEqual(['t1']);

      const badFrom = await call(h.app, DRIVER_AUTH, { name: 'traces.query', arguments: { from: 'not-a-date' } });
      expect(badFrom.json().error.code).toBe(-32602);
      const badLimit = await call(h.app, DRIVER_AUTH, { name: 'traces.query', arguments: { limit: 0 } });
      expect(badLimit.json().error.code).toBe(-32602);
      const unknownParam = await call(h.app, DRIVER_AUTH, { name: 'traces.query', arguments: { write: true } });
      expect(unknownParam.json().error.code).toBe(-32602);
    } finally {
      await h.cleanup();
    }
  });

  it('refuses traces.query to a memory consumer and fails closed without an exporter', async () => {
    const h = await mount({ memory: true, consumerToken: true });
    try {
      const res = await call(h.app, CONSUMER_AUTH, { name: 'traces.query', arguments: {} });
      expect(res.json().error.code).toBe(-32004);
      expect(res.json().error.message).toContain('driver token');

      const noExporter = await call(h.app, DRIVER_AUTH, { name: 'traces.query', arguments: {} });
      expect(noExporter.json().error.code).toBe(-32005);
    } finally {
      await h.cleanup();
    }
  });

  it('rejects unknown tools and unknown methods by name', async () => {
    const h = await mount({ memory: true, traces: true });
    try {
      const unknownTool = await call(h.app, DRIVER_AUTH, { name: 'memory.remember', arguments: {} });
      expect(unknownTool.json().error.code).toBe(-32602);
      expect(unknownTool.json().error.message).toContain('unknown tool');

      const unknownMethod = await h.app.inject({ method: 'POST', url: '/api/mcp', headers: DRIVER_AUTH, payload: rpc(1, 'resources/list') });
      expect(unknownMethod.json().error.code).toBe(-32601);
    } finally {
      await h.cleanup();
    }
  });
});

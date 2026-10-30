// TracePort v1 §5 (D-5): the cross-intent trace query face. GET /api/v1/traces
// projects filters over the JsonlTraceExporter's in-memory index, bearer-gated
// like every other observability face, and mounts only when an exporter exists.

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { JsonlTraceExporter } from '../src/observability/exporter.js';
import { buildTraceTree } from '../src/observability/trace.js';
import type { TraceTree } from '../src/observability/trace.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function tree(traceId: string, vassal: string, cents = 0.1): TraceTree {
  return buildTraceTree({
    audit: [],
    progress: [
      { type: 'branch-started', intentId: `intent-${traceId}`, runId: traceId, vassal, skill: 'research', at: '2026-10-30T00:00:00.000Z' },
      { type: 'branch-ended', intentId: `intent-${traceId}`, runId: traceId, vassal, outcome: 'completed', at: '2026-10-30T00:00:05.000Z' },
    ],
    traces: [{
      runId: traceId,
      backend: 'hub',
      model: 'm1',
      request: { kind: 'noul', question: 'q', stateKeys: [] },
      latencyMs: 100,
      cost: { inputTokens: 10, outputTokens: 5, cents },
      decidedAt: '2026-10-30T00:00:01.000Z',
    }],
  });
}

describe('D-5 trace query endpoint', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function serverWith(exporter: JsonlTraceExporter): Promise<FastifyInstance> {
    return createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      traceExporter: exporter,
    });
  }

  it('serves matching trees with a summary over the returned set', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-traces-'));
    const exporter = new JsonlTraceExporter(join(dir, 'traces.jsonl'));
    await exporter.export(tree('t1', 'a1'));
    await exporter.export(tree('t2', 'a2'));
    app = await serverWith(exporter);

    const res = await app.inject({ method: 'GET', url: '/api/v1/traces?agent=a2', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.traces.map((t: { traceId: string }) => t.traceId)).toEqual(['t2']);
    // 100 ms latency, 0.1 cents = 1000 micros, no errors, one tree.
    expect(body.summary).toEqual({ totalLatencyMs: 100, totalCostMicros: 1000, errorCount: 0, count: 1 });
    // Model spans ride the served trees.
    const model = body.traces[0].spans.find((s: { kind: string }) => s.kind === 'model');
    expect(model.call).toMatchObject({ backend: 'hub', model: 'm1', costMicros: 1000, latencyMs: 100 });
  });

  it('narrows by trace_id and cost band', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-traces-'));
    const exporter = new JsonlTraceExporter(join(dir, 'traces.jsonl'));
    await exporter.export(tree('t1', 'a1'));
    await exporter.export(tree('t2', 'a2', 0.5));
    app = await serverWith(exporter);

    const byId = await app.inject({ method: 'GET', url: '/api/v1/traces?trace_id=t2', headers: AUTH });
    expect(byId.json().traces.map((t: { traceId: string }) => t.traceId)).toEqual(['t2']);

    const byCost = await app.inject({ method: 'GET', url: '/api/v1/traces?min_cost_micros=2000', headers: AUTH });
    expect(byCost.json().traces.map((t: { traceId: string }) => t.traceId)).toEqual(['t2']);

    const byWindow = await app.inject({ method: 'GET', url: '/api/v1/traces?from=2026-10-31T00:00:00.000Z', headers: AUTH });
    expect(byWindow.json().traces).toHaveLength(0);
  });

  it('is bearer-gated like every other observability face', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-traces-'));
    const exporter = new JsonlTraceExporter(join(dir, 'traces.jsonl'));
    await exporter.export(tree('t1', 'a1'));
    app = await serverWith(exporter);

    const res = await app.inject({ method: 'GET', url: '/api/v1/traces' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed query params', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-traces-'));
    const exporter = new JsonlTraceExporter(join(dir, 'traces.jsonl'));
    app = await serverWith(exporter);

    for (const url of [
      '/api/v1/traces?from=not-a-date',
      '/api/v1/traces?to=also-not-a-date',
      '/api/v1/traces?min_cost_micros=-1',
      '/api/v1/traces?max_cost_micros=1.5',
      '/api/v1/traces?limit=0',
      '/api/v1/traces?limit=abc',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode).toBe(400);
      expect(res.json().code ?? res.json().error).toBeDefined();
    }
  });

  it('is not mounted without a trace exporter', async () => {
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/traces', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

// G2 (design-observability §5): the opt-in OTLP/HTTP JSON exporter. A fake
// transport pins the payload shape (OTel GenAI semantic conventions, zeus.*
// extension attributes, deterministic W3C-shaped id mapping, parent linkage);
// the boot wiring proves "unconfigured = nothing dials out" and the fail-soft
// contract (transport failure resolves, logs, never blocks the settle path).

import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import { OtlpTraceExporter, toOtlpPayload } from '../src/observability/exporter.js';
import { buildTraceTree, type TraceTree } from '../src/observability/trace.js';
import type { DecisionTrace } from '../src/decision/types.js';

const ENDPOINT = 'http://collector.test:4318/v1/traces';

function cardFor(name: string) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'bayjf', url: 'http://bayjf.test' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'review', name: 'Review', description: '', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      dataRealms: ['personal'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'on-failure',
    },
  };
}

function settlingFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const task = {
      kind: 'task',
      id: `${name}-task`,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
    };
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: task })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }) as typeof fetch;
}

function decisionTrace(runId: string): DecisionTrace {
  return {
    runId,
    backend: 'hub',
    model: 'doubao-seed-1.6',
    request: { kind: 'noul', question: 'q', stateKeys: [] },
    latencyMs: 120,
    usage: { inputTokens: 110, outputTokens: 30, reasoningTokens: 7, cacheReadTokens: 5, tokensEstimated: false },
    cost: { inputTokens: 110, outputTokens: 30, cents: 0.15 },
    decidedAt: '2026-10-31T00:00:01.000Z',
  };
}

function treeWithModelError(): TraceTree {
  return buildTraceTree({
    traceId: 'trace-g2',
    audit: [],
    progress: [
      { type: 'branch-started', intentId: 'intent-g2', runId: 'run-g2', vassal: 'alpha', skill: 'review', at: '2026-10-31T00:00:00.000Z' },
      { type: 'branch-ended', intentId: 'intent-g2', runId: 'run-g2', vassal: 'alpha', outcome: 'completed', at: '2026-10-31T00:00:05.000Z' },
    ],
    traces: [decisionTrace('run-g2')],
  });
}

function capturedBody(fetchLog: Array<{ url: string; init: RequestInit | undefined }>): Record<string, any> {
  expect(fetchLog).toHaveLength(1);
  return JSON.parse(String(fetchLog[0]!.init!.body));
}

/** The one attribute value with this key on this span (any wire type). */
function valueOf(span: any, key: string): string | number | boolean | undefined {
  const attribute = (span.attributes ?? []).find((a: any) => a.key === key);
  return attribute?.value?.stringValue ?? attribute?.value?.intValue;
}
function attrOf(span: any, key: string): string | undefined {
  return (span.attributes ?? []).find((a: any) => a.key === key)?.value?.stringValue;
}
function intOf(span: any, key: string): number | undefined {
  const raw = (span.attributes ?? []).find((a: any) => a.key === key)?.value?.intValue;
  return raw === undefined ? undefined : Number(raw);
}

describe('G2 OtlpTraceExporter payload shape', () => {
  it('POSTs one OTLP JSON payload with resource + scope framing and GenAI attributes', async () => {
    const fetchLog: Array<{ url: string; init: RequestInit | undefined }> = [];
    const exporter = new OtlpTraceExporter({
      endpoint: ENDPOINT,
      headers: { authorization: 'Bearer collector-secret' },
      fetchImpl: (async (url, init) => {
        fetchLog.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    await exporter.export(treeWithModelError());

    expect(fetchLog[0]!.url).toBe(ENDPOINT);
    expect(fetchLog[0]!.init!.method).toBe('POST');
    expect((fetchLog[0]!.init!.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect((fetchLog[0]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer collector-secret');

    const body = capturedBody(fetchLog);
    const resource = body.resourceSpans[0];
    expect(attrOfSpan(resource.resource, 'service.name')).toBe('zeus');
    expect(resource.scopeSpans[0].scope.name).toBe('zeus.observability');
    // One OTLP span per zeus span: the projection's root travels alongside
    // tree.spans (which excludes it).
    const spans = resource.scopeSpans[0].spans as any[];
    expect(spans.length).toBe(treeWithModelError().spans.length + 1);

    const root = spans.find(s => s.name === 'execute_task' && attrOf(s, 'zeus.span.kind') === 'intent')!;
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.parentSpanId).toBeUndefined();
    expect(attrOf(root, 'zeus.intent.id')).toBe('intent-g2');
    expect(attrOf(root, 'gen_ai.conversation.id')).toBe('trace-g2');

    const branch = spans.find(s => attrOf(s, 'zeus.span.kind') === 'branch')!;
    expect(attrOf(branch, 'gen_ai.agent.name')).toBe('alpha');
    expect(attrOf(branch, 'zeus.skill')).toBe('review');
    expect(branch.parentSpanId).toBe(root.spanId);

    const model = spans.find(s => attrOf(s, 'zeus.span.kind') === 'model')!;
    expect(model.name).toBe('chat doubao-seed-1.6');
    expect(model.kind).toBe(3); // CLIENT
    expect(attrOf(model, 'gen_ai.operation.name')).toBe('chat');
    expect(attrOf(model, 'gen_ai.system')).toBe('hub');
    expect(attrOf(model, 'gen_ai.request.model')).toBe('doubao-seed-1.6');
    expect(intOf(model, 'gen_ai.usage.input_tokens')).toBe(110);
    expect(intOf(model, 'gen_ai.usage.output_tokens')).toBe(30);
    expect(intOf(model, 'gen_ai.usage.reasoning_tokens')).toBe(7);
    expect(intOf(model, 'gen_ai.usage.cache_read.input_tokens')).toBe(5);
    expect(Number(valueOf(model, 'zeus.cost_micros'))).toBe(1500); // cents → micros, same unit as the ledger
    expect(model.parentSpanId).toBe(branch.spanId);
  });

  it('maps ids deterministically and marks errored spans with status ERROR', () => {
    const payload = toOtlpPayload(treeWithModelError());
    const again = toOtlpPayload(treeWithModelError());
    const spanOf = (p: ReturnType<typeof toOtlpPayload>, kind: string) =>
      p.resourceSpans[0]!.scopeSpans[0]!.spans.find(s => (s.attributes ?? []).some(a => a.key === 'zeus.span.kind' && (a.value as { stringValue?: string }).stringValue === kind))!;
    expect(spanOf(payload, 'model').spanId).toBe(spanOf(again, 'model').spanId);
    expect(spanOf(payload, 'model').traceId).toMatch(/^[0-9a-f]{32}$/);

    const errored = buildTraceTree({
      traceId: 'trace-err',
      audit: [],
      progress: [
        { type: 'branch-started', intentId: 'i', runId: 'r', vassal: 'alpha', skill: 'review', at: '2026-10-31T00:00:00.000Z' },
        { type: 'branch-ended', intentId: 'i', runId: 'r', vassal: 'alpha', outcome: 'failed', at: '2026-10-31T00:00:01.000Z' },
      ],
      traces: [{ ...decisionTrace('r'), error: { code: 'timeout', message: 'backend timed out' } }],
    });
    const errPayload = toOtlpPayload(errored);
    const failed = errPayload.resourceSpans[0]!.scopeSpans[0]!.spans.find(s => s.status !== undefined)!;
    expect(failed.status!.code).toBe(2);
    expect(failed.status!.message).toContain('timeout');
    // Healthy spans carry no status at all (UNSET, not OK).
    const healthy = toOtlpPayload(treeWithModelError()).resourceSpans[0]!.scopeSpans[0]!.spans
      .filter(s => attrOfSpan(s, 'zeus.span.kind') === 'intent');
    expect(healthy.every(s => s.status === undefined)).toBe(true);
  });
});

function attrOfSpan(span: any, key: string): string | undefined {
  return (span.attributes ?? []).find((a: any) => a.key === key)?.value?.stringValue;
}

describe('G2 OtlpTraceExporter fail-soft contract', () => {
  it('resolves on transport failure and reports through the log sink', async () => {
    const logged: Array<{ event: string; message: string | undefined }> = [];
    const exporter = new OtlpTraceExporter({
      endpoint: ENDPOINT,
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
      log: (event, message) => logged.push({ event, message }),
    });
    await expect(exporter.export(treeWithModelError())).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.event).toBe('otlp-export-failed');
    expect(logged[0]!.message).toContain('connection refused');
  });

  it('resolves on a non-2xx collector answer', async () => {
    const logged: Array<{ event: string; message: string | undefined }> = [];
    const exporter = new OtlpTraceExporter({
      endpoint: ENDPOINT,
      fetchImpl: (async () => new Response('collector overloaded', { status: 503 })) as typeof fetch,
      log: (event, message) => logged.push({ event, message }),
    });
    await expect(exporter.export(treeWithModelError())).resolves.toBeUndefined();
    expect(logged[0]!.message).toContain('503');
  });
});

describe('G2 boot wiring (opt-in, unconfigured = silent)', () => {
  async function pollUntil<T>(probe: () => T, predicate: (value: T) => boolean, budgetMs = 2000): Promise<T> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const value = await probe();
      if (predicate(value)) return value;
      if (Date.now() > deadline) throw new Error(`pollUntil timed out after ${budgetMs}ms`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('attaches no OTLP exporter by default', async () => {
    const kernel = await bootKernel({ fetchImpl: settlingFetch() });
    expect(kernel.otlpTraceExporter).toBeUndefined();
  });

  it('exports a settled intent to the injected transport alongside the JSONL file', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'zeus-otlp-'));
    const fetchLog: Array<{ url: string; init: RequestInit | undefined }> = [];
    const kernel = await bootKernel({
      fetchImpl: settlingFetch(),
      vassalSeeds: ['http://127.0.0.1/alpha/api/a2a/agent-card'],
      auditFile: join(dir, 'audit.jsonl'),
      stateFile: join(dir, 'state.json'),
      otlpTraceExporter: new OtlpTraceExporter({
        endpoint: ENDPOINT,
        fetchImpl: (async (url, init) => {
          fetchLog.push({ url: String(url), init });
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      }),
    });
    const result = await kernel.orchestrator.fanOut({
      intentId: 'intent-g2-boot',
      skill: 'review',
      params: { message: 'review this' },
      realm: 'personal',
      vassals: ['alpha'],
    });
    expect(result.status).toBe('completed');
    await pollUntil(() => fetchLog.length, n => n >= 1);
    const body = JSON.parse(String(fetchLog[0]!.init!.body));
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s: any) => attrOfSpan(s, 'zeus.intent.id') === 'intent-g2-boot')).toBe(true);
    await kernel.releaseLock();
  });
});

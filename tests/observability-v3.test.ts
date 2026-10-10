import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootKernel } from '../src/state/boot.js';
import { JsonlTraceExporter } from '../src/observability/exporter.js';
import { MetricsHistory } from '../src/observability/metrics-history.js';
import { buildTraceTree, type TraceTree } from '../src/observability/trace.js';
import type { MetricsSnapshot } from '../src/orchestrator/metrics.js';

/**
 * S6 V3 (design-observability §5): the local JSONL exporters and the boot
 * wiring. The exporter is a narrow port — default build attaches nothing, so
 * V1/V2 behaviour is byte-identical; when a local file is named, a settled
 * intent's trace tree lands there (keyed by traceId) and a metrics snapshot
 * lands on every state save (keyed by capturedAt). Everything is local-file:
 * no network export is shipped.
 */

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

function sampleTree(): TraceTree {
  return buildTraceTree({
    traceId: 'trace-1',
    audit: [
      { ts: '2026-10-10T00:00:00.000Z', vassal: 'alpha', skill: 'review', realm: 'personal', runId: 'r1', decision: 'chain-switched', detail: 'alpha -> beta' },
    ],
    progress: [
      { type: 'branch-started', intentId: 'intent-1', runId: 'r1', vassal: 'alpha', skill: 'review', at: '2026-10-10T00:00:00.000Z' },
      { type: 'branch-ended', intentId: 'intent-1', runId: 'r1', vassal: 'alpha', outcome: 'completed', at: '2026-10-10T00:00:01.000Z' },
    ],
  });
}

function sampleSnapshot(capturedAt: string): MetricsSnapshot {
  return {
    inFlight: 0, maxInFlight: 1, queueDepth: 0, finished: 1, completed: 1,
    failed: 0, timedOut: 0, canceled: 0, perVassal: {}, inFlightByVassal: {},
    historyWindow: { branchesPerVassal: 1000, trimmedBranches: 0 }, capturedAt,
  };
}

async function pollUntil<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, budgetMs = 2000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`pollUntil timed out after ${budgetMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('S6 V3 JsonlTraceExporter', () => {
  it('appends trees keyed by traceId, skips duplicates, and reads back oldest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-trace-'));
    const file = join(dir, 'trace-exporter.jsonl');
    const exporter = new JsonlTraceExporter(file);
    await exporter.loadIndex();
    await exporter.export(sampleTree());
    await exporter.export(sampleTree()); // duplicate traceId: skipped
    const second = { ...sampleTree(), traceId: 'trace-2' };
    await exporter.export(second);
    const trees = await exporter.readBack();
    expect(trees.map(t => t.traceId)).toEqual(['trace-1', 'trace-2']);
    // A fresh instance on the same file sees the same records (restart read).
    const reloaded = new JsonlTraceExporter(file);
    expect((await reloaded.readBack()).map(t => t.traceId)).toEqual(['trace-1', 'trace-2']);
  });

  it('writes a 0600 file and reads empty when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-trace-'));
    const file = join(dir, 'trace-exporter.jsonl');
    const exporter = new JsonlTraceExporter(file);
    expect(await exporter.readBack()).toEqual([]);
    await exporter.export(sampleTree());
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = await readFile(file, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });
});

describe('S6 V3 MetricsHistory', () => {
  it('captures snapshots keyed by capturedAt and reads them oldest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-history-'));
    const file = join(dir, 'metrics-history.jsonl');
    const history = new MetricsHistory(file);
    await history.capture(sampleSnapshot('2026-10-10T00:00:00.000Z'));
    await history.capture(sampleSnapshot('2026-10-10T00:00:00.000Z')); // duplicate: skipped
    await history.capture(sampleSnapshot('2026-10-10T00:01:00.000Z'));
    const read = await history.read();
    expect(read.map(s => s.capturedAt)).toEqual(['2026-10-10T00:00:00.000Z', '2026-10-10T00:01:00.000Z']);
    const reloaded = new MetricsHistory(file);
    expect((await reloaded.read()).map(s => s.capturedAt)).toEqual([
      '2026-10-10T00:00:00.000Z', '2026-10-10T00:01:00.000Z',
    ]);
  });

  it('reads empty when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-history-'));
    const history = new MetricsHistory(join(dir, 'metrics-history.jsonl'));
    expect(await history.read()).toEqual([]);
  });
});

describe('S6 V3 boot wiring', () => {
  it('exports a settled intent trace tree and captures a metrics snapshot on save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-v3-'));
    const stateFile = join(dir, 'kernel-state.json');
    const auditFile = join(dir, 'audit.jsonl');
    const traceFile = join(dir, 'trace-exporter.jsonl');
    const historyFile = join(dir, 'metrics-history.jsonl');

    const kernel = await bootKernel({
      fetchImpl: settlingFetch(),
      vassalSeeds: ['http://127.0.0.1/alpha/api/a2a/agent-card'],
      stateFile,
      auditFile,
      traceExportFile: traceFile,
      metricsHistoryFile: historyFile,
    });

    const result = await kernel.orchestrator.fanOut({
      intentId: 'intent-1',
      skill: 'review',
      params: { message: 'review this' },
      realm: 'personal',
      vassals: ['alpha'],
    });
    expect(result.status).toBe('completed');

    // The trace export is fire-and-forget on the settle path; poll until the
    // file holds the tree (or fail loudly instead of flaking).
    const exporter = new JsonlTraceExporter(traceFile);
    const trees = await pollUntil(async () => exporter.readBack(), list => list.length >= 1);
    expect(trees[0]!.traceId).toBe(result.runId);
    expect(trees[0]!.root.kind).toBe('intent');
    expect(trees[0]!.root.spanId).toBe('intent-1');
    expect(trees[0]!.spans.some(s => s.kind === 'branch' && s.vassal === 'alpha')).toBe(true);

    // One metrics snapshot lands on each state save.
    await kernel.saveState();
    const history = new MetricsHistory(historyFile);
    const read = await pollUntil(async () => history.read(), list => list.length >= 1);
    expect(read[0]!.finished).toBe(1);
  });

  it('keeps the narrow port unattached by default (V1/V2 behaviour)', async () => {
    const kernel = await bootKernel({ fetchImpl: settlingFetch() });
    expect(kernel.traceExporter).toBeUndefined();
    expect(kernel.metricsHistory).toBeUndefined();
  });
});

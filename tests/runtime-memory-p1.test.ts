import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootRuntime } from '../src/state/boot.js';
import { sha256Hex } from '../src/util/crypto.js';
import type { FetchLike } from '../src/registry/registry.js';
import type { AgentCard, Task } from '../src/a2a/types.js';
import type { MemoryEvent } from '../src/memory/types.js';

const CARD_URL = 'https://executor.example/api/a2a/agent-card';
const TASK_URL = 'https://executor.example/api/a2a/tasks';
const MEM_DATA_DOMAIN = 'dataDomain-A';

const card: AgentCard = {
  name: 'executor-1',
  url: TASK_URL,
  skills: [{ id: 'research', name: 'Research', description: 'researches', tags: [] }],
  'x-zeus-handshake': {
    version: '1', swornTo: 'zeus', domain: 'work', dataDomains: ['personal'],
    dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'on-failure',
  },
};

function sseCompleted(): Response {
  const finalTask: Task = { kind: 'task', id: 'task-1', contextId: 'ctx', status: { state: 'completed' }, artifacts: [] };
  const payload =
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n` +
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: finalTask })}\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const fetchImpl: FetchLike = async url => {
  if (url === CARD_URL) {
    return new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === TASK_URL) return sseCompleted();
  return new Response('nope', { status: 404 });
};

let n = 0;
function claim(object: unknown, eventId?: string): MemoryEvent {
  n += 1;
  return {
    eventId: eventId ?? `claim-${n}`,
    dataDomainId: MEM_DATA_DOMAIN,
    runId: 'obs-run-1',
    source: { agentId: 'agent-a' },
    kind: 'claim',
    content: { subject: 'Zeus', predicate: 'runs-on', object },
    refs: [],
    confidence: 0.8,
    occurredAt: '2026-09-22T10:00:00.000Z',
  };
}

describe('memory P1 runtime persistence', () => {
  it('persists events and facts in the runtime snapshot and restores them on restart', async () => {
    const stateFile = join(tmpdir(), `zeus-mem-${crypto.randomUUID()}.json`);
    const first = await bootRuntime({ stateFile });
    first.memoryStore!.append(claim('node'));
    await first.memoryStore!.consolidateDataDomain(MEM_DATA_DOMAIN);
    await first.saveState();

    const restarted = await bootRuntime({ stateFile });
    expect(restoredEvents(restarted)).toHaveLength(1);
    expect(restarted.memoryStore!.facts(MEM_DATA_DOMAIN, MEM_DATA_DOMAIN)).toHaveLength(1);
    expect(restarted.memoryStore!.replay(MEM_DATA_DOMAIN, 'obs-run-1').facts).toHaveLength(1);
  });
});

/**
 * The intent-finished boundary fires consolidation fire-and-forget (fail-soft,
 * now that embedding is asynchronous), so the disputes it ingests land a few
 * microtask hops later. One macrotask boundary flushes that chain — the local
 * embedder path is pure microtasks — before the assertions read the desk.
 */
function settleConsolidation(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('memory P1 auto-consolidation on intent completion', () => {
  it('consolidates the named dataDomain when the intent reaches a terminal state', async () => {
    const runtime = await bootRuntime({ executorSeeds: [CARD_URL], fetchImpl });
    runtime.memoryStore!.append(claim('node'));

    const result = await runtime.orchestrator.fanOut({
      skill: 'research', dataDomain: 'personal', dataDomainId: MEM_DATA_DOMAIN, params: {},
    });
    expect(result.status).toBe('completed');

    const facts = runtime.memoryStore!.facts(MEM_DATA_DOMAIN, MEM_DATA_DOMAIN);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.status).toBe('active');
  });

  it('escalates disputes to the oversight desk and stays idempotent on re-consolidation', async () => {
    const runtime = await bootRuntime({ executorSeeds: [CARD_URL], fetchImpl });
    runtime.memoryStore!.append(claim('node', 'c1'));
    runtime.memoryStore!.append({ ...claim('bun', 'c2'), source: { agentId: 'agent-b' } });

    await runtime.orchestrator.fanOut({
      skill: 'research', dataDomain: 'personal', dataDomainId: MEM_DATA_DOMAIN, params: {},
    });
    await settleConsolidation();

    const disputes = runtime.oversight.list().filter(e => e.kind === 'memory-dispute');
    expect(disputes).toHaveLength(1);
    expect(disputes[0]!.status).toBe('pending');
    expect(disputes[0]!.factId).toBeDefined();

    // A later intent consolidates the same disputed facts; the deterministic
    // escalation id means no duplicate row is ingested.
    await runtime.orchestrator.fanOut({
      skill: 'research', dataDomain: 'personal', dataDomainId: MEM_DATA_DOMAIN, params: {},
    });
    await settleConsolidation();
    expect(runtime.oversight.list().filter(e => e.kind === 'memory-dispute')).toHaveLength(1);
  });

  it('records corrections when the operator settles a dispute, lowering future reliability', async () => {
    const runtime = await bootRuntime({ executorSeeds: [CARD_URL], fetchImpl });
    runtime.memoryStore!.append(claim('node', 'c1'));
    runtime.memoryStore!.append({ ...claim('bun', 'c2'), source: { agentId: 'agent-b' } });
    await runtime.orchestrator.fanOut({
      skill: 'research', dataDomain: 'personal', dataDomainId: MEM_DATA_DOMAIN, params: {},
    });
    await settleConsolidation();

    const dispute = runtime.oversight.list().find(e => e.kind === 'memory-dispute')!;
    // Reject the new fact ('bun', authored by agent-b): agent-b is corrected.
    await runtime.oversight.reject(dispute.id);

    const corrections = runtime.memoryStore!.listCorrections();
    expect(corrections.map(c => c.agentId)).toEqual(['agent-b']);
    expect(runtime.memoryStore!.reliabilityScore('agent-b', 0.5)).toBeCloseTo(0.35);
  });
});

function restoredEvents(runtime: Awaited<ReturnType<typeof bootRuntime>>): MemoryEvent[] {
  return runtime.memoryStore!.read(MEM_DATA_DOMAIN, MEM_DATA_DOMAIN);
}

/**
 * MemoryPort v1 §6: the settled conclusion is written back as a decision
 * memory. The executor below returns a stance in its terminal artifact, so the
 * majority rule concludes and the writeback has something to persist.
 */
function sseCompletedWithStance(): Response {
  const finalTask: Task = {
    kind: 'task', id: 'task-1', contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
  };
  const payload =
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n` +
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: finalTask })}\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const stanceFetchImpl: FetchLike = async url => {
  if (url === CARD_URL) {
    return new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === TASK_URL) return sseCompletedWithStance();
  return new Response('nope', { status: 404 });
};

describe('memory P1 decision writeback', () => {
  it('writes the settled conclusion back as a deterministic decision fact, idempotently', async () => {
    // The writeback obeys the mount-table authority, so the dataDomain must be
    // mounted for the settled conclusion to land (dataDomainRoots mounts one).
    const dataDomainRoot = mkdtempSync(join(tmpdir(), 'zeus-mem-decision-'));
    try {
      const runtime = await bootRuntime({ executorSeeds: [CARD_URL], fetchImpl: stanceFetchImpl, dataDomainRoots: [dataDomainRoot] });
      const dataDomainId = runtime.dataDomainStore!.connections()[0]!.dataDomainId;
      const intentId = 'intent-decision-1';
      const result = await runtime.orchestrator.fanOut({
        intentId, skill: 'research', dataDomain: 'personal', dataDomainId, params: {},
      });
      expect(result.status).toBe('completed');
      expect(result.decision.conclusion).toBe('approve');
      await settleConsolidation();

      // The event id is deterministic per (intentId, runId) — recomputable from
      // the identifiers alone.
      const expectedEventId = `mem-decision-${sha256Hex(`${intentId}|${result.runId}`).slice(0, 16)}`;
      const decisionEvent = runtime.memoryStore!.read(dataDomainId, dataDomainId)
        .find(e => e.eventId === expectedEventId);
      expect(decisionEvent).toBeDefined();
      expect(decisionEvent!.content).toMatchObject({
        subject: 'research',
        predicate: 'settled-decision',
        object: { conclusion: 'approve', intentId },
        category: 'decision',
      });

      // Consolidation fixed the category onto the fact, ready for the next
      // same-kind intent's dispatch-boundary recall.
      const decisionFacts = runtime.memoryStore!.facts(dataDomainId, dataDomainId)
        .filter(f => f.kind === 'decision');
      expect(decisionFacts).toHaveLength(1);
      expect(decisionFacts[0]!.subject).toBe('research');
      expect(decisionFacts[0]!.provenance).toContain(expectedEventId);

      // A replayed settle reaches the store as the byte-identical deterministic
      // event; append dedupes it, so no second event or fact ever appears.
      runtime.memoryStore!.append(decisionEvent!);
      await runtime.memoryStore!.consolidateDataDomain(dataDomainId);
      expect(runtime.memoryStore!.read(dataDomainId, dataDomainId)
        .filter(e => e.eventId === expectedEventId)).toHaveLength(1);
      expect(runtime.memoryStore!.facts(dataDomainId, dataDomainId)
        .filter(f => f.kind === 'decision')).toHaveLength(1);
    } finally {
      rmSync(dataDomainRoot, { recursive: true, force: true });
    }
  });
});

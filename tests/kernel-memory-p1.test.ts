import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootKernel } from '../src/state/boot.js';
import type { FetchLike } from '../src/registry/registry.js';
import type { AgentCard, Task } from '../src/a2a/types.js';
import type { MemoryEvent } from '../src/memory/types.js';

const CARD_URL = 'https://vassal.example/api/a2a/agent-card';
const TASK_URL = 'https://vassal.example/api/a2a/tasks';
const MEM_REALM = 'realm-A';

const card: AgentCard = {
  name: 'vassal-1',
  url: 'https://vassal.example',
  skills: [{ id: 'research', name: 'Research', description: 'researches', tags: [] }],
  'x-zeus-fealty': {
    version: '1', swornTo: 'zeus', domain: 'work', dataRealms: ['personal'],
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
    realmId: MEM_REALM,
    runId: 'obs-run-1',
    source: { agentId: 'agent-a' },
    kind: 'claim',
    content: { subject: 'Zeus', predicate: 'runs-on', object },
    refs: [],
    confidence: 0.8,
    occurredAt: '2026-09-22T10:00:00.000Z',
  };
}

describe('memory P1 kernel persistence', () => {
  it('persists events and facts in the kernel snapshot and restores them on restart', async () => {
    const stateFile = join(tmpdir(), `zeus-mem-${crypto.randomUUID()}.json`);
    const first = await bootKernel({ stateFile });
    first.memoryStore!.append(claim('node'));
    first.memoryStore!.consolidateRealm(MEM_REALM);
    await first.saveState();

    const restarted = await bootKernel({ stateFile });
    expect(restoredEvents(restarted)).toHaveLength(1);
    expect(restarted.memoryStore!.facts(MEM_REALM, MEM_REALM)).toHaveLength(1);
    expect(restarted.memoryStore!.replay(MEM_REALM, 'obs-run-1').facts).toHaveLength(1);
  });
});

describe('memory P1 auto-consolidation on intent completion', () => {
  it('consolidates the named realm when the intent reaches a terminal state', async () => {
    const kernel = await bootKernel({ vassalSeeds: [CARD_URL], fetchImpl });
    kernel.memoryStore!.append(claim('node'));

    const result = await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', realmId: MEM_REALM, params: {},
    });
    expect(result.status).toBe('completed');

    const facts = kernel.memoryStore!.facts(MEM_REALM, MEM_REALM);
    expect(facts).toHaveLength(1);
    expect(facts[0].status).toBe('active');
  });

  it('escalates disputes to the oversight desk and stays idempotent on re-consolidation', async () => {
    const kernel = await bootKernel({ vassalSeeds: [CARD_URL], fetchImpl });
    kernel.memoryStore!.append(claim('node', 'c1'));
    kernel.memoryStore!.append({ ...claim('bun', 'c2'), source: { agentId: 'agent-b' } });

    await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', realmId: MEM_REALM, params: {},
    });

    const disputes = kernel.oversight.list().filter(e => e.kind === 'memory-dispute');
    expect(disputes).toHaveLength(1);
    expect(disputes[0].status).toBe('pending');
    expect(disputes[0].factId).toBeDefined();

    // A later intent consolidates the same disputed facts; the deterministic
    // escalation id means no duplicate row is ingested.
    await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', realmId: MEM_REALM, params: {},
    });
    expect(kernel.oversight.list().filter(e => e.kind === 'memory-dispute')).toHaveLength(1);
  });

  it('records corrections when the driver settles a dispute, lowering future reliability', async () => {
    const kernel = await bootKernel({ vassalSeeds: [CARD_URL], fetchImpl });
    kernel.memoryStore!.append(claim('node', 'c1'));
    kernel.memoryStore!.append({ ...claim('bun', 'c2'), source: { agentId: 'agent-b' } });
    await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', realmId: MEM_REALM, params: {},
    });

    const dispute = kernel.oversight.list().find(e => e.kind === 'memory-dispute')!;
    // Reject the new fact ('bun', authored by agent-b): agent-b is corrected.
    await kernel.oversight.reject(dispute.id);

    const corrections = kernel.memoryStore!.listCorrections();
    expect(corrections.map(c => c.agentId)).toEqual(['agent-b']);
    expect(kernel.memoryStore!.reliabilityScore('agent-b', 0.5)).toBeCloseTo(0.35);
  });
});

function restoredEvents(kernel: Awaited<ReturnType<typeof bootKernel>>): MemoryEvent[] {
  return kernel.memoryStore!.read(MEM_REALM, MEM_REALM);
}

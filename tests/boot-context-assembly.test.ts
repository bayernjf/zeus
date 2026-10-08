import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
import type { ContextAppendixEntry } from '../src/context/assemble.js';

/**
 * S1 context engineering V1 (design-context-engineering §10.6, assembly tier):
 * in a booted kernel the memory appendix is assembled once per intent at the
 * dispatch boundary and travels the existing outbound channel, so a vassal
 * actually sees what context the kernel gave its branch. Cross-realm recall
 * stays impossible at the `searchRecall` signature; an unconfigured kernel
 * dispatches with zero appendix and zero audit events.
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
      dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'auto',
    },
  };
}

/** Captures every outbound tasks/send payload so the appendix can be asserted. */
function capturingFetch(): { fetchImpl: typeof fetch; sent: Array<{ name: string; skill?: unknown; params: Record<string, unknown> }> } {
  const sent: Array<{ name: string; skill?: unknown; params: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body)) as {
      method?: string;
      params?: {
        message?: { parts?: Array<{ kind?: string; data?: Record<string, unknown> }> };
      };
      id?: number;
    };
    const data = body.params?.message?.parts?.[0]?.data ?? {};
    const skill = data.skill;
    const params = data;
    sent.push({ name, skill, params });
    const taskId = `${name}-task`;
    const task = {
      kind: 'task',
      id: taskId,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
    };
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const SEED = 'http://127.0.0.1/loom/api/a2a/agent-card';

function claimEvent(id: string, subject: string, predicate: string, object: unknown) {
  return {
    eventId: id,
    realmId: 'personal',
    runId: 'seed-run',
    source: { agentId: 'seed' },
    kind: 'claim' as const,
    content: { subject, predicate, object },
    refs: [],
    confidence: 0.9,
    occurredAt: '2026-10-09T08:00:00.000Z',
  };
}

async function bootedWithMemory() {
  const { fetchImpl, sent } = capturingFetch();
  const audits: AuditEntry[] = [];
  const kernel = await bootKernel({
    fetchImpl,
    vassalSeeds: [SEED],
    dispatchAudit: entry => audits.push(entry),
  });
  kernel.memoryStore!.append(claimEvent('e1', 'user', 'prefers', 'typescript'));
  kernel.memoryStore!.append(claimEvent('e2', 'user', 'edits', 'vim'));
  kernel.memoryStore!.consolidateRealm('personal');
  return { kernel, sent, audits };
}

describe('S1 memory appendix in a booted kernel', () => {
  it('assembles recall into the outbound payload for every branch', async () => {
    const { kernel, sent } = await bootedWithMemory();
    const result = await kernel.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'please review my typescript setup' },
      realm: 'personal',
      realmId: 'personal',
      vassals: ['loom'],
    });
    expect(result.branches[0]?.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const appendix = sent[0]!.params.contextAppendix as ContextAppendixEntry[] | undefined;
    expect(appendix).toBeDefined();
    expect(appendix!.length).toBeGreaterThan(0);
    expect(appendix!.map(entry => entry.source)).toEqual(Array(appendix!.length).fill('memory-recall'));
    // The recall was scoped to the dispatch realm — every entry carries it.
    for (const entry of appendix!) expect(entry.realmId).toBe('personal');
    // The "typescript" query surfaced the matching claim first.
    expect(appendix![0]!.text).toContain('typescript');
  });

  it('audits the assembly on the same spine as dispatches', async () => {
    const { kernel, audits } = await bootedWithMemory();
    await kernel.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'please review my typescript setup' },
      realm: 'personal',
      realmId: 'personal',
      vassals: ['loom'],
    });
    const assembled = audits.filter(entry => entry.decision === 'context-assembled');
    expect(assembled).toHaveLength(1);
    expect(assembled[0]!.runId).toBeDefined();
    expect(assembled[0]!.detail).toContain('memory entries assembled');
  });

  it('dispatches with zero appendix and zero assembly audit when no realm is named', async () => {
    const { kernel, sent, audits } = await bootedWithMemory();
    const result = await kernel.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'review this' },
      realm: 'personal',
      vassals: ['loom'],
    });
    expect(result.branches[0]?.ok).toBe(true);
    expect(sent[0]!.params.contextAppendix).toBeUndefined();
    expect(audits.some(entry => entry.decision === 'context-assembled')).toBe(false);
  });

  it('keeps the explicit realm payload untouched and threads it with the appendix', async () => {
    const { kernel, sent } = await bootedWithMemory();
    await kernel.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'review my vim config', explicit: 'caller-owned' },
      realm: 'personal',
      realmId: 'personal',
      vassals: ['loom'],
    });
    expect(sent[0]!.params.explicit).toBe('caller-owned');
    expect(sent[0]!.params.contextAppendix).toBeDefined();
  });

  it('recalls nothing when memory has no matching facts but still dispatches', async () => {
    const { fetchImpl, sent } = capturingFetch();
    const kernel = await bootKernel({ fetchImpl, vassalSeeds: [SEED] });
    const result = await kernel.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'an empty realm' },
      realm: 'personal',
      realmId: 'personal',
      vassals: ['loom'],
    });
    expect(result.branches[0]?.ok).toBe(true);
    expect(sent[0]!.params.contextAppendix).toBeUndefined();
  });
});

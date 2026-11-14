import { describe, expect, it } from 'vitest';
import { bootRuntime } from '../src/state/boot.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
import type { ContextAppendixEntry } from '../src/context/assemble.js';

/**
 * S1 context engineering V1 (design-context-engineering §10.6, assembly tier):
 * in a booted runtime the memory appendix is assembled once per intent at the
 * dispatch boundary and travels the existing outbound channel, so a executor
 * actually sees what context the runtime gave its branch. Cross-dataDomain recall
 * stays impossible at the `searchRecall` signature; an unconfigured runtime
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
    skills: [
      // A2A card skills are protocol-shaped (id/name/description/tags only) —
      // input declarations live on the registered catalogue spec, which the
      // V2 cases inject explicitly via `runtime.skillRegistry.register`.
      { id: 'review', name: 'Review', description: '', tags: [] },
      // Advertised without any catalogue-level input declaration — the
      // degradation case for V2 assembly (a spec with no inputs assembles
      // nothing, like a spec that does not exist).
      { id: 'editor', name: 'Editor', description: '', tags: [] },
    ],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-handshake': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      dataDomains: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
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
    dataDomainId: 'personal',
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
  const runtime = await bootRuntime({
    fetchImpl,
    executorSeeds: [SEED],
    dispatchAudit: entry => audits.push(entry),
  });
  runtime.memoryStore!.append(claimEvent('e1', 'user', 'prefers', 'typescript'));
  runtime.memoryStore!.append(claimEvent('e2', 'user', 'edits', 'vim'));
  await runtime.memoryStore!.consolidateDataDomain('personal');
  return { runtime, sent, audits };
}

/** bootedWithMemory, plus a registered catalogue spec carrying an input shape. */
async function bootedWithInputs() {
  const booted = await bootedWithMemory();
  // Explicit catalogue spec: card advertising is protocol-shaped (no input
  // declarations); V2 input assembly reads the registered skill spec.
  booted.runtime.skillRegistry!.register({
    id: 'review',
    name: 'Review',
    description: '',
    version: '1.0.0',
    tags: [],
    inputs: { code: {}, language: {} },
    providedBy: ['loom'],
  });
  return booted;
}

describe('S1 memory appendix in a booted runtime', () => {
  it('assembles recall into the outbound payload for every branch', async () => {
    const { runtime, sent } = await bootedWithMemory();
    const result = await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'please review my typescript setup' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
    });
    expect(result.branches[0]?.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const appendix = sent[0]!.params.contextAppendix as ContextAppendixEntry[] | undefined;
    expect(appendix).toBeDefined();
    expect(appendix!.length).toBeGreaterThan(0);
    expect(appendix!.map(entry => entry.source)).toEqual(Array(appendix!.length).fill('memory-recall'));
    // The recall was scoped to the dispatch dataDomain — every entry carries it.
    for (const entry of appendix!) expect(entry.dataDomainId).toBe('personal');
    // The "typescript" query surfaced the matching claim first.
    expect(appendix![0]!.text).toContain('typescript');
  });

  it('audits the assembly on the same spine as dispatches', async () => {
    const { runtime, audits } = await bootedWithMemory();
    await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'please review my typescript setup' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
    });
    const assembled = audits.filter(entry => entry.decision === 'context-assembled');
    expect(assembled).toHaveLength(1);
    expect(assembled[0]!.runId).toBeDefined();
    expect(assembled[0]!.detail).toContain('memory entries assembled');
  });

  it('dispatches with zero appendix and zero assembly audit when no dataDomain is named', async () => {
    const { runtime, sent, audits } = await bootedWithMemory();
    const result = await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'review this' },
      dataDomain: 'personal',
      executors: ['loom'],
    });
    expect(result.branches[0]?.ok).toBe(true);
    expect(sent[0]!.params.contextAppendix).toBeUndefined();
    expect(audits.some(entry => entry.decision === 'context-assembled')).toBe(false);
  });

  it('keeps the explicit dataDomain payload untouched and threads it with the appendix', async () => {
    const { runtime, sent } = await bootedWithMemory();
    await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'review my vim config', explicit: 'caller-owned' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
    });
    expect(sent[0]!.params.explicit).toBe('caller-owned');
    expect(sent[0]!.params.contextAppendix).toBeDefined();
  });

  it('recalls nothing when memory has no matching facts but still dispatches', async () => {
    const { fetchImpl, sent } = capturingFetch();
    const runtime = await bootRuntime({ fetchImpl, executorSeeds: [SEED] });
    const result = await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'an empty dataDomain' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
    });
    expect(result.branches[0]?.ok).toBe(true);
    expect(sent[0]!.params.contextAppendix).toBeUndefined();
  });
});

describe('S1 V2 skill-input assembly in a booted runtime', () => {
  it('assembles declared inputs from the explicit payload into the outbound payload', async () => {
    const { runtime, sent } = await bootedWithInputs();
    await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'review src/orchestrator.ts', code: 'src/orchestrator.ts', language: 'typescript' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
    });
    const skillInputs = sent[0]!.params.skillInputs as Array<{ name: string; source: string }> | undefined;
    expect(skillInputs).toBeDefined();
    expect(skillInputs).toEqual([
      { name: 'code', source: 'explicit', value: 'src/orchestrator.ts', provenance: 'operator-supplied' },
      { name: 'language', source: 'explicit', value: 'typescript', provenance: 'operator-supplied' },
    ]);
  });

  it('marks a declared-but-unsupplied field unavailable in the payload and audits it', async () => {
    const { runtime, sent, audits } = await bootedWithInputs();
    await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'review this' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
    });
    const skillInputs = sent[0]!.params.skillInputs as Array<{ name: string; source: string }> | undefined;
    expect(skillInputs).toEqual([
      { name: 'code', source: 'unavailable' },
      { name: 'language', source: 'unavailable' },
    ]);
    const trimmed = audits.filter(entry => entry.decision === 'context-trimmed' && (entry.detail ?? '').includes('skill input field unavailable'));
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0]!.detail).toContain('unavailable');
  });

  it('assembles nothing for a skill whose catalogue spec declares no inputs', async () => {
    const { runtime, sent } = await bootedWithInputs();
    await runtime.orchestrator.fanOut({
      skill: 'editor',
      params: { message: 'edit this' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
    });
    expect(sent[0]!.params.skillInputs).toBeUndefined();
  });
});

function dataDomainHit(itemId: string) {
  return { itemId, tags: [], snippet: `snippet ${itemId}`, modifiedAt: '2026-10-09T00:00:00.000Z' };
}

describe('S1 V3 per-branch context budget in a booted runtime', () => {
  it('fills the budget with dataDomain hits first and drops the memory appendix, auditing the source', async () => {
    const cap = capturingFetch();
    const audits: AuditEntry[] = [];
    const runtime = await bootRuntime({
      fetchImpl: cap.fetchImpl,
      executorSeeds: [SEED],
      dispatchAudit: entry => audits.push(entry),
      contextOptions: { maxContextEntriesPerBranch: 3 },
    });
    runtime.memoryStore!.append(claimEvent('e1', 'user', 'prefers', 'typescript'));
    await runtime.memoryStore!.consolidateDataDomain('personal');
    await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'please review my typescript setup' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
      dataDomainHits: [dataDomainHit('r1'), dataDomainHit('r2'), dataDomainHit('r3')],
      dataDomainHitsOrigin: 'runtime-resolved',
    });
    const outbound = cap.sent[0]!.params;
    expect((outbound.dataDomainHits as unknown[])).toHaveLength(3);
    // Memory recall ranks below dataDomain hits; the budget left no slot for it.
    expect(outbound.contextAppendix).toBeUndefined();
    const exceeded = audits.filter(
      entry => entry.decision === 'context-budget-exceeded' && (entry.detail ?? '').includes('branch context budget'),
    );
    expect(exceeded.some(entry => (entry.detail ?? '').includes('memory'))).toBe(true);
  });

  it('truncates dataDomain hits to the remaining slots and drops memory under a tighter budget', async () => {
    const cap = capturingFetch();
    const audits: AuditEntry[] = [];
    const runtime = await bootRuntime({
      fetchImpl: cap.fetchImpl,
      executorSeeds: [SEED],
      dispatchAudit: entry => audits.push(entry),
      contextOptions: { maxContextEntriesPerBranch: 2 },
    });
    runtime.memoryStore!.append(claimEvent('e1', 'user', 'prefers', 'typescript'));
    await runtime.memoryStore!.consolidateDataDomain('personal');
    await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'please review my typescript setup' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
      dataDomainHits: [dataDomainHit('r1'), dataDomainHit('r2'), dataDomainHit('r3'), dataDomainHit('r4'), dataDomainHit('r5')],
      dataDomainHitsOrigin: 'runtime-resolved',
    });
    const outbound = cap.sent[0]!.params;
    expect((outbound.dataDomainHits as Array<{ itemId: string }>).map(h => h.itemId)).toEqual(['r1', 'r2']);
    expect(outbound.contextAppendix).toBeUndefined();
    const detail = audits.map(entry => entry.detail ?? '').join('\n');
    expect(detail).toContain('dataDomain truncated');
    expect(detail).toContain('memory truncated');
  });

  it('keeps dataDomain hits and the appendix untouched under the default structural-guard budget', async () => {
    const { runtime, sent } = await bootedWithMemory();
    await runtime.orchestrator.fanOut({
      skill: 'review',
      params: { message: 'please review my typescript setup' },
      dataDomain: 'personal',
      dataDomainId: 'personal',
      executors: ['loom'],
      dataDomainHits: [dataDomainHit('r1'), dataDomainHit('r2'), dataDomainHit('r3')],
      dataDomainHitsOrigin: 'runtime-resolved',
    });
    const outbound = sent[0]!.params;
    expect((outbound.dataDomainHits as unknown[])).toHaveLength(3);
    expect(outbound.contextAppendix).toBeDefined();
  });
});

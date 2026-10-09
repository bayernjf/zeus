import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import type { ProgressEvent } from '../src/orchestrator/progress.js';

/**
 * S15 V2 (design-streaming §5): in a booted kernel a working frame carrying an
 * incremental payload surfaces as a `branch-delta` progress event (preview-only,
 * never a conclusion), and each settled branch reports the partially-ready
 * count. An execution agent that does not stream increments keeps the historical
 * one-shot-at-settlement behavior — no delta, no new event type.
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

/**
 * A two-vassal fixture: alpha streams incremental working frames, beta does not
 * (the compatibility case). Working frames carry an optional `data` payload
 * whose string form is surfaced as the preview.
 */
function streamingFetch(): { fetchImpl: typeof fetch; streamed: string[] } {
  const streamed: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body)) as { params?: { message?: { parts?: unknown[] } } };
    const taskId = `${name}-task`;
    const frames: string[] = [];
    if (name === 'alpha') {
      // Two increments plus the final snapshot.
      frames.push(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working', data: 'drafting…' }, final: false } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working', data: { preview: 'weighing options…' } }, final: false } })}\n\n`,
      );
    }
    const task = {
      kind: 'task',
      id: taskId,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
    };
    frames.push(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: task })}\n\n`);
    void body;
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, streamed };
}

const ALPHA_SEED = 'http://127.0.0.1/alpha/api/a2a/agent-card';
const BETA_SEED = 'http://127.0.0.1/beta/api/a2a/agent-card';

describe('S15 V2 working-frame increments in a booted kernel', () => {
  it('publishes branch-delta previews and keeps them out of the settled result', async () => {
    const { fetchImpl } = streamingFetch();
    const kernel = await bootKernel({ fetchImpl, vassalSeeds: [ALPHA_SEED, BETA_SEED] });
    const events: ProgressEvent[] = [];
    kernel.progressHub.subscribe('intent-1', event => events.push(event));

    const result = await kernel.orchestrator.fanOut({
      intentId: 'intent-1',
      skill: 'review',
      params: { message: 'review this' },
      realm: 'personal',
      vassals: ['alpha', 'beta'],
    });

    // Alpha streamed two increments; beta none.
    const deltas = events.filter(e => e.type === 'branch-delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.map(d => (d.type === 'branch-delta' ? d.vassal : ''))).toEqual(['alpha', 'alpha']);
    expect(deltas.map(d => (d.type === 'branch-delta' ? d.seq : 0))).toEqual([1, 2]);
    // String payload and { preview } payload both surface; a seq-less frame's
    // preview is the increment's own content.
    expect(deltas[0]!.type === 'branch-delta' && deltas[0]!.preview).toBe('drafting…');
    expect(deltas[1]!.type === 'branch-delta' && deltas[1]!.preview).toBe('weighing options…');
    // The branch lineage is attached (client sees no vassal; the dispatcher adds it).
    for (const d of deltas) {
      expect(d.type === 'branch-delta' && d.runId).toContain('alpha');
    }

    // Previews never reach a conclusion: the aggregated decision, the position
    // map and the artifacts consumed by aggregation are composed only from
    // final tasks. The branch's `events`/`stream` rows keep the raw inbound
    // frames (the existing dispatch record), but no decision path reads them.
    expect(JSON.stringify(result.decision)).not.toContain('drafting…');
    expect(JSON.stringify(result.decision)).not.toContain('weighing options…');
    expect(JSON.stringify(result.positions)).not.toContain('drafting…');
    expect(result.branches.every(b => b.ok)).toBe(true);
    // The majority conclusion comes from the final artifacts — alpha's two
    // working previews changed nothing in the verdict.
    expect(result.decision.conclusion).toBe('approve');
    expect(result.decision.margin).toEqual({ winner: 'approve', winnerCount: 2, total: 2 });
  });

  it('reports the partially-ready count as branches settle', async () => {
    const { fetchImpl } = streamingFetch();
    const kernel = await bootKernel({ fetchImpl, vassalSeeds: [ALPHA_SEED, BETA_SEED] });
    const partials: Array<{ settledCount: number; totalCount: number }> = [];
    kernel.progressHub.subscribe('intent-2', event => {
      if (event.type === 'intent-partial') {
        partials.push({ settledCount: event.settledCount, totalCount: event.totalCount });
      }
    });

    await kernel.orchestrator.fanOut({
      intentId: 'intent-2',
      skill: 'review',
      params: { message: 'review this' },
      realm: 'personal',
      vassals: ['alpha', 'beta'],
    });

    // Two branches, two settlement reports; the total is exact, the count climbs.
    expect(partials).toHaveLength(2);
    expect(partials.map(p => p.totalCount)).toEqual([2, 2]);
    expect(partials.map(p => p.settledCount).sort()).toEqual([1, 2]);
  });

  it('keeps agents without increments on the one-shot-at-settlement path', async () => {
    const { fetchImpl } = streamingFetch();
    const kernel = await bootKernel({ fetchImpl, vassalSeeds: [BETA_SEED] });
    const deltas: string[] = [];
    kernel.progressHub.subscribe('intent-3', event => {
      if (event.type === 'branch-delta') deltas.push(event.preview);
    });

    await kernel.orchestrator.fanOut({
      intentId: 'intent-3',
      skill: 'review',
      params: { message: 'review this' },
      realm: 'personal',
      vassals: ['beta'],
    });

    expect(deltas).toHaveLength(0);
  });
});

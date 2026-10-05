import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * design-self-host-loop §7 step 3, proved where the boundary actually lives: a
 * watch reading a connector must go through the declaration's permission
 * boundary and the outbound guards, so a tool the declaration never granted is
 * unreadable rather than empty. The healthy-upstream case is the positive
 * control — "a jittering connector does not fire" is trivially satisfied by an
 * implementation that never fires at all.
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

function vassalFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const taskId = `${name}-task`;
    const task = {
      kind: 'task',
      id: taskId,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
    };
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

/** A minimal MCP endpoint: advertises two tools, returns a reading for one. */
function mcpFetch(options: { failCall?: boolean } = {}): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    const json = (value: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (options.failCall && body.method === 'tools/call') return new Response('boom', { status: 500 });
    switch (body.method) {
      case 'initialize':
        return json({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kb' } });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return json({ tools: [{ name: 'search' }, { name: 'danger' }] });
      case 'tools/call':
        return json({ queue: { depth: 7 } });
      default:
        return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
}

const seeds = ['http://127.0.0.1/loom/api/a2a/agent-card'];
const NOW = new Date('2026-10-05T12:00:00.000Z');

/** One injected transport for both surfaces, so the watch's connector call runs
 *  on exactly the transport the kernel was assembled with. */
function combinedFetch(mcp: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('mcp.example')) return mcp(input, init);
    return vassalFetch()(input, init);
  }) as typeof fetch;
}

async function booted(options: { failCall?: boolean } = {}) {
  const audits: AuditEntry[] = [];
  const kernel = await bootKernel({
    fetchImpl: combinedFetch(mcpFetch({ ...(options.failCall ? { failCall: true } : {}) })),
    vassalSeeds: seeds,
    dispatchAudit: entry => audits.push(entry),
  });
  return { kernel, audits };
}

function watchInput(tool: string, permissions: string[]) {
  return {
    id: 'wc',
    owner: 'operator@bayjf',
    realm: 'personal' as const,
    predicate: { source: 'connector' as const, op: 'above' as const, field: 'queue.depth', value: 2 },
    connector: { id: 'knowledge', tool },
    intent: { skill: 'review', subject: 'upstream queue is deep', mode: 'plan' as const, maxFanOut: 1 },
    intervalSeconds: 60,
    startsAt: '2026-10-05T11:00:00.000Z',
    expiresAt: '2026-10-05T13:00:00.000Z',
    budget: { fires: 1, executes: 0 },
    permissions,
  };
}

describe('a watch reading a connector (step 3)', () => {
  it('fires when the declared tool returns a matching reading', async () => {
    const { kernel, audits } = await booted();
    kernel.connectorRegistry!.declare({
      id: 'knowledge', name: 'KB', endpoint: 'https://mcp.example/mcp', permissions: ['mcp'],
    });
    await kernel.connectorRegistry!.connect('knowledge', mcpFetch());
    kernel.watches!.register(watchInput('search', ['mcp']));

    const report = await kernel.runWatchTick(NOW);
    expect(report.fired).toEqual(['wc']);
    expect(kernel.orchestrator.getIntent('watch:wc:1')?.branches.map(branch => branch.vassal)).toEqual(['loom']);
    expect(audits.some(entry => entry.decision === 'watch-fired')).toBe(true);
  });

  it('is unreadable, and does not fire, for a tool the declaration never granted', async () => {
    const { kernel, audits } = await booted();
    kernel.connectorRegistry!.declare({
      id: 'knowledge', name: 'KB', endpoint: 'https://mcp.example/mcp', permissions: ['mcp:search'],
    });
    await kernel.connectorRegistry!.connect('knowledge', mcpFetch());
    // 'danger' is advertised upstream but the boundary removed it.
    kernel.watches!.register(watchInput('danger', ['mcp:search']));

    const report = await kernel.runWatchTick(NOW);
    expect(report.unavailable).toEqual(['wc']);
    expect(report.fired).toEqual([]);
    expect(kernel.orchestrator.getIntent('watch:wc:1')).toBeUndefined();
    expect(audits.some(entry => entry.decision === 'watch-eval-unavailable')).toBe(true);
  });

  it('reports a failing upstream as unavailable instead of a false condition', async () => {
    // Connected against a healthy server; the tool call itself then fails.
    const { kernel } = await booted({ failCall: true });
    kernel.connectorRegistry!.declare({
      id: 'knowledge', name: 'KB', endpoint: 'https://mcp.example/mcp', permissions: ['mcp'],
    });
    // Connected against a healthy server: only the tool call fails, at tick time.
    await kernel.connectorRegistry!.connect('knowledge', mcpFetch());
    kernel.watches!.register(watchInput('search', ['mcp']));

    const report = await kernel.runWatchTick(NOW);
    expect(report.unavailable).toEqual(['wc']);
    expect(report.fired).toEqual([]);
  });
});

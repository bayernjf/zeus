import { describe, expect, it } from 'vitest';
import { bootKernel, resolveCostConfig } from '../src/state/boot.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * S9 V2 (design-cost-governance §5): the intent-level cost gate wires the pure
 * ledger into the dispatch boundary — every fan-out is admitted before any
 * branch dispatches, a refusal settles as failed with the cost reason and
 * lands on the audit spine (cost-budget-exceeded / cost-rate-circuit-open),
 * and a settled intent releases its in-flight estimate.
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

function approveFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
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

const SEED = 'http://127.0.0.1/alpha/api/a2a/agent-card';

describe('S9 V2 cost gate wiring', () => {
  it('refuses an intent whose own estimate crosses the window cap and audits it', async () => {
    const audits: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: approveFetch(),
      vassalSeeds: [SEED],
      costLimit: { maxWindowCost: 3, circuitWindowMs: 60_000 },
      dispatchAudit: e => audits.push(e),
    });
    const cheap = await kernel.orchestrator.fanOut({
      intentId: 'cheap', skill: 'review', params: { message: 'x' }, realm: 'personal', vassals: ['alpha'],
      costEstimate: { tokens: 2 },
    });
    expect(cheap.status).toBe('completed');
    const overBudget = await kernel.orchestrator.fanOut({
      intentId: 'over-budget', skill: 'review', params: { message: 'y' }, realm: 'personal', vassals: ['alpha'],
      costEstimate: { tokens: 5 },
    });
    expect(overBudget.status).toBe('failed');
    expect(overBudget.refused?.reason).toBe('cost-budget-exceeded');
    expect(audits.some(e => e.decision === 'cost-budget-exceeded' && e.detail?.includes('over-budget'))).toBe(true);
  });

  it('keeps intent ledgers independent (per-intent window cap)', async () => {
    const audits: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: approveFetch(),
      vassalSeeds: [SEED],
      costLimit: { maxWindowCost: 3, circuitWindowMs: 60_000 },
      dispatchAudit: e => audits.push(e),
    });
    // Each intent is charged against its own ledger, so two intents can each
    // sit under the per-intent cap without cross-charging (realm-period
    // accounting is V3).
    const first = await kernel.orchestrator.fanOut({
      intentId: 'settled-a', skill: 'review', params: { message: 'x' }, realm: 'personal', vassals: ['alpha'],
      costEstimate: { tokens: 2 },
    });
    expect(first.status).toBe('completed');
    const second = await kernel.orchestrator.fanOut({
      intentId: 'settled-b', skill: 'review', params: { message: 'y' }, realm: 'personal', vassals: ['alpha'],
      costEstimate: { tokens: 2 },
    });
    expect(second.status).toBe('completed');
    expect(audits.some(e => e.decision === 'cost-budget-exceeded')).toBe(false);
  });

  it('leaves an unconfigured kernel on its historical uncharged path', async () => {
    const kernel = await bootKernel({ fetchImpl: approveFetch(), vassalSeeds: [SEED] });
    const result = await kernel.orchestrator.fanOut({
      intentId: 'uncharged', skill: 'review', params: { message: 'x' }, realm: 'personal', vassals: ['alpha'],
    });
    expect(result.status).toBe('completed');
  });

  it('resolves the env shape loudly and strictly', () => {
    expect(resolveCostConfig({ ZEUS_COST_MAX_WINDOW_COST: '100' })).toEqual({ maxWindowCost: 100 });
    expect(resolveCostConfig({ ZEUS_COST_WINDOW_MS: '30000' }).circuitWindowMs).toBe(30_000);
    expect(() => resolveCostConfig({ ZEUS_COST_MAX_WINDOW_COST: 'abc' })).toThrow(/whole number/);
    expect(() => resolveCostConfig({ ZEUS_COST_MAX_RATE_PER_WINDOW: '0' })).toThrow(/>= 1/);
    expect(resolveCostConfig({})).toEqual({});
  });
});

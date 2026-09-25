import { describe, expect, it } from 'vitest';
import { VassalRegistry, type FetchLike } from '../src/registry/registry.js';
import { projectInternalRoster, projectPublicRoster } from '../src/registry/roster.js';
import { bootKernel, resolveVassalSeedsConfig, KernelBootError } from '../src/state/boot.js';
import type { AgentCard } from '../src/a2a/types.js';

const CARD_URL = 'http://127.0.0.1/token-vassal/api/a2a/agent-card';
const VASSAL_NAME = 'token-vassal';
const SECRET = 'vassal-secret-token';

function cardFor(name = VASSAL_NAME): AgentCard {
  return {
    name,
    url: `http://127.0.0.1/${name}`,
    skills: [{ id: 'research', name: 'Research', description: '', tags: [] }],
    'x-zeus-fealty': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'auto',
    },
  };
}

function fetchForCard(): FetchLike {
  return async () =>
    new Response(JSON.stringify(cardFor()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

const serialized = (value: unknown): string => JSON.stringify(value);

describe('E4.8 vassal token storage and non-echo', () => {
  it('stores the seeded token for the dispatcher but never echoes it through public accessors or rosters', async () => {
    const registry = new VassalRegistry(fetchForCard());
    await registry.register(CARD_URL, { token: SECRET });

    expect(registry.tokenFor(VASSAL_NAME)).toBe(SECRET);
    for (const view of [registry.get(VASSAL_NAME)!, ...registry.list(), ...registry.listAll()]) {
      expect(view).not.toHaveProperty('token');
      expect(serialized(view)).not.toContain(SECRET);
    }
    for (const snapshot of [
      projectInternalRoster(registry.listAll()),
      projectPublicRoster(registry.listAll()),
    ]) {
      expect(serialized(snapshot)).not.toContain(SECRET);
    }
  });

  it('yields undefined when the vassal registered without a token', async () => {
    const registry = new VassalRegistry(fetchForCard());
    await registry.register(CARD_URL);
    expect(registry.tokenFor(VASSAL_NAME)).toBeUndefined();
    expect(registry.tokenFor('unknown-vassal')).toBeUndefined();
  });

  it('revocation cuts off token issuance immediately', async () => {
    const registry = new VassalRegistry(fetchForCard());
    await registry.register(CARD_URL, { token: SECRET });
    expect(registry.tokenFor(VASSAL_NAME)).toBe(SECRET);
    expect(registry.revoke(VASSAL_NAME)).toBe(true);
    expect(registry.tokenFor(VASSAL_NAME)).toBeUndefined();
  });

  it('the token survives export/import (restart) yet still never echoes', async () => {
    const first = new VassalRegistry(fetchForCard());
    await first.register(CARD_URL, { token: SECRET });
    const exported = first.exportState();
    expect(exported[0].token).toBe(SECRET);

    const second = new VassalRegistry(fetchForCard());
    second.importState(exported);
    expect(second.tokenFor(VASSAL_NAME)).toBe(SECRET);
    expect(second.listAll().every(view => !('token' in view))).toBe(true);
    expect(serialized(second.listAll())).not.toContain(SECRET);
  });
});

describe('resolveVassalSeedsConfig (ZEUS_VASSAL_SEEDS parsing)', () => {
  it('parses plain URLs and url|token entries', () => {
    const config = resolveVassalSeedsConfig({
      ZEUS_VASSAL_SEEDS: '  http://a/card,  http://b/card|tok-1  ',
    });
    expect(config).toEqual([
      'http://a/card',
      { cardUrl: 'http://b/card', token: 'tok-1' },
    ]);
  });

  it('fails loud on an empty token or an empty card URL', () => {
    expect(() => resolveVassalSeedsConfig({ ZEUS_VASSAL_SEEDS: 'http://a/card|' })).toThrow(KernelBootError);
    expect(() => resolveVassalSeedsConfig({ ZEUS_VASSAL_SEEDS: 'http://a/card|' })).toThrow(/empty token/);
    expect(() => resolveVassalSeedsConfig({ ZEUS_VASSAL_SEEDS: '|tok' })).toThrow(/empty card URL/);
  });
});

describe('E4.8 boot wiring: dispatcher attaches the seeded bearer on fan-out', () => {
  it('sends Authorization for a vassal seeded with a token', async () => {
    const seenAuth: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/a2a/agent-card')) {
        return new Response(JSON.stringify(cardFor()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? '(none)');
      const task = {
        kind: 'task',
        id: `${VASSAL_NAME}-task`,
        contextId: 'ctx',
        status: { state: 'completed' },
        artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
      };
      const frames = [
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: `${VASSAL_NAME}-task`, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
      ];
      return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    const kernel = await bootKernel({
      fetchImpl,
      vassalSeeds: [{ cardUrl: CARD_URL, token: SECRET }],
    });
    const result = await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('completed');
    expect(seenAuth).toContain(`Bearer ${SECRET}`);
  });

  it('sends no Authorization for a plain URL seed', async () => {
    const seenAuth: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/a2a/agent-card')) {
        return new Response(JSON.stringify(cardFor()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? '(none)');
      const task = {
        kind: 'task',
        id: `${VASSAL_NAME}-task`,
        contextId: 'ctx',
        status: { state: 'completed' },
        artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
      };
      const frames = [
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: `${VASSAL_NAME}-task`, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
      ];
      return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    const kernel = await bootKernel({
      fetchImpl,
      vassalSeeds: [CARD_URL],
    });
    const result = await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('completed');
    expect(seenAuth).toContain('(none)');
    expect(seenAuth.every(auth => auth === '(none)')).toBe(true);
  });
});

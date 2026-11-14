import { describe, expect, it } from 'vitest';
import { ExecutorRegistry, type FetchLike } from '../src/registry/registry.js';
import { projectInternalRoster, projectPublicRoster } from '../src/registry/roster.js';
import { bootRuntime, resolveExecutorSeedsConfig, RuntimeBootError } from '../src/state/boot.js';
import type { AgentCard } from '../src/a2a/types.js';

const CARD_URL = 'http://127.0.0.1/token-executor/api/a2a/agent-card';
const EXECUTOR_NAME = 'token-executor';
const SECRET = 'executor-secret-token';

function cardFor(name = EXECUTOR_NAME): AgentCard {
  return {
    name,
    url: `http://127.0.0.1/${name}`,
    skills: [{ id: 'research', name: 'Research', description: '', tags: [] }],
    'x-zeus-handshake': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      realms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
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

describe('E4.8 executor token storage and non-echo', () => {
  it('stores the seeded token for the dispatcher but never echoes it through public accessors or rosters', async () => {
    const registry = new ExecutorRegistry(fetchForCard());
    await registry.register(CARD_URL, { token: SECRET });

    expect(registry.tokenFor(EXECUTOR_NAME)).toBe(SECRET);
    for (const view of [registry.get(EXECUTOR_NAME)!, ...registry.list(), ...registry.listAll()]) {
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

  it('yields undefined when the executor registered without a token', async () => {
    const registry = new ExecutorRegistry(fetchForCard());
    await registry.register(CARD_URL);
    expect(registry.tokenFor(EXECUTOR_NAME)).toBeUndefined();
    expect(registry.tokenFor('unknown-executor')).toBeUndefined();
  });

  it('revocation cuts off token issuance immediately', async () => {
    const registry = new ExecutorRegistry(fetchForCard());
    await registry.register(CARD_URL, { token: SECRET });
    expect(registry.tokenFor(EXECUTOR_NAME)).toBe(SECRET);
    expect(registry.revoke(EXECUTOR_NAME)).toBe(true);
    expect(registry.tokenFor(EXECUTOR_NAME)).toBeUndefined();
  });

  it('the token survives export/import (restart) yet still never echoes', async () => {
    const first = new ExecutorRegistry(fetchForCard());
    await first.register(CARD_URL, { token: SECRET });
    const exported = first.exportState();
    expect(exported[0]!.token).toBe(SECRET);

    const second = new ExecutorRegistry(fetchForCard());
    second.importState(exported);
    expect(second.tokenFor(EXECUTOR_NAME)).toBe(SECRET);
    expect(second.listAll().every(view => !('token' in view))).toBe(true);
    expect(serialized(second.listAll())).not.toContain(SECRET);
  });
});

describe('resolveExecutorSeedsConfig (ZEUS_EXECUTOR_SEEDS parsing)', () => {
  it('parses plain URLs and url|token entries', () => {
    const config = resolveExecutorSeedsConfig({
      ZEUS_EXECUTOR_SEEDS: '  http://a/card,  http://b/card|tok-1  ',
    });
    expect(config).toEqual([
      'http://a/card',
      { cardUrl: 'http://b/card', token: 'tok-1' },
    ]);
  });

  it('fails loud on an empty token or an empty card URL', () => {
    expect(() => resolveExecutorSeedsConfig({ ZEUS_EXECUTOR_SEEDS: 'http://a/card|' })).toThrow(RuntimeBootError);
    expect(() => resolveExecutorSeedsConfig({ ZEUS_EXECUTOR_SEEDS: 'http://a/card|' })).toThrow(/empty token/);
    expect(() => resolveExecutorSeedsConfig({ ZEUS_EXECUTOR_SEEDS: '|tok' })).toThrow(/empty card URL/);
  });

  it('never echoes the seed token or embedded URL credentials in parse errors', () => {
    // The token half of a malformed entry must never reach the error message:
    // boot refuses log that message straight to stderr.
    const emptyCard = () => resolveExecutorSeedsConfig({ ZEUS_EXECUTOR_SEEDS: '|seeded-token-value' });
    expect(emptyCard).toThrow(/empty card URL/);
    expect(tryMessage(emptyCard)).not.toContain('seeded-token-value');

    const emptyToken = () =>
      resolveExecutorSeedsConfig({ ZEUS_EXECUTOR_SEEDS: 'http://ops:hunter2@host.example/card|' });
    expect(emptyToken).toThrow(/empty token/);
    const message = tryMessage(emptyToken);
    expect(message).not.toContain('hunter2');
    // the URL body stays so the operator can still see which entry failed
    expect(message).toContain('host.example/card');
  });
});

function tryMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected fn to throw');
}

describe('E4.8 boot wiring: dispatcher attaches the seeded bearer on fan-out', () => {
  it('sends Authorization for a executor seeded with a token', async () => {
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
        id: `${EXECUTOR_NAME}-task`,
        contextId: 'ctx',
        status: { state: 'completed' },
        artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
      };
      const frames = [
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: `${EXECUTOR_NAME}-task`, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
      ];
      return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    const runtime = await bootRuntime({
      fetchImpl,
      executorSeeds: [{ cardUrl: CARD_URL, token: SECRET }],
    });
    const result = await runtime.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
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
        id: `${EXECUTOR_NAME}-task`,
        contextId: 'ctx',
        status: { state: 'completed' },
        artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
      };
      const frames = [
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: `${EXECUTOR_NAME}-task`, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
      ];
      return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    const runtime = await bootRuntime({
      fetchImpl,
      executorSeeds: [CARD_URL],
    });
    const result = await runtime.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('completed');
    expect(seenAuth).toContain('(none)');
    expect(seenAuth.every(auth => auth === '(none)')).toBe(true);
  });
});

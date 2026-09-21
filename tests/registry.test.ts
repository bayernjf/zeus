import { describe, expect, it } from 'vitest';
import { VassalRegistry, defaultTaskUrl } from '../src/registry/registry.js';
import type { AgentCard } from '../src/a2a/types.js';

function cardResponse(card: unknown, status = 200): Response {
  return new Response(JSON.stringify(card), { status, headers: { 'Content-Type': 'application/json' } });
}

function prHelperCard(overrides: Record<string, unknown> = {}): AgentCard {
  return {
    name: 'pr-helper',
    url: 'http://vassal.internal/api/a2a/agent-card',
    skills: [{ id: 'create-pr', name: 'Create pull request', description: '', tags: [] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'pr-release-control',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
    },
    ...overrides,
  } as AgentCard;
}

describe('VassalRegistry', () => {
  it('registers a vassal from its card URL and derives the task endpoint', async () => {
    const fetches: string[] = [];
    const registry = new VassalRegistry(async url => {
      fetches.push(url);
      return cardResponse(prHelperCard());
    });
    const entry = await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(fetches).toEqual(['http://vassal.internal/api/a2a/agent-card']);
    expect(entry.card.name).toBe('pr-helper');
    expect(entry.taskUrl).toBe('http://vassal.internal/api/a2a/tasks');
    expect(entry.fealty.swornTo).toBe('zeus');
    expect(registry.get('pr-helper')?.fealty.domain).toBe('pr-release-control');
  });

  it('rejects cards without a zeus fealty (guest agents are not vassals)', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard({ 'x-zeus-fealty': undefined })));
    await expect(registry.register('http://guest/api/a2a/agent-card')).rejects.toThrow(/no vassal fealty/);
  });

  it('refuses an unsupported fealty.version instead of silently accepting it (§4.5 version negotiation)', async () => {
    const futureFealty = {
      version: '999',
      swornTo: 'zeus',
      domain: 'pr-release-control',
      dataRealms: [],
      dataPolicy: 'none' as const,
      reportBack: true,
      escalationPolicy: 'none' as const,
    };
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard({ 'x-zeus-fealty': futureFealty })));
    await expect(registry.register('http://future/api/a2a/agent-card')).rejects.toThrow(/unsupported fealty\.version '999'/);
  });

  it('accepts the full standard A2A card shape that loom and pr-helper serve', async () => {
    const fullCard = {
      ...prHelperCard(),
      version: '0.1.0',
      provider: { organization: 'bayjf', url: 'https://example.com' },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      authentication: { schemes: ['bearer'] },
      preferredTransport: 'JSONRPC',
    };
    const registry = new VassalRegistry(async () => cardResponse(fullCard));
    const entry = await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(entry.card.provider?.organization).toBe('bayjf');
    expect(entry.card.defaultInputModes).toEqual(['application/json']);
    expect(entry.card.defaultOutputModes).toEqual(['application/json']);
    expect(entry.card.preferredTransport).toBe('JSONRPC');
  });

  it('rejects malformed cards and non-200 responses', async () => {
    const registry = new VassalRegistry(async () => cardResponse({ name: 'x' }));
    await expect(registry.register('http://bad/api/a2a/agent-card')).rejects.toThrow(/invalid agent card/);
    const down = new VassalRegistry(async () => new Response('nope', { status: 503 }));
    await expect(down.register('http://down/api/a2a/agent-card')).rejects.toThrow(/card fetch failed/);
  });

  it('revokes a vassal so lookups and skill routing stop matching', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard()));
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(registry.revoke('pr-helper')).toBe(true);
    expect(registry.get('pr-helper')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
    expect(registry.findVassalsForSkill('create-pr')).toHaveLength(0);
    expect(registry.revoke('pr-helper')).toBe(false);
  });

  it('exposes a live dispatcher lookup and fires onRevoke exactly once', async () => {
    const revokeEvents: Array<{ name: string; at: string }> = [];
    const registry = new VassalRegistry(
      async () => cardResponse(prHelperCard()),
      () => new Date('2026-09-21T10:00:00.000Z'),
      { onRevoke: (name, at) => revokeEvents.push({ name, at }) }
    );
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    const lookup = registry.asVassalLookup();

    expect(lookup.statusOf('pr-helper')).toBe('active');
    expect(lookup.statusOf('ghost')).toBe('unknown');
    expect(lookup.get('pr-helper')).toMatchObject({ name: 'pr-helper', taskUrl: 'http://vassal.internal/api/a2a/tasks' });
    expect(lookup.findBySkill('create-pr').map(v => v.name)).toEqual(['pr-helper']);

    expect(registry.revoke('pr-helper')).toBe(true);
    expect(revokeEvents).toEqual([{ name: 'pr-helper', at: '2026-09-21T10:00:00.000Z' }]);
    // repeat revoke is a no-op and must not double-emit the governance event
    expect(registry.revoke('pr-helper')).toBe(false);
    expect(revokeEvents).toHaveLength(1);

    // the same lookup object reflects the revoke live, no rewiring needed
    expect(lookup.statusOf('pr-helper')).toBe('revoked');
    expect(lookup.get('pr-helper')).toBeUndefined();
    expect(lookup.findBySkill('create-pr')).toHaveLength(0);
  });

  it('listAll keeps revoked vassals with an explicit status for the oversight deck', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard()));
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.listAll()[0].status).toBe('active');
    registry.revoke('pr-helper');
    const all = registry.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('revoked');
    expect(all[0].card.name).toBe('pr-helper');
    // routing-facing list still hides it
    expect(registry.list()).toHaveLength(0);
  });

  it('finds vassals by skill and by domain', async () => {
    const registry = new VassalRegistry(async url =>
      cardResponse(
        url.includes('loom')
          ? prHelperCard({ name: 'loom', 'x-zeus-fealty': { version: '1', swornTo: 'zeus', domain: 'content-production', dataRealms: ['personal'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' }, skills: [{ id: 'generate-content', name: '', description: '', tags: [] }] })
          : prHelperCard()
      )
    );
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    await registry.register('http://loom.internal/api/a2a/agent-card');
    expect(registry.findVassalsForSkill('create-pr').map(entry => entry.card.name)).toEqual(['pr-helper']);
    expect(registry.findVassalsForDomain('content-production').map(entry => entry.card.name)).toEqual(['loom']);
  });

  it('records health check outcomes', async () => {
    let up = true;
    const registry = new VassalRegistry(async () => (up ? cardResponse(prHelperCard()) : Promise.reject(new Error('connection refused'))));
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(await registry.healthCheck('pr-helper')).toBe(true);
    up = false;
    expect(await registry.healthCheck('pr-helper')).toBe(false);
    expect(registry.get('pr-helper')?.lastHealthCheck?.detail).toBe('connection refused');
  });
});

describe('defaultTaskUrl', () => {
  it('maps card endpoints and well-known paths to the tasks endpoint', () => {
    expect(defaultTaskUrl('http://x/api/a2a/agent-card')).toBe('http://x/api/a2a/tasks');
    expect(defaultTaskUrl('http://x/.well-known/agent-card.json')).toBe('http://x/api/a2a/tasks');
    expect(defaultTaskUrl('http://x/.well-known/agent.json')).toBe('http://x/api/a2a/tasks');
  });
});

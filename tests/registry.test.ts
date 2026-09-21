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

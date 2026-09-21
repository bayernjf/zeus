import { describe, expect, it } from 'vitest';
import { VassalRegistry } from '../src/registry/registry.js';
import { projectInternalRoster, projectPublicRoster, type RosterEntry } from '../src/registry/roster.js';
import type { AgentCard } from '../src/a2a/types.js';
import type { VassalEntry } from '../src/registry/registry.js';

function entry(overrides: Partial<VassalEntry> & Pick<VassalEntry, 'card' | 'fealty'>): VassalEntry & { status: 'active' | 'revoked' } {
  return {
    cardUrl: 'http://x/api/a2a/agent-card',
    taskUrl: 'http://x/api/a2a/tasks',
    registeredAt: '2026-09-21T09:00:00.000Z',
    revoked: false,
    ...overrides,
    status: overrides.revoked ? 'revoked' : 'active',
  };
}

function card(name: string, description?: string): AgentCard {
  return {
    name,
    ...(description ? { description } : {}),
    url: `http://${name}.internal/api/a2a/agent-card`,
    skills: [{ id: `${name}-skill`, name: `${name} skill`, description: '', tags: [] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: `${name}-domain`,
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
      sla: { ackSeconds: 5 },
    },
  };
}

describe('RosterProjector', () => {
  const activeHealthy = entry({
    cardUrl: 'http://a/api/a2a/agent-card',
    taskUrl: 'http://a/api/a2a/tasks',
    card: card('atlas', 'maps things'),
    fealty: card('atlas')['x-zeus-fealty']!,
    lastHealthCheck: { at: '2026-09-21T09:30:00.000Z', ok: true },
  });
  const activeUnknown = entry({
    cardUrl: 'http://l/api/a2a/agent-card',
    taskUrl: 'http://l/api/a2a/tasks',
    card: card('loom'),
    fealty: card('loom')['x-zeus-fealty']!,
  });
  const revokedUnhealthy = entry({
    cardUrl: 'http://p/api/a2a/agent-card',
    taskUrl: 'http://p/api/a2a/tasks',
    card: card('pr-helper', 'reviews prs'),
    fealty: card('pr-helper')['x-zeus-fealty']!,
    revoked: true,
    lastHealthCheck: { at: '2026-09-21T09:31:00.000Z', ok: false, detail: 'HTTP 503' },
  });
  const all = [revokedUnhealthy, activeUnknown, activeHealthy];

  it('projects the internal roster with every vassal, endpoints, probe detail and deterministic order', () => {
    const snapshot = projectInternalRoster(all, () => new Date('2026-09-21T10:00:00.000Z'));
    expect(snapshot.generatedAt).toBe('2026-09-21T10:00:00.000Z');
    expect(snapshot.scope).toBe('internal');
    expect(snapshot.entries.map(e => e.name)).toEqual(['atlas', 'loom', 'pr-helper']);

    const atlas = snapshot.entries[0];
    expect(atlas).toMatchObject({
      name: 'atlas',
      description: 'maps things',
      domain: 'atlas-domain',
      status: 'active',
      health: 'healthy',
      cardUrl: 'http://a/api/a2a/agent-card',
      taskUrl: 'http://a/api/a2a/tasks',
    });
    expect(atlas.commitments).toEqual({ dataRealms: ['enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' });
    expect(atlas.sla).toEqual({ ackSeconds: 5 });
    expect(atlas.skills[0].id).toBe('atlas-skill');

    expect(snapshot.entries[1].health).toBe('unknown'); // no probe yet
    const revoked = snapshot.entries[2];
    expect(revoked.status).toBe('revoked');
    expect(revoked.health).toBe('unhealthy');
    expect(revoked.healthDetail).toBe('HTTP 503');
  });

  it('projects the public roster: active only, endpoints and probe details stripped', () => {
    const snapshot = projectPublicRoster(all, () => new Date('2026-09-21T10:00:00.000Z'));
    expect(snapshot.scope).toBe('public');
    expect(snapshot.entries.map(e => e.name)).toEqual(['atlas', 'loom']);
    for (const e of snapshot.entries as RosterEntry[]) {
      expect(e).not.toHaveProperty('cardUrl');
      expect(e).not.toHaveProperty('taskUrl');
      expect(e).not.toHaveProperty('healthDetail');
      expect(e.status).toBe('active');
    }
    // fealty commitments remain verbatim
    expect(snapshot.entries[0].commitments.escalationPolicy).toBe('auto');
    // snapshot is JSON-serializable
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('projects straight from a live registry listAll view', async () => {
    const registry = new VassalRegistry(async url =>
      url.includes('loom')
        ? new Response(JSON.stringify(card('loom')), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify(card('pr-helper', 'reviews prs')), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    await registry.register('http://pr-helper.internal/api/a2a/agent-card');
    await registry.register('http://loom.internal/api/a2a/agent-card');
    registry.revoke('loom');

    const internal = projectInternalRoster(registry.listAll());
    expect(internal.entries.map(e => [e.name, e.status])).toEqual([['loom', 'revoked'], ['pr-helper', 'active']]);

    const pub = projectPublicRoster(registry.listAll());
    expect(pub.entries.map(e => e.name)).toEqual(['pr-helper']);
    expect(pub.entries[0].description).toBe('reviews prs');
  });
});

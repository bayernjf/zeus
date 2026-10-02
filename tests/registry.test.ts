import { describe, expect, it } from 'vitest';
import { VassalRegistry, CardFetchError, VassalRevokedError, defaultTaskUrl, type RegistryHooks } from '../src/registry/registry.js';
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
  it('registers a vassal and dispatches to the endpoint the card itself declares', async () => {
    const fetches: string[] = [];
    const registry = new VassalRegistry(async url => {
      fetches.push(url);
      return cardResponse(prHelperCard());
    });
    const entry = await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(fetches).toEqual(['http://vassal.internal/api/a2a/agent-card']);
    expect(entry.card.name).toBe('pr-helper');
    // pr-helper serves its JSON-RPC face on the card path itself; the card says
    // so and dispatch must honour it rather than rewriting to the convention.
    expect(entry.taskUrl).toBe('http://vassal.internal/api/a2a/agent-card');
    expect(entry.fealty.swornTo).toBe('zeus');
    expect(registry.get('pr-helper')?.fealty.domain).toBe('pr-release-control');
  });

  it('rejects cards without a zeus fealty (guest agents are not vassals)', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard({ 'x-zeus-fealty': undefined })));
    await expect(registry.register('http://guest/api/a2a/agent-card')).rejects.toThrow(/no vassal fealty/);
  });

  /**
   * Dispatch dereferences these oath fields on every request. Before this, a
   * card that omitted one registered cleanly and produced a TypeError from deep
   * inside the dispatcher at task time - found by a real process, not by a mock.
   */
  describe('fealty oath validation', () => {
    const registerWith = async (fealty: unknown) => {
      const registry = new VassalRegistry(async () => cardResponse(prHelperCard({ 'x-zeus-fealty': fealty })));
      await registry.register('http://vassal.internal/api/a2a/agent-card');
    };
    const oath = (over: Record<string, unknown> = {}) => ({
      version: '1',
      swornTo: 'zeus',
      domain: 'pr-release-control',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
      ...over,
    });

    it('names the missing field instead of accepting a card it cannot honour', async () => {
      const { dataRealms, ...noRealms } = oath();
      void dataRealms;
      await expect(registerWith(noRealms)).rejects.toThrow(/dataRealms must be an array of realm types, got nothing/);
      await expect(registerWith(oath({ dataPolicy: 'read-everything' })))
        .rejects.toThrow(/dataPolicy must be one of none, read-task-scope, read-realm, write, got "read-everything"/);
      const { reportBack, ...noReport } = oath();
      void reportBack;
      await expect(registerWith(noReport)).rejects.toThrow(/reportBack must be a boolean, got nothing/);
      await expect(registerWith(oath({ escalationPolicy: 'vibes' }))).rejects.toThrow(/escalationPolicy must be one of/);
    });

    it('refuses an unknown realm type but accepts an empty oath list', async () => {
      await expect(registerWith(oath({ dataRealms: ['Enterprise'] })))
        .rejects.toThrow(/dataRealms holds unknown realm types: "Enterprise"/);
      // Swearing to no data domain at all is a legitimate (if unusual) oath; the
      // diode then refuses every task with an explicit reason, which is honest.
      await expect(registerWith(oath({ dataRealms: [] }))).resolves.toBeUndefined();
    });

    it('rejects an unusable SLA number and accepts a card without SLA', async () => {
      await expect(registerWith(oath({ sla: { ackSeconds: 0 } }))).rejects.toThrow(/sla\.ackSeconds must be a positive number/);
      await expect(registerWith(oath({ sla: { ackSeconds: 'soon' } }))).rejects.toThrow(/sla\.ackSeconds must be a positive number/);
      await expect(registerWith(oath({ sla: undefined }))).resolves.toBeUndefined();
    });

    it('points at the card that was refused', async () => {
      await expect(registerWith(oath({ dataPolicy: undefined })))
        .rejects.toThrow(/http:\/\/vassal\.internal\/api\/a2a\/agent-card$/);
    });

    // domain is the grouping key routing and the roster project on: an empty or
    // missing one quietly put every such vassal in the same nameless bucket.
    it('refuses an oath whose domain is empty or missing', async () => {
      await expect(registerWith(oath({ domain: '' }))).rejects.toThrow(/domain must be a non-empty string, got ""/);
      await expect(registerWith(oath({ domain: '   ' }))).rejects.toThrow(/domain must be a non-empty string/);
      await expect(registerWith(oath({ domain: undefined }))).rejects.toThrow(/domain must be a non-empty string, got nothing/);
    });
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
    // A peer that answers 5xx and a peer we cannot reach are the same class of
    // failure to the caller: transport, not content.
    await expect(down.register('http://down/api/a2a/agent-card')).rejects.toBeInstanceOf(CardFetchError);
  });

  // A 200 from a peer that is serving something other than a card. This is a
  // transport failure — the peer failed to answer the question — not a malformed
  // request, and the HTTP face maps it to 502 accordingly.
  it('treats a 200 whose body is not JSON as a transport failure', async () => {
    const registry = new VassalRegistry(
      async () => new Response('<html>maintenance</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    );
    const err = await registry.register('http://vassal.internal/api/a2a/agent-card').catch(e => e);
    expect(err).toBeInstanceOf(CardFetchError);
    expect(err.message).toMatch(/not JSON/);
    expect(err.message).toContain('http://vassal.internal/api/a2a/agent-card');
  });

  // A-12 guards every outbound face; this pins that an explicit taskUrl override
  // goes through the same guard as the card URL, so neither can name a target
  // the dispatcher would then POST JSON-RPC to.
  it('refuses a taskUrl override that is not an http(s) absolute URL', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard()));
    await expect(
      registry.register('http://vassal.internal/api/a2a/agent-card', { taskUrl: 'ftp://vassal.internal/tasks' })
    ).rejects.toThrow(/http or https/);
    await expect(registry.register('http://vassal.internal/api/a2a/agent-card', { taskUrl: '' })).rejects.toThrow(
      /absolute URL/
    );
  });

  it('never hands the outbound token to the caller or the onRegister hook', async () => {
    const seen: Array<Parameters<NonNullable<RegistryHooks['onRegister']>>[0]> = [];
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard()), () => new Date(), {
      onRegister: entry => seen.push(entry),
    });
    const entry = await registry.register('http://vassal.internal/api/a2a/agent-card', { token: 'outbound-credential' });
    expect(entry).not.toHaveProperty('token');
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('token');
    // The dispatcher and the on-disk snapshot stay the only readers.
    expect(registry.tokenFor('pr-helper')).toBe('outbound-credential');
    expect(registry.exportState()[0]!.token).toBe('outbound-credential');
  });

  // Every other failure stub in this file returns a bad Response. None of them
  // throws, which is how a connection-level failure stayed unclassified.
  it('classifies a connection-level failure as a transport error naming the URL', async () => {
    const registry = new VassalRegistry(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await registry.register('http://gone.internal/api/a2a/agent-card').catch(e => e);
    expect(err).toBeInstanceOf(CardFetchError);
    expect(err.message).toContain('http://gone.internal/api/a2a/agent-card');
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
    expect(lookup.get('pr-helper')).toMatchObject({ name: 'pr-helper', taskUrl: 'http://vassal.internal/api/a2a/agent-card' });
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

  it('refuses to re-register a revoked name so a POST cannot undo a revocation (A-02)', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard()));
    await registry.register('http://vassal.internal/api/a2a/agent-card', { token: 'bearer-a' });
    expect(registry.revoke('pr-helper')).toBe(true);

    const err = await registry
      .register('http://attacker.internal/api/a2a/agent-card', { token: 'bearer-b' })
      .catch(e => e);
    expect(err).toBeInstanceOf(VassalRevokedError);
    // The rejected registration must leave the revoked entry exactly as it was:
    // same declared card URL, same stored credential, still revoked.
    const [entry] = registry.listAll();
    expect(entry).toMatchObject({ status: 'revoked' });
    expect(entry!.cardUrl).toBe('http://vassal.internal/api/a2a/agent-card');
    expect(registry.tokenFor('pr-helper')).toBeUndefined();
  });

  it('restores a revoked vassal only through an explicit, audited reinstate (A-02)', async () => {
    const events: Array<{ name: string; at: string }> = [];
    const registry = new VassalRegistry(
      async () => cardResponse(prHelperCard()),
      () => new Date('2026-10-01T10:00:00.000Z'),
      { onReinstate: (name, at) => events.push({ name, at }) }
    );
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(registry.revoke('pr-helper')).toBe(true);

    expect(registry.reinstate('pr-helper')).toBe(true);
    expect(events).toEqual([{ name: 'pr-helper', at: '2026-10-01T10:00:00.000Z' }]);
    // routable again, and the transition is a one-shot: repeat / unknown names are no-ops
    expect(registry.get('pr-helper')).toBeDefined();
    expect(registry.reinstate('pr-helper')).toBe(false);
    expect(registry.reinstate('ghost')).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('listAll keeps revoked vassals with an explicit status for the oversight deck', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard()));
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.listAll()[0]!.status).toBe('active');
    registry.revoke('pr-helper');
    const all = registry.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('revoked');
    expect(all[0]!.card.name).toBe('pr-helper');
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

  // The probe reason is text the peer's transport (or the OS) writes, and it is
  // then persisted to the state file and carried inside the signed roster
  // snapshot. Bound and flatten it before it gets there.
  it('bounds and flattens a probe failure before it is persisted and signed', async () => {
    let calls = 0;
    const registry = new VassalRegistry(async () => {
      calls += 1;
      if (calls === 1) return cardResponse(prHelperCard());
      throw new Error(`dial tcp 10.1.2.3:443: connect: connection refused\n\u0007${'x'.repeat(500)}`);
    });
    await registry.register('http://vassal.internal/api/a2a/agent-card');
    expect(await registry.healthCheck('pr-helper')).toBe(false);
    const detail = registry.get('pr-helper')?.lastHealthCheck?.detail ?? '';
    expect(detail.startsWith('dial tcp 10.1.2.3:443: connect: connection refused')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  // The accessors strip the outbound bearer, so their declared type must not
  // promise it either. Compile-time guard: if any of these signatures regains
  // `token?`, `npm run typecheck` fails on the assignments below.
  it('declares no token on the accessors that strip it', async () => {
    const registry = new VassalRegistry(async () => cardResponse(prHelperCard()));
    await registry.register('http://vassal.internal/api/a2a/agent-card', { token: 'outbound-credential' });
    type Guard<T> = 'token' extends keyof T ? 'leaked' : 'clean';
    const fromGet: Guard<NonNullable<ReturnType<typeof registry.get>>> = 'clean';
    const fromList: Guard<ReturnType<typeof registry.list>[number]> = 'clean';
    const fromListAll: Guard<ReturnType<typeof registry.listAll>[number]> = 'clean';
    const fromSkill: Guard<ReturnType<typeof registry.findVassalsForSkill>[number]> = 'clean';
    expect([fromGet, fromList, fromListAll, fromSkill]).toEqual(['clean', 'clean', 'clean', 'clean']);
    expect(registry.get('pr-helper')).not.toHaveProperty('token');
  });
});

describe('task endpoint resolution', () => {
  const registerWith = (card: AgentCard, options?: { taskUrl?: string }) =>
    new VassalRegistry(async () => cardResponse(card)).register('http://vassal.internal/api/a2a/agent-card', options);

  it('prefers the endpoint the card declares over the URL convention', async () => {
    const entry = await registerWith(prHelperCard({ url: 'http://vassal.internal/rpc' }));
    expect(entry.taskUrl).toBe('http://vassal.internal/rpc');
  });

  it('lets an explicit taskUrl override win over the card declaration', async () => {
    const entry = await registerWith(prHelperCard({ url: 'http://vassal.internal/rpc' }), { taskUrl: 'http://vassal.internal/override' });
    expect(entry.taskUrl).toBe('http://vassal.internal/override');
  });

  it('falls back to the convention when the card declares no usable endpoint', async () => {
    const blank = await registerWith(prHelperCard({ url: '   ' }));
    expect(blank.taskUrl).toBe('http://vassal.internal/api/a2a/tasks');
    const junk = await registerWith(prHelperCard({ url: 'not-a-url' }));
    expect(junk.taskUrl).toBe('http://vassal.internal/api/a2a/tasks');
    const scheme = await registerWith(prHelperCard({ url: 'ftp://vassal.internal/tasks' }));
    expect(scheme.taskUrl).toBe('http://vassal.internal/api/a2a/tasks');
    const missing = await registerWith(prHelperCard({ url: undefined }));
    expect(missing.taskUrl).toBe('http://vassal.internal/api/a2a/tasks');
  });
});

describe('defaultTaskUrl', () => {
  it('maps card endpoints and well-known paths to the tasks endpoint', () => {
    expect(defaultTaskUrl('http://x/api/a2a/agent-card')).toBe('http://x/api/a2a/tasks');
    expect(defaultTaskUrl('http://x/.well-known/agent-card.json')).toBe('http://x/api/a2a/tasks');
    expect(defaultTaskUrl('http://x/.well-known/agent.json')).toBe('http://x/api/a2a/tasks');
  });
});

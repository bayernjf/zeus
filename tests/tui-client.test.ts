import { describe, expect, it, vi } from 'vitest';
import { ApiError, createDeckClient } from '../src/tui/client.js';

type Init = { method?: string; headers?: Record<string, string>; body?: string };
type Call = { url: string; init?: Init };
type ResponseLike = { ok: boolean; status: number; json(): Promise<unknown> };

function mockClient(route: (url: string) => ResponseLike | Promise<ResponseLike>): { calls: Call[]; client: ReturnType<typeof createDeckClient> } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: Init) => {
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    return route(url);
  });
  return { calls, client: createDeckClient('http://kernel', 'tok', fetchImpl) };
}

const okJson = (body: unknown): ResponseLike => ({ ok: true, status: 200, json: async () => body });
const fail503: ResponseLike = { ok: false, status: 503, json: async () => null };

function snapshotRoute(overrides: { audit?: ResponseLike } = {}) {
  return (url: string): ResponseLike => {
    if (url === 'http://kernel/api/audit?limit=12') {
      return overrides.audit ?? okJson({ entries: [{ ts: 't', vassal: 'p', decision: 'dispatched' }] });
    }
    if (url.endsWith('/api/roster')) return okJson({ snapshot: { generatedAt: '', entries: [] } });
    if (url.includes('/api/escalations')) return okJson({ escalations: [] });
    return okJson({});
  };
}

describe('TUI client POST bodies (P0-8 pilot finding)', () => {
  it('sends a JSON body even for a plain approve with no note', async () => {
    const { calls, client } = mockClient(() => okJson({ escalation: { id: 'esc-1' } }));
    await client.approve('esc-1');
    const call = calls.find(c => c.url.includes('/api/escalations/esc-1/approve'));
    expect(call?.init?.method).toBe('POST');
    // A JSON-labelled empty body is a transport-level 400 on real Fastify.
    expect(call?.init?.body).toBe('{}');
    expect(call?.init?.headers?.['content-type']).toBe('application/json');
  });
});

describe('TUI reinstate face (A-02)', () => {
  it('posts to the reinstate route with a JSON body', async () => {
    const { calls, client } = mockClient(() => okJson({ name: 'p1', revoked: false }));
    await client.reinstate('p 1');
    const call = calls.find(c => c.url.includes('/api/vassals/p%201/reinstate'));
    expect(call?.init?.method).toBe('POST');
    // The route reads no body, but a JSON-labelled empty one is a 400 on Fastify.
    expect(call?.init?.body).toBe('{}');
    expect(call?.init?.headers?.['content-type']).toBe('application/json');
  });
});

describe('TUI resume face (E6.3)', () => {
  it('posts the operator-supplied parameters to approve-resume', async () => {
    const { calls, client } = mockClient(() => okJson({ escalation: { id: 'esc-1' }, intent: {} }));
    await client.resume('esc 1', { env: 'prod' });
    const call = calls.find(c => c.url.includes('/api/escalations/esc%201/approve-resume'));
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.body).toBe(JSON.stringify({ params: { env: 'prod' } }));
    expect(call?.init?.headers?.['content-type']).toBe('application/json');
  });
});

describe('TUI contract face (self-host step 5)', () => {
  it('includes the contract ledger in the snapshot and degrades to null when unmounted', async () => {
    const withContracts = mockClient(url => {
      if (url === 'http://kernel/api/delegation-contracts') {
        return okJson({ contracts: [{ id: 'dc-1', grantedBy: 'op', skill: 'research', capabilities: ['execute'], limits: { maxChildTickets: 1, maxConcurrent: 1, windowEndsAt: 'w' }, used: { childTickets: 0, inFlight: 0 }, issuedAt: 't' }] });
      }
      return snapshotRoute()(url);
    });
    const snap = await withContracts.client.snapshot();
    expect(snap.contracts?.contracts).toHaveLength(1);

    const without = mockClient(url => (url === 'http://kernel/api/delegation-contracts' ? fail503 : snapshotRoute()(url)));
    const degraded = await without.client.snapshot();
    expect(degraded.contracts).toBeNull();
  });

  it('issues a contract via POST and unwraps the envelope', async () => {
    const { calls, client } = mockClient(url => {
      if (url === 'http://kernel/api/delegation-contracts') {
        return okJson({ contract: { id: 'dc-9', grantedBy: 'op', skill: 'research', capabilities: ['execute'], limits: {}, used: { childTickets: 0, inFlight: 0 }, issuedAt: 't' } });
      }
      return fail503;
    });
    const contract = await client.issueContract({
      grantedBy: 'op',
      skill: 'research',
      capabilities: ['execute'],
      limits: { maxChildTickets: 4, maxConcurrent: 2, windowEndsAt: '2026-10-02T00:00:00.000Z' },
    });
    expect(contract.id).toBe('dc-9');
    const call = calls.find(c => c.url.endsWith('/api/delegation-contracts'));
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(call?.init?.body ?? '{}').capabilities).toEqual(['execute']);
  });

  it('revokes via DELETE and surfaces a refusal as ApiError', async () => {
    const { calls, client } = mockClient(url => (url.endsWith('/api/delegation-contracts/dc-1') ? okJson({}) : fail503));
    await client.revokeContract('dc-1');
    const call = calls.find(c => c.url.endsWith('/api/delegation-contracts/dc-1'));
    expect(call?.init?.method).toBe('DELETE');

    const refusing = mockClient(url => (url.endsWith('/api/delegation-contracts/dc-1') ? { ok: false, status: 409, json: async () => ({ message: 'already revoked' }) } : fail503));
    await expect(refusing.client.revokeContract('dc-1')).rejects.toMatchObject({ status: 409 });
  });

  it('approve-contract returns the new contract and rebound watch ids', async () => {
    const { calls, client } = mockClient(url =>
      url.endsWith('/api/escalations/esc-1/approve-contract')
        ? okJson({ escalation: { id: 'esc-1' }, contract: { id: 'dc-2' }, watch: { id: 'w-1' } })
        : fail503,
    );
    const bound = await client.approveContract('esc-1', { grantedBy: 'operator', maxChildTickets: 4, maxConcurrent: 1, windowEndsAt: '2026-10-02T00:00:00.000Z' });
    expect(bound).toEqual({ contractId: 'dc-2', watchId: 'w-1' });
    const call = calls.find(c => c.url.includes('/approve-contract'));
    expect(call?.init?.method).toBe('POST');
    const sent = JSON.parse(call?.init?.body ?? '{}');
    expect(sent.grantedBy).toBe('operator');
    expect(sent.limits).toEqual({ maxChildTickets: 4, maxConcurrent: 1, windowEndsAt: '2026-10-02T00:00:00.000Z' });
  });
});

describe('TUI HTTP client', () => {
  it('includes the latest audit entries in the snapshot', async () => {
    const { client } = mockClient(snapshotRoute());
    const snap = await client.snapshot();
    expect(snap.audit).toEqual([{ ts: 't', vassal: 'p', decision: 'dispatched' }]);
  });

  it('degrades the timeline to null when the audit face is unavailable (roster/escalations stay authoritative)', async () => {
    const { client } = mockClient(snapshotRoute({ audit: fail503 }));
    const snap = await client.snapshot();
    expect(snap.audit).toBeNull();
    expect(snap.roster.entries).toEqual([]);
  });

  it('fetches the timeline with an encoded limit and sends the bearer header', async () => {
    const { calls, client } = mockClient(() => okJson({ entries: [] }));
    await client.timeline(25);
    const call = calls.find(c => c.url.includes('/api/audit'));
    expect(call?.url).toBe('http://kernel/api/audit?limit=25');
    expect(call?.init?.headers?.authorization).toBe('Bearer tok');
  });

  it('fetches mounted realms and the grant ledger from /api/domains', async () => {
    const payload = {
      realms: [{ realmId: 'acme', type: 'enterprise', tenant: { org: 'acme' }, readOnly: true, itemCount: 3, contentDigest: 'sha256:x' }],
      grants: [{ grantId: 'g-1', subject: 'loom', realmId: 'acme', access: 'read', grantedBy: 'op', grantedAt: 't', nonce: 'n' }],
    };
    const { calls, client } = mockClient(url =>
      url === 'http://kernel/api/domains'
        ? okJson(payload)
        : okJson({}),
    );
    const domains = await client.domains();
    expect(domains).toEqual(payload);
    expect(calls.some(c => c.url === 'http://kernel/api/domains')).toBe(true);
  });

  it('degrades domains to null in the snapshot when the face is not mounted', async () => {
    const { client } = mockClient(url => {
      if (url.endsWith('/api/domains')) return fail503;
      return snapshotRoute()(url);
    });
    const snap = await client.snapshot();
    expect(snap.domains).toBeNull();
    expect(snap.roster.entries).toEqual([]);
  });

  it('surfaces non-2xx responses as ApiError with the server message', async () => {
    const { client } = mockClient(url =>
      url.includes('/api/audit') ? { ok: false, status: 404, json: async () => ({ error: { message: 'unknown intent' } }) } : okJson({}),
    );
    await expect(client.timeline()).rejects.toBeInstanceOf(ApiError);
  });

  it('issues a grant with a JSON body and surfaces a 4xx failure', async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Init) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      return okJson({ grantId: 'g-9', subject: 'loom', realmId: 'acme', access: 'read', grantedBy: 'op', grantedAt: 't', nonce: 'n' });
    });
    const client = createDeckClient('http://kernel', 'tok', fetchImpl);
    const grant = await client.issueGrant({ subject: 'loom', realmId: 'acme', access: 'read', grantedBy: 'op' });
    expect(grant.grantId).toBe('g-9');
    expect(calls[0]!.url).toBe('http://kernel/api/domains/grants');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init?.body ?? '{}')).toEqual({ subject: 'loom', realmId: 'acme', access: 'read', grantedBy: 'op' });

    const bad = createDeckClient('http://kernel', 'tok', vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: { message: 'grants authorize enterprise realms' } }),
    })));
    await expect(bad.issueGrant({ subject: 'x', realmId: 'p', access: 'read', grantedBy: 'op' })).rejects.toBeInstanceOf(ApiError);
  });

  it('revokes a grant by encoded grantId on DELETE', async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Init) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      return okJson({});
    });
    const client = createDeckClient('http://kernel', 'tok', fetchImpl);
    await client.revokeGrant('grant x/1');
    expect(calls[0]!.url).toBe('http://kernel/api/domains/grants/grant%20x%2F1');
    expect(calls[0]!.init?.method).toBe('DELETE');
  });

  it('recognizes an instruction via POST /api/intents/recognize (local path omits useModel)', async () => {
    const { calls, client } = mockClient(url => {
      expect(url).toBe('http://kernel/api/intents/recognize');
      return okJson({ ok: true, intent: { skill: 'deployment-health' }, confidence: 0.5, backend: null, decisionAt: 'd' });
    });
    const result = await client.recognize('review the pr');
    expect(result).toEqual({ ok: true, skill: 'deployment-health', confidence: 0.5, backend: null, decisionAt: 'd' });
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body).toEqual({ text: 'review the pr' });
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.init!.headers!.authorization).toBe('Bearer tok');
    expect(calls[0]!.init!.headers!['content-type']).toBe('application/json');
  });

  it('sends realm + useModel only when opted in', async () => {
    const { calls, client } = mockClient(() => okJson({ ok: true, intent: { skill: 'research' }, confidence: 0.8, backend: { kind: 'llm', model: 'm' }, decisionAt: 'd' }));
    await client.recognize('research postgres vs sqlite', { realm: 'enterprise', useModel: true });
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body).toEqual({ text: 'research postgres vs sqlite', realm: 'enterprise', useModel: true });
  });

  it('surfaces a fail-closed response as-is (never turns it into a guessed intent)', async () => {
    const { client } = mockClient(() => okJson({ ok: false, reason: 'no-candidates' }));
    await expect(client.recognize('zzz')).resolves.toEqual({ ok: false, reason: 'no-candidates' });
  });

  it('surfaces a structured fail-closed 422 as a view, not an error', async () => {
    const { client } = mockClient(() => ({ ok: false, status: 422, json: async () => ({ ok: false, reason: 'no-backend' }) }));
    await expect(client.recognize('review', { useModel: true })).resolves.toEqual({ ok: false, reason: 'no-backend' });
  });

  it('throws ApiError on non-2xx recognize responses', async () => {
    const { client } = mockClient(() => fail503);
    await expect(client.recognize('review')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('TUI connector face (E7 MCP)', () => {
  const connectorPayload = {
    connectors: [
      { id: 'c1', name: 'GitHub', status: 'declared', permissions: ['repo:read'], hasToken: false },
    ],
  };

  it('includes the connector ledger in the snapshot and degrades to null when unmounted', async () => {
    const withConn = mockClient(url =>
      url === 'http://kernel/api/connectors' ? okJson(connectorPayload) : snapshotRoute()(url),
    );
    const snap = await withConn.client.snapshot();
    expect(snap.connectors?.connectors).toHaveLength(1);

    const without = mockClient(url => (url === 'http://kernel/api/connectors' ? fail503 : snapshotRoute()(url)));
    const degraded = await without.client.snapshot();
    expect(degraded.connectors).toBeNull();
  });

  it('declares a connector via POST and sends the token without echoing it back', async () => {
    const { calls, client } = mockClient(url =>
      url === 'http://kernel/api/connectors'
        ? okJson({ id: 'c1', name: 'GitHub', status: 'declared', permissions: ['repo:read'], hasToken: true })
        : fail503,
    );
    const declared = await client.declareConnector({ id: 'c1', name: 'GitHub', permissions: ['repo:read'], token: 'secret' });
    expect(declared.hasToken).toBe(true);
    const call = calls.find(c => c.url === 'http://kernel/api/connectors');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({ id: 'c1', name: 'GitHub', permissions: ['repo:read'], token: 'secret' });
  });

  it('runs the handshake via POST /api/connectors/:id/connect', async () => {
    const { calls, client } = mockClient(url =>
      url === 'http://kernel/api/connectors/c1/connect'
        ? okJson({ id: 'c1', name: 'GitHub', status: 'connected', permissions: [], hasToken: true, capabilities: { tools: ['search'], resources: [], prompts: [] } })
        : fail503,
    );
    const bound = await client.connectConnector('c1');
    expect(bound.status).toBe('connected');
    expect(calls[0]!.url).toBe('http://kernel/api/connectors/c1/connect');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('revokes a connector via DELETE and surfaces a refusal as ApiError', async () => {
    const { calls, client } = mockClient(url => (url.endsWith('/api/connectors/c1') ? okJson({ id: 'c1', status: 'revoked', permissions: [], hasToken: false }) : fail503));
    const revoked = await client.revokeConnector('c1');
    expect(revoked.status).toBe('revoked');
    const call = calls.find(c => c.url.endsWith('/api/connectors/c1'));
    expect(call?.init?.method).toBe('DELETE');

    const refusing = mockClient(url => (url.endsWith('/api/connectors/c1') ? { ok: false, status: 409, json: async () => ({ message: 'already revoked' }) } : fail503));
    await expect(refusing.client.revokeConnector('c1')).rejects.toMatchObject({ status: 409 });
  });

  it('calls a tool with the arguments envelope and returns the raw result', async () => {
    const { calls, client } = mockClient(url =>
      url === 'http://kernel/api/connectors/c1/tools/search/call'
        ? okJson({ result: { hits: 3 } })
        : fail503,
    );
    const result = await client.callConnectorTool('c1', 'search', { q: 'zeus' });
    expect(result).toEqual({ hits: 3 });
    const call = calls[0]!;
    expect(call.url).toBe('http://kernel/api/connectors/c1/tools/search/call');
    expect(call.init?.method).toBe('POST');
    expect(JSON.parse(call.init?.body ?? '{}')).toEqual({ arguments: { q: 'zeus' } });
  });
});

describe('TUI active-intents face (S15 V3)', () => {
  const activePayload = {
    intents: [
      {
        intentId: 'intent-live',
        skill: 'review',
        status: 'running',
        settledCount: 0,
        totalCount: 1,
        view: { order: ['run-1:loom'], branches: {}, partiallyReady: false },
      },
    ],
  };

  it('includes active intents in the snapshot and degrades to null when the face is absent', async () => {
    const withFace = mockClient(url =>
      url === 'http://kernel/api/active-intents' ? okJson(activePayload) : snapshotRoute()(url),
    );
    const snap = await withFace.client.snapshot();
    expect(snap.active?.intents).toHaveLength(1);
    expect(snap.active?.intents[0]?.intentId).toBe('intent-live');

    const without = mockClient(url => (url === 'http://kernel/api/active-intents' ? fail503 : snapshotRoute()(url)));
    const degraded = await without.client.snapshot();
    expect(degraded.active).toBeNull();
  });
});

describe('TUI cost face (E6.5)', () => {
  const account = {
    configured: true,
    refusals: 2,
    limits: { maxWindowCost: 100 },
    totals: { intents: 3, spent: 40, inFlightEstimate: 7 },
    windows: [{ intentId: 'intent-1', spent: 40, inFlightEstimate: 7, windowEndsAt: 1 }],
    truncated: false,
  };

  it('reads /api/cost as the eleventh aggregate route', async () => {
    const { calls, client } = mockClient(url => (url === 'http://kernel/api/cost' ? okJson(account) : snapshotRoute()(url)));
    const snap = await client.snapshot();
    expect(snap.cost).toEqual(account);
    expect(calls.some(call => call.url === 'http://kernel/api/cost')).toBe(true);
  });

  it('degrades to null when the endpoint is not mounted, leaving the core faces authoritative', async () => {
    const { client } = mockClient(url => (url === 'http://kernel/api/cost' ? fail503 : snapshotRoute()(url)));
    const snap = await client.snapshot();
    expect(snap.cost).toBeNull();
    expect(snap.roster.entries).toBeDefined();
    expect(snap.escalations).toBeDefined();
  });
});

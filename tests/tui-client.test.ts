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
    expect(calls[0].url).toBe('http://kernel/api/domains/grants');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init?.body ?? '{}')).toEqual({ subject: 'loom', realmId: 'acme', access: 'read', grantedBy: 'op' });

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
    expect(calls[0].url).toBe('http://kernel/api/domains/grants/grant%20x%2F1');
    expect(calls[0].init?.method).toBe('DELETE');
  });
});

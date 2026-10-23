import { describe, expect, it, vi } from 'vitest';
import {
  ZeusClient,
  ZeusClientError,
  type DecisionPolicy,
  type DecisionRecord,
  type DecisionResponse,
} from '../src/index.js';

const BASE = 'http://zeus.test';
const TOKEN = 'tok';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(handler);
  const client = new ZeusClient({ baseUrl: BASE, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5_000 });
  return { client, fetchImpl };
}

const decisionResponse: DecisionResponse = {
  decisionId: 'dec_1',
  grade: 'D2',
  mode: 'approve-sync',
  status: 'blocked',
  ruleId: 'd2-amount',
  auditSeq: 0,
};

const record: DecisionRecord = {
  id: 'dec_1',
  intent: 'refund',
  domain: 'commerce',
  impact: 'org',
  reversibility: 'hard',
  grade: 'D2',
  mode: 'approve-sync',
  status: 'blocked',
  ruleId: 'd2-amount',
  gradeReason: 'x',
  policyVersion: 1,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  auditSeq: 0,
  approvals: [],
};

/** A fetch that hangs until the request signal aborts, then rejects like real fetch. */
function hangingFetch(): typeof fetch {
  const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('The operation was aborted'));
      });
    })) as unknown as typeof fetch;
  return impl;
}

describe('zeus-client', () => {
  it('decide() POSTs the request with bearer header and returns the 201 body', async () => {
    const { client, fetchImpl } = makeClient((input, init) => {
      expect(String(input)).toBe(`${BASE}/api/v1/decisions`);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toMatchObject({ intent: 'refund', domain: 'commerce' });
      return jsonResponse(201, decisionResponse);
    });
    const result = await client.decide({ intent: 'refund', domain: 'commerce', impact: 'org' });
    expect(result).toEqual(decisionResponse);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('getDecision() GETs /:id with an encoded path', async () => {
    const { client, fetchImpl } = makeClient((input) => {
      expect(String(input)).toBe(`${BASE}/api/v1/decisions/dec_1`);
      return jsonResponse(200, record);
    });
    expect(await client.getDecision('dec_1')).toEqual(record);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('listDecisions() encodes domain and status filters', async () => {
    const { client } = makeClient((input) => {
      expect(String(input)).toBe(`${BASE}/api/v1/decisions?domain=commerce&status=blocked`);
      return jsonResponse(200, { decisions: [record] });
    });
    const result = await client.listDecisions({ domain: 'commerce', status: 'blocked' });
    expect(result).toEqual([record]);
  });

  it('listDecisions() sends no query when no filter is given', async () => {
    const { client } = makeClient((input) => {
      expect(String(input)).toBe(`${BASE}/api/v1/decisions`);
      return jsonResponse(200, { decisions: [] });
    });
    expect(await client.listDecisions()).toEqual([]);
  });

  it('approve() POSTs the verdict body to the approval route', async () => {
    const { client, fetchImpl } = makeClient((input, init) => {
      expect(String(input)).toBe(`${BASE}/api/v1/decisions/dec_1/approval`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ decision: 'approve', approver: 'owner', comment: 'ok' });
      return jsonResponse(200, { ...decisionResponse, status: 'decided' });
    });
    const result = await client.approve('dec_1', { decision: 'approve', approver: 'owner', comment: 'ok' });
    expect(result.status).toBe('decided');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('replay() GETs the json replay', async () => {
    const { client } = makeClient((input) => {
      expect(String(input)).toBe(`${BASE}/api/v1/decisions/dec_1/replay?format=json`);
      return jsonResponse(200, { format: 'json', record, events: [{ type: 'decision.created', at: record.createdAt }] });
    });
    const replay = await client.replay('dec_1');
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]?.type).toBe('decision.created');
  });

  it('replayText() GETs the text replay and returns a string', async () => {
    const { client, fetchImpl } = makeClient((input, init) => {
      expect(String(input)).toBe(`${BASE}/api/v1/decisions/dec_1/replay?format=text`);
      const headers = init?.headers as Record<string, string>;
      expect(headers.accept).toBe('application/json');
      return new Response('decision created at 2026\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    expect(await client.replayText('dec_1')).toContain('decision created');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('getPolicy() GETs the current policy', async () => {
    const policy: DecisionPolicy = { version: 1, defaultGrade: 'D2', rules: [] };
    const { client } = makeClient((input) => {
      expect(String(input)).toBe(`${BASE}/api/v1/policy`);
      return jsonResponse(200, policy);
    });
    expect(await client.getPolicy()).toEqual(policy);
  });

  it('updatePolicy() PUTs the policy and sends the x-zeus-actor header', async () => {
    const policy: DecisionPolicy = { version: 2, defaultGrade: 'D2', rules: [] };
    const { client, fetchImpl } = makeClient((input, init) => {
      expect(String(input)).toBe(`${BASE}/api/v1/policy`);
      expect(init?.method).toBe('PUT');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-zeus-actor']).toBe('owner');
      expect(JSON.parse(String(init?.body))).toEqual(policy);
      return jsonResponse(200, policy);
    });
    expect(await client.updatePolicy(policy, 'owner')).toEqual(policy);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('updatePolicy() defaults actor to system', async () => {
    const policy: DecisionPolicy = { version: 2, defaultGrade: 'D2', rules: [] };
    const { client } = makeClient((_input, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-zeus-actor']).toBe('system');
      return jsonResponse(200, policy);
    });
    await client.updatePolicy(policy);
  });

  it('maps a §8.1 error body (409 IDEMPOTENCY_CONFLICT) onto ZeusClientError', async () => {
    const { client } = makeClient(() => jsonResponse(409, {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'same idempotency key with different request fingerprint',
      retryable: false,
    }));
    await expect(client.decide({ intent: 'x', domain: 'y', idempotencyKey: 'k' })).rejects.toMatchObject({
      name: 'ZeusClientError',
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
    });
  });

  it('maps a 404 DECISION_NOT_FOUND', async () => {
    const { client } = makeClient(() => jsonResponse(404, { code: 'DECISION_NOT_FOUND', message: 'nope', retryable: false }));
    const error = await client.getDecision('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZeusClientError);
    expect((error as ZeusClientError).status).toBe(404);
  });

  it('maps a 401 without a body to UNAUTHORIZED', async () => {
    const { client } = makeClient(() => new Response(null, { status: 401 }));
    const error = await client.getPolicy().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZeusClientError);
    expect((error as ZeusClientError).code).toBe('UNAUTHORIZED');
    expect((error as ZeusClientError).retryable).toBe(false);
  });

  it('maps a 500 POLICY_NOT_FOUND as non-retryable', async () => {
    const { client } = makeClient(() => jsonResponse(500, { code: 'POLICY_NOT_FOUND', message: 'no policy', retryable: false }));
    const error = await client.getPolicy().catch((e: unknown) => e);
    expect((error as ZeusClientError).code).toBe('POLICY_NOT_FOUND');
    expect((error as ZeusClientError).status).toBe(500);
    expect((error as ZeusClientError).retryable).toBe(false);
  });

  it('maps a non-JSON 502 body to HTTP_502 retryable', async () => {
    const { client } = makeClient(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const error = await client.getPolicy().catch((e: unknown) => e);
    expect((error as ZeusClientError).code).toBe('HTTP_502');
    expect((error as ZeusClientError).retryable).toBe(true);
  });

  it('maps a network failure to NETWORK_ERROR retryable', async () => {
    const { client } = makeClient(() => {
      throw new Error('ECONNREFUSED');
    });
    const error = await client.getPolicy().catch((e: unknown) => e);
    expect((error as ZeusClientError).code).toBe('NETWORK_ERROR');
    expect((error as ZeusClientError).status).toBe(0);
    expect((error as ZeusClientError).retryable).toBe(true);
  });

  it('maps a client-side timeout to REQUEST_TIMEOUT retryable', async () => {
    const client = new ZeusClient({ baseUrl: BASE, token: TOKEN, fetchImpl: hangingFetch() });
    const error = await client.getPolicy({ timeoutMs: 20 }).catch((e: unknown) => e);
    expect((error as ZeusClientError).code).toBe('REQUEST_TIMEOUT');
    expect((error as ZeusClientError).retryable).toBe(true);
  });

  it('maps a caller-aborted signal to REQUEST_ABORTED non-retryable', async () => {
    const controller = new AbortController();
    const client = new ZeusClient({ baseUrl: BASE, token: TOKEN, fetchImpl: hangingFetch() });
    const promise = client.getPolicy({ signal: controller.signal, timeoutMs: 5_000 }).catch((e: unknown) => e);
    controller.abort();
    const error = await promise;
    expect((error as ZeusClientError).code).toBe('REQUEST_ABORTED');
    expect((error as ZeusClientError).retryable).toBe(false);
  });

  it('rejects a 2xx non-JSON body as BAD_RESPONSE', async () => {
    const { client } = makeClient(() => new Response('not-json', { status: 200 }));
    const error = await client.getPolicy().catch((e: unknown) => e);
    expect((error as ZeusClientError).code).toBe('BAD_RESPONSE');
  });

  it('rejects construction without baseUrl or token', () => {
    expect(() => new ZeusClient({ baseUrl: '', token: 't' })).toThrow(TypeError);
    expect(() => new ZeusClient({ baseUrl: 'http://x', token: '' })).toThrow(TypeError);
  });

  it('strips a trailing slash from baseUrl', async () => {
    const { client } = makeClient((input) => {
      expect(String(input)).toBe(`${BASE}/api/v1/policy`);
      return jsonResponse(200, { version: 1, defaultGrade: 'D2', rules: [] });
    });
    const withSlash = new ZeusClient({
      baseUrl: `${BASE}/`,
      token: TOKEN,
      fetchImpl: vi.fn(() => jsonResponse(200, { version: 1, defaultGrade: 'D2', rules: [] })) as unknown as typeof fetch,
    });
    await withSlash.getPolicy();
    await client.getPolicy();
  });
});

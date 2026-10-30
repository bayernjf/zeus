/**
 * Decision lifecycle webhook: push events instead of polling listPending.
 *
 * Covers the dispatcher (HMAC signature, deterministic delivery id, bounded
 * backoff, fail-soft), the service-level event emission (created/late/approved),
 * and the bearer subscription routes.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  DecisionAuditChain,
  DecisionService,
  MemoryDecisionStore,
} from '../src/core/index.js';
import { MemoryPolicyStore } from '../src/core/grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';
import {
  DecisionWebhookDispatcher,
  MemoryDecisionWebhookStore,
  signWebhookBody,
  signWebhookPayload,
} from '../src/core/decision-service/webhook.js';
import type { DecisionEvent } from '../src/core/decision-service/events.js';
import type { DecisionPolicy } from '../src/core/grading/policy.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function event(overrides: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    type: 'approved',
    decisionId: 'dec_test_1',
    at: '2026-10-26T00:00:00.000Z',
    domain: 'commerce',
    intent: 'refund',
    grade: 'D2',
    mode: 'approve-sync',
    status: 'decided',
    ruleId: 'd2-amount',
    ...overrides,
  };
}

function harness(now: { t: string } = { t: '2026-10-26T00:00:00.000Z' }, policy?: DecisionPolicy) {
  const signer = new Ed25519MemorySigner('audit-seal-test');
  const audit = new DecisionAuditChain(signer, () => now.t);
  const policyStore = new MemoryPolicyStore();
  policyStore.put(policy ?? DEFAULT_POLICY_V1);
  const recordStore = new MemoryDecisionStore();
  return { audit, policyStore, recordStore, now };
}

describe('Decision webhook dispatcher', () => {
  it('posts a signed JSON body to the active subscription', async () => {
    const store = new MemoryDecisionWebhookStore();
    store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: 'top-secret-value-16', active: true });
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ?? '' });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    const ev = event();
    await dispatcher.emit(ev);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:9/hook');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers['x-zeus-delivery-id']).toBe(`${ev.decisionId}:${ev.type}:${ev.at}`);
    expect(calls[0]!.headers['x-zeus-signature']).toBe(signWebhookBody('top-secret-value-16', calls[0]!.body));
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ type: 'approved', decisionId: 'dec_test_1' });
  });

  it('sends v2 freshness headers signing timestamp, nonce and body', async () => {
    const store = new MemoryDecisionWebhookStore();
    store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: 'top-secret-value-16', active: true });
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        calls.push({ headers: init?.headers ?? {}, body: init?.body ?? '' });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    await dispatcher.emit(event());
    const h = calls[0]!.headers;
    expect(h['x-zeus-webhook-timestamp']).toMatch(/^\d{10}$/);
    expect(h['x-zeus-webhook-nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(h['x-zeus-webhook-signature']).toBe(
      signWebhookPayload('top-secret-value-16', h['x-zeus-webhook-timestamp']!, h['x-zeus-webhook-nonce']!, calls[0]!.body),
    );
    // Legacy body-only header stays for the rollout window.
    expect(h['x-zeus-signature']).toBe(signWebhookBody('top-secret-value-16', calls[0]!.body));
  });

  it('mints a fresh timestamp and nonce for each retry attempt', async () => {
    const store = new MemoryDecisionWebhookStore();
    store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: 'top-secret-value-16', active: true });
    const seen: Array<{ ts: string; nonce: string }> = [];
    let n = 0;
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      maxAttempts: 3,
      baseBackoffMs: 1,
      sleep: async () => undefined,
      fetch: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        seen.push({ ts: init!.headers!['x-zeus-webhook-timestamp']!, nonce: init!.headers!['x-zeus-webhook-nonce']! });
        n += 1;
        return { ok: false, status: 503 } as Response;
      }) as unknown as typeof fetch,
    });
    await dispatcher.emit(event());
    expect(n).toBe(3);
    expect(new Set(seen.map(s => s.nonce)).size).toBe(3);
    // Every attempt independently verifies.
    for (const s of seen) expect(s.ts).toMatch(/^\d{10}$/);
  });

  it('reverse gate: no delivery without an active subscription', async () => {
    const store = new MemoryDecisionWebhookStore();
    store.add({ id: 'wh-off', url: 'http://127.0.0.1:9/hook', secret: 'top-secret-value-16', active: false });
    let calls = 0;
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: (async () => {
        calls += 1;
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });
    await dispatcher.emit(event());
    expect(calls).toBe(0);
  });

  it('reverse gate: a receiver rejecting the signature (401) is not retried', async () => {
    // Receiver recomputes the HMAC with the real secret; a mismatched secret
    // means the kernel signed with the wrong one — retrying cannot fix that.
    const store = new MemoryDecisionWebhookStore();
    store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: 'kernel-secret-1234567', active: true });
    const calls: Array<{ signature: string; body: string }> = [];
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        const body = init?.body ?? '';
        calls.push({ signature: init?.headers?.['x-zeus-signature'] ?? '', body });
        const expected = signWebhookBody('receiver-expected-secret', body);
        return { ok: false, status: expected === (init?.headers?.['x-zeus-signature'] ?? '') ? 200 : 401 } as Response;
      }) as unknown as typeof fetch,
      sleep: async () => {
        throw new Error('must not back off on 4xx');
      },
    });
    await expect(dispatcher.emit(event())).resolves.toBeUndefined();
    expect(calls).toHaveLength(1); // 401: single attempt, no retry, no throw
  });

  it('retries network errors and 5xx with bounded exponential backoff', async () => {
    const store = new MemoryDecisionWebhookStore();
    store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: 'top-secret-value-16', active: true });
    const sleeps: number[] = [];
    const outcomes = [new Error('conn refused'), { ok: false, status: 503 }, { ok: true, status: 200 }];
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: (async () => {
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return next as Response;
      }) as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      baseBackoffMs: 100,
    });
    await expect(dispatcher.emit(event())).resolves.toBeUndefined();
    expect(sleeps).toEqual([100, 200]);
  });

  it('gives up silently after the attempt budget is exhausted', async () => {
    const store = new MemoryDecisionWebhookStore();
    store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: 'top-secret-value-16', active: true });
    let attempts = 0;
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: (async () => {
        attempts += 1;
        return { ok: false, status: 500 } as Response;
      }) as unknown as typeof fetch,
      sleep: async () => { /* noop */ },
      maxAttempts: 3,
    });
    await expect(dispatcher.emit(event())).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });
});

describe('DecisionService event emission', () => {
  it('emits created and approved; a throwing sink never breaks the decision', async () => {
    const h = harness();
    const emitted: DecisionEvent[] = [];
    const service = new DecisionService({
      policyStore: h.policyStore,
      recordStore: h.recordStore,
      audit: h.audit,
      clock: () => h.now.t,
      events: {
        emit: (ev: DecisionEvent) => {
          emitted.push(ev);
          if (ev.type === 'approved') throw new Error('sink down');
        },
      },
    });
    const created = await service.createDecision({
      intent: 'refund', domain: 'commerce', impact: 'org', reversibility: 'hard',
      amount: { value: 1200, currency: 'CNY' },
    });
    await expect(
      service.approve(created.id, { decision: 'approve', approver: 'ops' }),
    ).resolves.toMatchObject({ status: 'decided' });
    expect(emitted.map(e => e.type)).toEqual(['created', 'approved']);
    expect(emitted[0]).toMatchObject({ decisionId: created.id, grade: 'D2', status: 'blocked' });
  });

  it('emits late when the SLA breaches and timed-out at grace close', async () => {
    const now = { t: '2026-10-26T00:00:00.000Z' };
    const h = harness(now);
    const policy: DecisionPolicy = {
      version: 2,
      defaultGrade: 'D2',
      rules: [
        { id: 'd1-amount', match: { amount: { min: 0, max: 500, currency: 'CNY' } }, grade: 'D1', slaHours: 1 },
        { id: 'd0-self-reversible', match: { impact: ['self'], reversibility: ['reversible'] }, grade: 'D0' },
      ],
    };
    h.policyStore.put(policy);
    const emitted: DecisionEvent[] = [];
    const service = new DecisionService({
      policyStore: h.policyStore,
      recordStore: h.recordStore,
      audit: h.audit,
      clock: () => now.t,
      lateGraceHours: 2,
      events: { emit: ev => { emitted.push(ev); } },
    });
    const created = await service.createDecision({
      intent: 'buy', domain: 'self', impact: 'self', reversibility: 'reversible',
      amount: { value: 50, currency: 'CNY' },
    });
    now.t = '2026-10-26T01:00:00.000Z'; // breach
    await service.get(created.id);
    expect(emitted.map(e => e.type)).toEqual(['created', 'late']);
    expect(emitted[1]).toMatchObject({ type: 'late', status: 'awaiting_approval', lateAt: now.t });
    now.t = '2026-10-26T03:00:01.000Z'; // grace (2h) elapsed
    await service.sweepTimeouts(now.t);
    expect(emitted.map(e => e.type)).toEqual(['created', 'late', 'timed-out']);
  });
});

describe('Decision webhook subscription routes', () => {
  async function server(withStore: boolean): Promise<FastifyInstance> {
    const h = harness();
    const decisionService = new DecisionService({
      policyStore: h.policyStore,
      recordStore: h.recordStore,
      audit: h.audit,
      clock: () => h.now.t,
    });
    const store = withStore ? new MemoryDecisionWebhookStore() : undefined;
    return createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      decisionService,
      ...(store ? { decisionWebhookStore: store } : {}),
    });
  }

  it('is 401 without a bearer token', async () => {
    const app = await server(true);
    const res = await app.inject({ method: 'GET', url: '/api/v1/decision-webhooks' });
    expect(res.statusCode).toBe(401);
  });

  it('404s when no registry was assembled', async () => {
    const app = await server(false);
    const res = await app.inject({ method: 'GET', url: '/api/v1/decision-webhooks', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('adds a subscription and lists it without the secret', async () => {
    const app = await server(true);
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/decision-webhooks',
      headers: AUTH,
      payload: { url: 'https://ops.example.invalid/hook', secret: 'webhook-secret-value-16' },
    });
    expect(added.statusCode).toBe(201);
    const body = await added.json();
    expect(body).toMatchObject({ url: 'https://ops.example.invalid/hook', active: true });
    expect(body.secret).toBeUndefined();
    const listed = await app.inject({ method: 'GET', url: '/api/v1/decision-webhooks', headers: AUTH });
    const listedBody = await listed.json();
    expect(listedBody.webhooks).toHaveLength(1);
    expect(listedBody.webhooks[0]).toEqual({ id: body.id, url: 'https://ops.example.invalid/hook', active: true });
    expect(JSON.stringify(listedBody)).not.toContain('webhook-secret-value-16');
  });

  it('rejects a non-http(s) url or a short secret', async () => {
    const app = await server(true);
    const badUrl = await app.inject({
      method: 'POST', url: '/api/v1/decision-webhooks', headers: AUTH,
      payload: { url: 'ftp://x', secret: 'webhook-secret-value-16' },
    });
    expect(badUrl.statusCode).toBe(400);
    const shortSecret = await app.inject({
      method: 'POST', url: '/api/v1/decision-webhooks', headers: AUTH,
      payload: { url: 'https://ops.example.invalid/hook', secret: 'short' },
    });
    expect(shortSecret.statusCode).toBe(400);
  });
});

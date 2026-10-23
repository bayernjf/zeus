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

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NO_AUTH = {};

async function server(): Promise<FastifyInstance> {
  const registry = new VassalRegistry();
  const rskSigner = new Ed25519MemorySigner('zeus-rsk-test');
  const auditSigner = new Ed25519MemorySigner('audit-seal-test');
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  const decisionService = new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(auditSigner),
  });
  return createHttpServer({
    registry,
    signer: rskSigner,
    internalToken: TOKEN,
    decisionService,
  });
}

describe('T-M1-06 Decision API v1 over HTTP', () => {
  it('requires a bearer token', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/api/v1/decisions', payload: {}, headers: NO_AUTH });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeDefined();
  });

  it('does not mount the face when no service is assembled', async () => {
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/policy', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('creates a D0 decision that is immediately decided', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions',
      headers: AUTH,
      payload: { intent: 'note', domain: 'self', impact: 'self', reversibility: 'reversible' },
    });
    expect(res.statusCode).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ grade: 'D0', mode: 'auto', status: 'decided', ruleId: 'd0-self-reversible' });
    expect(body.decisionId).toBeTruthy();
    expect(body.auditSeq).toBeGreaterThanOrEqual(0);
  });

  it('parks a D2 decision as blocked and approves it', async () => {
    const app = await server();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions',
      headers: AUTH,
      payload: {
        intent: 'refund', domain: 'commerce', impact: 'org', reversibility: 'hard',
        amount: { value: 1000, currency: 'CNY' },
      },
    });
    expect(created.statusCode).toBe(201);
    const decision = await created.json();
    expect(decision).toMatchObject({ grade: 'D2', mode: 'approve-sync', status: 'blocked' });

    const fetched = await app.inject({ method: 'GET', url: `/api/v1/decisions/${decision.decisionId}`, headers: AUTH });
    expect(fetched.statusCode).toBe(200);
    expect((await fetched.json()).status).toBe('blocked');

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision.decisionId}/approval`,
      headers: AUTH,
      payload: { decision: 'approve', approver: 'owner', comment: 'ship it' },
    });
    expect(approved.statusCode).toBe(200);
    expect(await approved.json()).toMatchObject({ status: 'decided', grade: 'D2' });
  });

  it('rejects a D3 human-led decision', async () => {
    const app = await server();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions',
      headers: AUTH,
      payload: {
        intent: 'purchase', domain: 'commerce', impact: 'external', reversibility: 'irreversible',
        amount: { value: 9000, currency: 'CNY' },
      },
    });
    const decision = await created.json();
    expect(decision).toMatchObject({ grade: 'D3', mode: 'human-led', status: 'blocked' });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decision.decisionId}/approval`,
      headers: AUTH,
      payload: { decision: 'reject', approver: 'owner' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(await rejected.json()).toMatchObject({ status: 'rejected' });
  });

  it('validates the create body with the design error shape', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions',
      headers: AUTH,
      payload: { intent: '', domain: '', impact: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.retryable).toBe(false);
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('404s on unknown decision and double approval', async () => {
    const app = await server();
    const missing = await app.inject({ method: 'GET', url: '/api/v1/decisions/dec_nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
    expect((await missing.json()).code).toBe('DECISION_NOT_FOUND');

    const created = await app.inject({
      method: 'POST', url: '/api/v1/decisions', headers: AUTH,
      payload: { intent: 'note', domain: 'self', impact: 'self', reversibility: 'reversible' },
    });
    const { decisionId } = await created.json();
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decisionId}/approval`,
      headers: AUTH,
      payload: { decision: 'approve', approver: 'owner' },
    });
    expect(again.statusCode).toBe(409);
    expect((await again.json()).code).toBe('GRADE_REQUIRES_APPROVAL');
  });

  it('dedupes by idempotency key and conflicts on a changed payload', async () => {
    const app = await server();
    const payload = {
      intent: 'refund', domain: 'commerce', impact: 'org', reversibility: 'hard',
      amount: { value: 1000, currency: 'CNY' }, idempotencyKey: 'key-1',
    };
    const first = await app.inject({ method: 'POST', url: '/api/v1/decisions', headers: AUTH, payload });
    const second = await app.inject({ method: 'POST', url: '/api/v1/decisions', headers: AUTH, payload });
    expect((await first.json()).decisionId).toBe((await second.json()).decisionId);

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/decisions',
      headers: AUTH,
      payload: { ...payload, amount: { value: 2000, currency: 'CNY' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('lists decisions with domain and status filters', async () => {
    const app = await server();
    await app.inject({
      method: 'POST', url: '/api/v1/decisions', headers: AUTH,
      payload: { intent: 'note', domain: 'self', impact: 'self', reversibility: 'reversible' },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/decisions', headers: AUTH,
      payload: {
        intent: 'refund', domain: 'commerce', impact: 'org', reversibility: 'hard',
        amount: { value: 1000, currency: 'CNY' },
      },
    });
    const blocked = await app.inject({ method: 'GET', url: '/api/v1/decisions?status=blocked', headers: AUTH });
    expect((await blocked.json()).decisions).toHaveLength(1);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/decisions?status=bogus', headers: AUTH });
    expect(bad.statusCode).toBe(400);
  });

  it('serves replay in json and text', async () => {
    const app = await server();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/decisions', headers: AUTH,
      payload: {
        intent: 'refund', domain: 'commerce', impact: 'org', reversibility: 'hard',
        amount: { value: 1000, currency: 'CNY' },
      },
    });
    const { decisionId } = await created.json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/decisions/${decisionId}/approval`,
      headers: AUTH,
      payload: { decision: 'approve', approver: 'owner' },
    });
    const json = await app.inject({ method: 'GET', url: `/api/v1/decisions/${decisionId}/replay?format=json`, headers: AUTH });
    expect(json.statusCode).toBe(200);
    expect((await json.json()).events.map((e: { type: string }) => e.type)).toEqual(['decision.created', 'decision.approved']);
    const text = await app.inject({ method: 'GET', url: `/api/v1/decisions/${decisionId}/replay?format=text`, headers: AUTH });
    expect(text.statusCode).toBe(200);
    expect(text.headers['content-type']).toContain('text/plain');
    expect(text.body).toContain('decision.approved');
  });

  it('reads and updates the policy, versioning it', async () => {
    const app = await server();
    const current = await app.inject({ method: 'GET', url: '/api/v1/policy', headers: AUTH });
    expect(current.statusCode).toBe(200);
    expect((await current.json()).version).toBe(1);

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/policy',
      headers: { ...AUTH, 'x-zeus-actor': 'admin' },
      payload: { version: 2, defaultGrade: 'D2', rules: [] },
    });
    expect(updated.statusCode).toBe(200);
    expect((await updated.json()).version).toBe(2);

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/v1/policy',
      headers: AUTH,
      payload: { version: 2, defaultGrade: 'D2', rules: [] },
    });
    expect(stale.statusCode).toBe(400);
    const malformed = await app.inject({
      method: 'PUT',
      url: '/api/v1/policy',
      headers: AUTH,
      payload: { version: 3, defaultGrade: 'D9', rules: [] },
    });
    expect(malformed.statusCode).toBe(400);
  });
});

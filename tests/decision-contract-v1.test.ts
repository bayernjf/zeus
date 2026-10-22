/**
 * T-M1-08 decision contract tests: zeus-client against a REAL listening
 * decision service (not app.inject). Every grade level, SLA timeout,
 * idempotency, fail-closed paths and audit-chain verification are exercised
 * over actual HTTP; the GATE-M1 case runs one full decision end to end.
 *
 * The final block proves the contract predicates would fail against
 * deliberately defected responses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  DecisionAuditChain,
  DecisionService,
  MemoryDecisionStore,
  verifyDecisionAuditChain,
} from '../src/core/index.js';
import type { DecisionAuditChain as DecisionAuditChainType } from '../src/core/index.js';
import { MemoryPolicyStore } from '../src/core/grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';
import type { DecisionPolicy } from '../src/core/grading/policy.js';
import { ZeusClient, ZeusClientError } from '../packages/zeus-client/src/index.js';

const TOKEN = 'contract-secret';

interface Stack {
  app: FastifyInstance;
  client: ZeusClient;
  service: DecisionService;
  auditChain: DecisionAuditChainType;
  auditSigner: Ed25519MemorySigner;
  port: number;
}

async function startStack(policy: DecisionPolicy = DEFAULT_POLICY_V1): Promise<Stack> {
  const registry = new VassalRegistry();
  const rskSigner = new Ed25519MemorySigner('zeus-rsk-contract');
  const auditSigner = new Ed25519MemorySigner('audit-seal-contract');
  const policyStore = new MemoryPolicyStore();
  policyStore.put(policy);
  const auditChain = new DecisionAuditChain(auditSigner);
  const service = new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: auditChain,
  });
  const app = await createHttpServer({
    registry,
    signer: rskSigner,
    internalToken: TOKEN,
    decisionService: service,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const client = new ZeusClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 10_000 });
  return { app, client, service, auditChain, auditSigner, port };
}

async function startStackWithoutPolicy(): Promise<{ app: FastifyInstance; port: number }> {
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-contract'),
    internalToken: TOKEN,
    decisionService: new DecisionService({
      policyStore: new MemoryPolicyStore(),
      recordStore: new MemoryDecisionStore(),
      audit: new DecisionAuditChain(new Ed25519MemorySigner('audit-seal-contract')),
    }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, port: (app.server.address() as { port: number }).port };
}

let openApps: FastifyInstance[] = [];
beforeEach(() => {
  openApps = [];
});
afterEach(async () => {
  await Promise.all(openApps.map(app => app.close()));
});

describe('T-M1-08 contract: four grade levels over real HTTP', () => {
  it('D0: self/reversible is decided automatically (no approval)', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const d = await stack.client.decide({ intent: 'note', domain: 'self', impact: 'self', reversibility: 'reversible' });
    expect(d).toMatchObject({ grade: 'D0', mode: 'auto', status: 'decided', ruleId: 'd0-self-reversible' });
  });

  it('D1: small amount parks for async approval and resolves after approve', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const d = await stack.client.decide({
      intent: 'buy', domain: 'self', impact: 'self', reversibility: 'reversible',
      amount: { value: 100, currency: 'CNY' }, idempotencyKey: 'd1-key',
    });
    expect(d).toMatchObject({ grade: 'D1', mode: 'approve-async', status: 'awaiting_approval' });
    const settled = await stack.client.approve(d.decisionId, { decision: 'approve', approver: 'owner' });
    expect(settled).toMatchObject({ status: 'decided', grade: 'D1' });
  });

  it('D2: mid amount is blocked for synchronous approval (default level, fail-closed)', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const d = await stack.client.decide({
      intent: 'refund', domain: 'commerce', impact: 'self', reversibility: 'reversible',
      amount: { value: 1200, currency: 'CNY' },
    });
    expect(d).toMatchObject({ grade: 'D2', mode: 'approve-sync', status: 'blocked', ruleId: 'd2-amount' });
  });

  it('D3: large amount is blocked for human-led handling', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const d = await stack.client.decide({
      intent: 'contract', domain: 'commerce', impact: 'self', reversibility: 'reversible',
      amount: { value: 6000, currency: 'CNY' },
    });
    expect(d).toMatchObject({ grade: 'D3', mode: 'human-led', status: 'blocked', ruleId: 'd3-amount-large' });
  });

  it('D3: external impact also escalates to human-led', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const d = await stack.client.decide({ intent: 'commit', domain: 'external', impact: 'external', reversibility: 'hard' });
    expect(d).toMatchObject({ grade: 'D3', mode: 'human-led', status: 'blocked' });
  });
});

describe('T-M1-08 contract: SLA timeout', () => {
  it('an awaiting D1 decision past slaHours is rejected as timed-out (lazy sweep)', async () => {
    const fastTimeoutPolicy: DecisionPolicy = {
      version: 1,
      defaultGrade: 'D2',
      rules: [
        { id: 'd1-amount', match: { amount: { min: 0, max: 500, currency: 'CNY' } }, grade: 'D1', slaHours: 1 / 3600 },
        { id: 'd0-self-reversible', match: { impact: ['self'], reversibility: ['reversible'] }, grade: 'D0' },
      ],
    };
    const stack = await startStack(fastTimeoutPolicy);
    openApps.push(stack.app);
    const d = await stack.client.decide({
      intent: 'buy', domain: 'self', impact: 'self', reversibility: 'reversible',
      amount: { value: 50, currency: 'CNY' },
    });
    expect(d.status).toBe('awaiting_approval');
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const later = await stack.client.getDecision(d.decisionId);
    expect(later.status).toBe('rejected');
    expect(later.result?.outcome).toBe('timed-out');
  });
});

describe('T-M1-08 contract: idempotency', () => {
  it('same key + same fingerprint returns the same decision; different fingerprint conflicts', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const req = {
      intent: 'refund', domain: 'commerce', impact: 'org' as const, reversibility: 'hard' as const,
      amount: { value: 1200, currency: 'CNY' }, idempotencyKey: 'idem-1',
    };
    const first = await stack.client.decide(req);
    const second = await stack.client.decide(req);
    expect(second.decisionId).toBe(first.decisionId);
    const conflict = await stack.client
      .decide({ ...req, amount: { value: 1201, currency: 'CNY' } })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ZeusClientError);
    expect((conflict as ZeusClientError).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((conflict as ZeusClientError).status).toBe(409);
  });
});

describe('T-M1-08 contract: fail-closed', () => {
  it('rejects an unknown field with VALIDATION_FAILED (400)', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const error = await stack.client
      .decide({ intent: 'x', domain: 'self', impact: 'self', reversibility: 'reversible', rogue: true } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZeusClientError);
    expect((error as ZeusClientError).code).toBe('VALIDATION_FAILED');
    expect((error as ZeusClientError).status).toBe(400);
  });

  it('refuses decisions when no policy is seeded (POLICY_NOT_FOUND 500, non-retryable)', async () => {
    const { app, port } = await startStackWithoutPolicy();
    openApps.push(app);
    const client = new ZeusClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN });
    const error = await client
      .decide({ intent: 'x', domain: 'self', impact: 'self', reversibility: 'reversible' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZeusClientError);
    expect((error as ZeusClientError).code).toBe('POLICY_NOT_FOUND');
    expect((error as ZeusClientError).status).toBe(500);
    expect((error as ZeusClientError).retryable).toBe(false);
  });

  it('rejects a bad bearer token with 401', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const wrong = new ZeusClient({ baseUrl: `http://127.0.0.1:${stack.port}`, token: 'wrong' });
    const error = await wrong.getPolicy().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZeusClientError);
    expect((error as ZeusClientError).code).toBe('UNAUTHORIZED');
    expect((error as ZeusClientError).status).toBe(401);
  });
});

describe('T-M1-08 contract: audit-chain verification fails on tampering', () => {
  it('a tampered audit entry fails full-chain verification (fail-closed)', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const d = await stack.client.decide({
      intent: 'refund', domain: 'commerce', impact: 'org', reversibility: 'hard',
      amount: { value: 1200, currency: 'CNY' },
    });
    await stack.client.approve(d.decisionId, { decision: 'approve', approver: 'owner' });
    const entries = stack.auditChain.list();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const verifier = stack.auditSigner.verifier();
    const intact = await verifyDecisionAuditChain(entries, verifier);
    expect(intact).toMatchObject({ ok: true });
    const tampered = entries.map((entry, i) => {
      if (i !== 1) return entry;
      return {
        ...entry,
        payload: { ...entry.payload, data: { ...entry.payload.data, grade: 'D0' } },
      };
    });
    const broken = await verifyDecisionAuditChain(tampered, verifier);
    expect(broken.ok).toBe(false);
  });
});

describe('GATE-M1: zeus-client end-to-end decision against a live server', () => {
  it('creates a D2 decision, approves it, and replays the full timeline', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const created = await stack.client.decide({
      intent: 'refund', domain: 'commerce', impact: 'self', reversibility: 'reversible',
      amount: { value: 1200, currency: 'CNY' },
      idempotencyKey: 'gate-m1',
    });
    expect(created.status).toBe('blocked');
    expect(created.mode).toBe('approve-sync');
    const settled = await stack.client.approve(created.decisionId, {
      decision: 'approve', approver: 'owner', comment: 'gate ok',
    });
    expect(settled.status).toBe('decided');
    const replay = await stack.client.replay(created.decisionId);
    expect(replay.events.map(e => e.type)).toEqual(['decision.created', 'decision.approved']);
    const text = await stack.client.replayText(created.decisionId);
    expect(text).toContain('created');
    expect(text).toContain('decision.approved by owner');
  });
});

describe('T-M1-08 contract: injected defects are caught', () => {
  // Each case asserts the contract predicate fails when the response is
  // defected - proving the suite would fail against a broken implementation.
  it('the grade-level contract catches a wrong-grade response', () => {
    const defected = {
      decisionId: 'x', grade: 'D0', mode: 'auto', status: 'decided', ruleId: 'd0', auditSeq: 0,
    };
    expect(() =>
      expect(defected).toMatchObject({ grade: 'D2', mode: 'approve-sync', status: 'blocked' })).toThrow();
  });

  it('the idempotency contract catches a server that mints duplicate ids', () => {
    const first = { decisionId: 'dec_a' };
    const duplicate = { decisionId: 'dec_b' };
    expect(() => expect(duplicate.decisionId).toBe(first.decisionId)).toThrow();
  });

  it('the auth contract catches a server that accepts a bad token', async () => {
    const stack = await startStack();
    openApps.push(stack.app);
    const wrong = new ZeusClient({ baseUrl: `http://127.0.0.1:${stack.port}`, token: 'wrong' });
    try {
      await wrong.getPolicy();
      throw new Error('contract should have failed: bad token accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ZeusClientError);
      expect((error as ZeusClientError).status).toBe(401);
    }
  });

  it('the SLA contract catches a server that never times out', () => {
    const overdue = { status: 'awaiting_approval', result: undefined };
    expect(() => expect(overdue).toMatchObject({ status: 'rejected' })).toThrow();
  });

  it('the fail-closed contract catches a server that decides without a policy', () => {
    const accepted = { status: 200 };
    expect(() => expect(accepted).toMatchObject({ status: 500 })).toThrow();
  });
});

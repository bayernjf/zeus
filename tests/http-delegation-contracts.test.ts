import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  DelegationContractRegistry,
  deriveExecutionDelegation,
} from '../src/delegation/delegation-contract.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import { WatchRegistry } from '../src/watch/watch.js';
import type { DelegationContractAuditEntry } from '../src/delegation/delegation-contract.js';

/**
 * design-self-host-loop §7 step 5: the operator face for bounded delegation
 * contracts. The kernel can already derive tickets while nobody is present
 * (step 4); this proves the human side that authorizes it — issue, read,
 * revoke — and that approving a delegation-limit escalation issues a fresh
 * contract and rebinds the named watch without re-dispatching anything.
 */

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-10-03T00:00:00.000Z');
const WINDOW = new Date(NOW.getTime() + 3_600_000).toISOString();

function validLimits() {
  return { maxChildTickets: 3, maxConcurrent: 2, windowEndsAt: WINDOW };
}

async function harness() {
  const audit: DelegationContractAuditEntry[] = [];
  const delegationContracts = new DelegationContractRegistry();
  const signer = new Ed25519MemorySigner('k');
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer,
    internalToken: TOKEN,
    now: () => NOW,
    delegationContracts,
    auditSink: undefined,
    delegationContractAudit: entry => void audit.push(entry),
  } as Parameters<typeof createHttpServer>[0]);
  return { app, delegationContracts, audit, signer };
}

describe('HTTP self-host step 5 — delegation contract issuance', () => {
  it('issues a signed, bounded contract, registers it and audits issuance', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/delegation-contracts',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        grantedBy: 'operator@example',
        skill: 'merge',
        capabilities: ['execute'],
        vassal: 'loom',
        reason: 'nightly merge watch',
        limits: validLimits(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { contract: Record<string, unknown> };
    expect(body.contract).toMatchObject({
      kind: 'zeus-delegation-contract',
      grantedBy: 'operator@example',
      skill: 'merge',
      vassal: 'loom',
      capabilities: ['execute'],
      keyId: 'k',
    });
    expect(typeof body.contract.sig).toBe('string');
    expect(body.contract.sig).not.toBe('');

    // The issued contract is immediately registered, so a watch can derive from it.
    const listed = h.delegationContracts.list();
    expect(listed).toHaveLength(1);
    const derived = await deriveExecutionDelegation(
      listed[0]!.id,
      { capabilities: ['execute'], vassal: 'loom' },
      { registry: h.delegationContracts, signer: h.signer, verifier: h.signer.verifier(), now: () => NOW },
    );
    expect(derived.ok).toBe(true);

    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      decision: 'delegation-contract-issued',
      grantedBy: 'operator@example',
      skill: 'merge',
      vassal: 'loom',
      maxChildTickets: 3,
      maxConcurrent: 2,
    });
  });

  it('400s when a required boundary field is missing or malformed', async () => {
    const h = await harness();
    const bad: Array<{ label: string; payload: Record<string, unknown> }> = [
      { label: 'grantedBy', payload: { skill: 'merge', capabilities: ['execute'], limits: validLimits() } },
      { label: 'skill', payload: { grantedBy: 'op', capabilities: ['execute'], limits: validLimits() } },
      { label: 'capabilities empty', payload: { grantedBy: 'op', skill: 'merge', capabilities: [], limits: validLimits() } },
      { label: 'limits', payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'] } },
      { label: 'maxChildTickets', payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'], limits: { ...validLimits(), maxChildTickets: 0 } } },
      { label: 'maxConcurrent > maxChildTickets', payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'], limits: { ...validLimits(), maxConcurrent: 5 } } },
      { label: 'windowEndsAt past', payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'], limits: { ...validLimits(), windowEndsAt: '2020-01-01T00:00:00Z' } } },
    ];
    for (const { label, payload } of bad) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/delegation-contracts',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode, label).toBe(400);
    }
    expect(h.delegationContracts.list()).toHaveLength(0);
  });

  it('400s when the capabilities do not cover execute (domain error from the primitive)', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/delegation-contracts',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 'merge', capabilities: ['plan'], limits: validLimits() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401s without a bearer token', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/delegation-contracts',
      headers: { 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'], limits: validLimits() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists and reads contracts', async () => {
    const h = await harness();
    const issued = await h.app.inject({
      method: 'POST',
      url: '/api/delegation-contracts',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'], limits: validLimits() },
    });
    const id = (issued.json() as { contract: { id: string } }).contract.id;
    const list = await h.app.inject({ method: 'GET', url: '/api/delegation-contracts', headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { contracts: unknown[] }).contracts).toHaveLength(1);
    const one = await h.app.inject({ method: 'GET', url: `/api/delegation-contracts/${id}`, headers: AUTH });
    expect(one.statusCode).toBe(200);
    const missing = await h.app.inject({ method: 'GET', url: '/api/delegation-contracts/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });

  it('revokes a contract, audits it, and blocks further derivation', async () => {
    const h = await harness();
    const issued = await h.app.inject({
      method: 'POST',
      url: '/api/delegation-contracts',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'], limits: validLimits() },
    });
    const id = (issued.json() as { contract: { id: string } }).contract.id;
    const revoked = await h.app.inject({ method: 'DELETE', url: `/api/delegation-contracts/${id}`, headers: AUTH });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { contract: { revokedAt?: string } }).contract.revokedAt).toBeTruthy();
    expect(h.audit.map(e => e.decision)).toContain('delegation-contract-revoked');

    const derived = await deriveExecutionDelegation(
      id,
      { capabilities: ['execute'] },
      { registry: h.delegationContracts, signer: h.signer, verifier: h.signer.verifier(), now: () => NOW },
    );
    expect(derived).toMatchObject({ ok: false, reason: 'revoked' });

    const again = await h.app.inject({ method: 'DELETE', url: `/api/delegation-contracts/${id}`, headers: AUTH });
    expect(again.statusCode).toBe(409);
  });

  it('is not mounted when the kernel assembled no contract registry', async () => {
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('k'),
      internalToken: TOKEN,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/delegation-contracts',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 'merge', capabilities: ['execute'], limits: validLimits() },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('HTTP self-host step 5 — approving a delegation-limit escalation', () => {
  it('issues a fresh contract, rebinds the watch, marks the escalation approved, and dispatches nothing', async () => {
    const signer = new Ed25519MemorySigner('k');
    const delegationContracts = new DelegationContractRegistry();
    const watches = new WatchRegistry({ newId: () => 'w1' });
    const oversight = new OversightDesk({ now: () => NOW });
    watches.register({
      id: 'w1',
      owner: 'operator@example',
      realm: 'personal',
      predicate: { source: 'metrics', op: 'above', field: 'queueDepth', value: 2 },
      intent: { skill: 'merge', subject: 'x', mode: 'execute', maxFanOut: 1 },
      delegationId: 'old-contract',
      intervalSeconds: 60,
      startsAt: '2026-10-02T00:00:00.000Z',
      expiresAt: '2026-10-04T00:00:00.000Z',
      budget: { fires: 5, executes: 5 },
    });
    const escalation = oversight.ingestDelegationLimit({
      watchId: 'w1',
      delegationId: 'old-contract',
      skill: 'merge',
      realm: 'personal',
      limitReason: 'child-ticket-limit-reached',
      tickSeq: 1,
    });

    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer,
      internalToken: TOKEN,
      now: () => NOW,
      delegationContracts,
      watches,
      oversight,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/escalations/${escalation.id}/approve-contract`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'operator@example', limits: validLimits() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      contract: { id: string; skill: string; capabilities: string[] };
      escalation: { status: string };
      watch: { delegationId: string };
    };
    expect(body.escalation.status).toBe('approved');
    expect(body.contract.skill).toBe('merge');
    expect(body.contract.capabilities).toEqual(['execute']);
    // The watch now derives from the new contract on its next evaluation.
    expect(body.watch.delegationId).toBe(body.contract.id);
    expect(watches.get('w1')!.delegationId).toBe(body.contract.id);

    // And the freshly bound contract really does derive a ticket.
    const derived = await deriveExecutionDelegation(
      body.contract.id,
      { capabilities: ['execute'] },
      { registry: delegationContracts, signer, verifier: signer.verifier(), now: () => NOW },
    );
    expect(derived.ok).toBe(true);
  });

  it('400s on a non delegation-limit escalation', async () => {
    const signer = new Ed25519MemorySigner('k');
    const delegationContracts = new DelegationContractRegistry();
    const watches = new WatchRegistry();
    const oversight = new OversightDesk({ now: () => NOW });
    // memory-dispute is another kind; approving a contract for it is a shape error.
    oversight.ingestMemoryDispute({
      id: 'esc-m1',
      runId: 'run-1',
      realm: 'personal',
      realmId: 'r1',
      factId: 'm1',
      conflictingFacts: ['e1', 'e2'],
      reason: 'contradictory facts',
    });
    const id = oversight.list('pending', 'memory-dispute')[0]!.id;
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer,
      internalToken: TOKEN,
      now: () => NOW,
      delegationContracts,
      watches,
      oversight,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/escalations/${id}/approve-contract`,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', limits: validLimits() },
    });
    expect(res.statusCode).toBe(400);
  });
});

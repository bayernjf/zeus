import { describe, expect, it } from 'vitest';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  ExecutionDelegationError,
  ExecutionDelegationNonceLedger,
  verifyAndConsumeExecutionDelegation,
} from '../src/delegation/execution-delegation.js';
import {
  DELEGATION_CONTRACT_REQUIRED_CAPABILITY,
  DelegationContractError,
  DelegationContractRegistry,
  deriveExecutionDelegation,
  issueDelegationContract,
  verifyDelegationContract,
  type DelegationContract,
  type IssueDelegationContractInput,
} from '../src/delegation/delegation-contract.js';

const T0 = new Date('2026-10-05T00:00:00.000Z');
const WINDOW = new Date(T0.getTime() + 6 * 3_600_000).toISOString();
const HOUR = 3_600_000;

function contractInput(over: Partial<IssueDelegationContractInput> = {}): IssueDelegationContractInput {
  return {
    grantedBy: 'operator-1',
    skill: 'research',
    capabilities: ['execute', 'github:issue:comment'],
    limits: { maxChildTickets: 3, maxConcurrent: 2, windowEndsAt: WINDOW },
    ...over,
  };
}

function harness() {
  const signer = new Ed25519MemorySigner('zeus-rsk-dev');
  const verifier = signer.verifier();
  const registry = new DelegationContractRegistry();
  const now = () => T0;
  return { signer, verifier, registry, now };
}

async function issuedInto(registry: DelegationContractRegistry, signer: Ed25519MemorySigner, over: Partial<IssueDelegationContractInput> = {}) {
  const contract = await issueDelegationContract(contractInput(over), { signer, now: () => T0 });
  registry.add(contract);
  return contract;
}

/** Derive with everything defaulted; most cases only care about the refusal. */
async function derive(h: ReturnType<typeof harness>, contractId: string, over: Parameters<typeof deriveExecutionDelegation>[1] = { capabilities: ['execute'] }) {
  return deriveExecutionDelegation(contractId, over, { registry: h.registry, signer: h.signer, verifier: h.verifier, now: h.now });
}

describe('delegation contract - issuance and verification (design-self-host-loop §4)', () => {
  it('seals the approved boundary and verifies offline', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    expect(await verifyDelegationContract(contract, { verifier: h.verifier, now: h.now })).toEqual({ ok: true });
    expect(contract.used).toEqual({ childTickets: 0, inFlight: 0 });
    expect(contract.keyId).toBe('zeus-rsk-dev');
  });

  it('refuses a contract whose limits were edited after signing', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    const widened: DelegationContract = { ...contract, limits: { ...contract.limits, maxChildTickets: 9_999 } };
    expect(await verifyDelegationContract(widened, { verifier: h.verifier, now: h.now })).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a contract from a key the operator never accepted', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    expect(await verifyDelegationContract(contract, { verifier: h.verifier, acceptedKeyIds: ['other-key'], now: h.now }))
      .toEqual({ ok: false, reason: 'unknown-key' });
  });

  it('fails closed when no trust anchor is supplied', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    // Omitting the verifier must not degrade this into a shape-only pass.
    expect(await verifyDelegationContract(contract, { now: h.now })).toEqual({ ok: false, reason: 'no-trust-anchor' });
  });

  it('keeps spent counters and revocation outside the signed claim', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    // The signature covers what the operator approved; the kernel writes the
    // bookkeeping. If used were inside the claim, the first derivation would
    // break the seal, so this is the assertion that keeps the split deliberate.
    const spent: DelegationContract = { ...contract, used: { childTickets: 2, inFlight: 1 } };
    expect(await verifyDelegationContract(spent, { verifier: h.verifier, now: h.now })).toEqual({ ok: true });
  });

  it('refuses malformed shapes without touching a key', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    expect(await verifyDelegationContract({ ...contract, kind: 'zeus-other' as DelegationContract['kind'] }, { verifier: h.verifier, now: h.now }))
      .toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyDelegationContract({ ...contract, limits: { ...contract.limits, maxChildTickets: 0 } }, { verifier: h.verifier, now: h.now }))
      .toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyDelegationContract(undefined, { verifier: h.verifier, now: h.now })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an issuance that could not authorize anything', async () => {
    const h = harness();
    await expect(issueDelegationContract(contractInput({ capabilities: ['github:issue:comment'] }), { signer: h.signer, now: h.now }))
      .rejects.toThrow(DELEGATION_CONTRACT_REQUIRED_CAPABILITY);
    await expect(issueDelegationContract(contractInput({ limits: { maxChildTickets: 1, maxConcurrent: 1, windowEndsAt: 'not-a-date' } }), { signer: h.signer, now: h.now }))
      .rejects.toThrow(DelegationContractError);
    await expect(issueDelegationContract(contractInput({ limits: { maxChildTickets: 1.5, maxConcurrent: 1, windowEndsAt: WINDOW } }), { signer: h.signer, now: h.now }))
      .rejects.toThrow('positive integer');
    await expect(issueDelegationContract(contractInput({ limits: { maxChildTickets: 2, maxConcurrent: 1, windowEndsAt: new Date(T0.getTime() - 1).toISOString() } }), { signer: h.signer, now: h.now }))
      .rejects.toThrow('in the future');
  });
});

describe('invariant 1 - derivation shortens, never widens', () => {
  it('derives a child inside the contract boundary, bound to the same skill', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    const result = await derive(h, contract.id, { capabilities: ['execute'], vassal: 'pr-helper', reason: 'nightly triage' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation.skill).toBe(contract.skill);
    expect(result.delegation.grantedBy).toBe(contract.grantedBy);
    expect(result.delegation.capabilities).toEqual(['execute']);
    expect(result.delegation.vassal).toBe('pr-helper');
    expect(result.delegation.reason).toContain('nightly triage');
    expect(result.delegation.reason).toContain(contract.id);
  });

  it('refuses a child capability the contract does not cover', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    expect(await derive(h, contract.id, { capabilities: ['execute', 'stripe:charge:refund'] })).toEqual({ ok: false, reason: 'child-capability-not-covered' });
    expect(h.registry.get(contract.id)!.used).toEqual({ childTickets: 0, inFlight: 0 });
  });

  it('never mints a child the dispatch gate could not consume', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer, { capabilities: ['execute', 'github:issue:comment'] });
    // Subset is fine, dropping `execute` is not: the ticket would be inert.
    expect(await derive(h, contract.id, { capabilities: ['github:issue:comment'] })).toEqual({ ok: false, reason: 'child-capability-not-covered' });
    const ok = await derive(h, contract.id, { capabilities: ['execute', 'github:issue:comment'] });
    expect(ok.ok).toBe(true);
  });

  it('honours a vassal-bound contract and refuses another vassal', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer, { vassal: 'pr-helper' });
    expect(await derive(h, contract.id, { capabilities: ['execute'], vassal: 'other-agent' })).toEqual({ ok: false, reason: 'child-vassal-mismatch' });
    const inherited = await derive(h, contract.id, { capabilities: ['execute'] });
    expect(inherited.ok && 'vassal' in inherited.delegation ? inherited.delegation.vassal : undefined).toBe('pr-helper');
  });

  it('cannot outlive the window it came from', async () => {
    const h = harness();
    const windowEndsAt = new Date(T0.getTime() + 60_000).toISOString();
    const contract = await issuedInto(h.registry, h.signer, { limits: { maxChildTickets: 2, maxConcurrent: 2, windowEndsAt } });
    const result = await derive(h, contract.id, { capabilities: ['execute'], ttlMs: 4 * HOUR });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Date.parse(result.delegation.expiresAt)).toBeLessThanOrEqual(Date.parse(windowEndsAt));
  });

  it('still applies the child ticket own TTL ceiling', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    await expect(derive(h, contract.id, { capabilities: ['execute'], ttlMs: 2 * HOUR })).rejects.toThrow(ExecutionDelegationError);
  });
});

describe('invariant 2 - every spend counts, and a refusal spends nothing', () => {
  it('stops at maxChildTickets and leaves the counter where it stopped', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer, { limits: { maxChildTickets: 2, maxConcurrent: 5, windowEndsAt: WINDOW } });
    expect((await derive(h, contract.id)).ok).toBe(true);
    expect((await derive(h, contract.id)).ok).toBe(true);
    expect(await derive(h, contract.id)).toEqual({ ok: false, reason: 'child-ticket-limit-reached' });
    expect(h.registry.get(contract.id)!.used.childTickets).toBe(2);
  });

  it('stops at maxConcurrent while tickets are unreleased, and resumes after release', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer, { limits: { maxChildTickets: 5, maxConcurrent: 1, windowEndsAt: WINDOW } });
    const first = await derive(h, contract.id);
    expect(first.ok).toBe(true);
    expect(await derive(h, contract.id)).toEqual({ ok: false, reason: 'concurrent-limit-reached' });
    if (!first.ok) return;
    expect(h.registry.release(first.delegation.nonce)).toBe(true);
    expect((await derive(h, contract.id)).ok).toBe(true);
    expect(h.registry.get(contract.id)!.used.childTickets).toBe(2);
    expect(h.registry.get(contract.id)!.used.inFlight).toBe(1);
  });

  it('gives the slot back when the ticket was never minted', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    await expect(derive(h, contract.id, { capabilities: ['execute'], ttlMs: 2 * HOUR })).rejects.toThrow(ExecutionDelegationError);
    expect(h.registry.get(contract.id)!.used).toEqual({ childTickets: 0, inFlight: 0 });
    expect((await derive(h, contract.id)).ok).toBe(true);
  });

  it('the derived child is consumable once and refused as replayed the second time', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    const result = await derive(h, contract.id, { capabilities: ['execute'], vassal: 'pr-helper' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ledger = new ExecutionDelegationNonceLedger();
    const context = { verifier: h.verifier, ledger, vassal: 'pr-helper', skill: 'research', capability: DELEGATION_CONTRACT_REQUIRED_CAPABILITY, now: () => T0 };
    expect(await verifyAndConsumeExecutionDelegation(result.delegation, context)).toMatchObject({ ok: true });
    expect(await verifyAndConsumeExecutionDelegation(result.delegation, context)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('runs concurrent derivations against one ticket ceiling', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer, { limits: { maxChildTickets: 1, maxConcurrent: 1, windowEndsAt: WINDOW } });
    const [a, b] = await Promise.all([derive(h, contract.id), derive(h, contract.id)]);
    const okCount = [a, b].filter(result => result.ok).length;
    expect(okCount, 'two concurrent derivations must not both spend a single ticket').toBe(1);
    expect(h.registry.get(contract.id)!.used.childTickets).toBe(1);
  });

  it('leaves the limits untouched by spending', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    const before = structuredClone(contract.limits);
    await derive(h, contract.id);
    expect(h.registry.get(contract.id)!.limits).toEqual(before);
  });
});

describe('invariant 3 - revocation takes effect at once', () => {
  it('refuses derivation after revocation', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    expect(h.registry.revoke(contract.id, T0)).toBe(true);
    expect(await verifyDelegationContract(h.registry.get(contract.id), { verifier: h.verifier, now: h.now })).toEqual({ ok: false, reason: 'revoked' });
    expect(await derive(h, contract.id)).toEqual({ ok: false, reason: 'revoked' });
    expect(h.registry.revoke(contract.id, T0)).toBe(false);
  });

  it('stops deriving once the window ends', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer, { limits: { maxChildTickets: 2, maxConcurrent: 2, windowEndsAt: new Date(T0.getTime() + 60_000).toISOString() } });
    expect((await derive(h, contract.id)).ok).toBe(true);
    const later = new Date(T0.getTime() + 2 * HOUR);
    expect(await verifyDelegationContract(contract, { verifier: h.verifier, now: () => later })).toEqual({ ok: false, reason: 'window-ended' });
    h.now = () => later;
    expect(await derive(h, contract.id)).toEqual({ ok: false, reason: 'window-ended' });
  });
});

describe('invariant 4 and persistence - the contract registry is restorable', () => {
  it('exports and re-imports spent counts, revocation and outstanding tickets', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    const derived = await derive(h, contract.id, { capabilities: ['execute'] });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    h.registry.revoke('not-there');
    const revoked = await issuedInto(h.registry, h.signer, { id: 'contract-b', capabilities: ['execute'] });
    h.registry.revoke(revoked.id, T0);

    const state = h.registry.exportState();
    const restored = new DelegationContractRegistry();
    restored.importState(JSON.parse(JSON.stringify(state)) as typeof state);

    expect(restored.get(contract.id)!.used).toEqual({ childTickets: 1, inFlight: 1 });
    expect(restored.contractOf(derived.delegation.nonce)).toBe(contract.id);
    expect(restored.get(revoked.id)!.revokedAt).toBe(T0.toISOString());
    // A restart must not hand back a spent ceiling.
    const after = new DelegationContractRegistry();
    after.importState(JSON.parse(JSON.stringify(state)) as typeof state);
    const h2 = { ...h, registry: after };
    expect((await derive(h2, contract.id)).ok).toBe(true);
    h2.registry.revoke(contract.id, T0);
    expect(await derive(h2, contract.id)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses to register the same contract id twice and never leaks live state', async () => {
    const h = harness();
    const contract = await issuedInto(h.registry, h.signer);
    await expect(async () => h.registry.add(contract)).rejects.toThrow(DelegationContractError);
    const view = h.registry.get(contract.id)!;
    view.used.childTickets = 99;
    expect(h.registry.get(contract.id)!.used.childTickets).toBe(0);
    expect(h.registry.list()).toHaveLength(1);
  });

  it('does not trust an imported outstanding entry for a contract it never saw', () => {
    const registry = new DelegationContractRegistry();
    registry.importState({ contracts: [], outstanding: [{ nonce: 'n1', contractId: 'ghost' }] });
    expect(registry.contractOf('n1')).toBeUndefined();
    expect(registry.release('n1')).toBe(false);
  });
});

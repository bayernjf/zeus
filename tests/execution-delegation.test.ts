import { describe, expect, it } from 'vitest';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  EXECUTION_DELEGATION_DEFAULT_TTL_MS,
  EXECUTION_DELEGATION_MAX_TTL_MS,
  ExecutionDelegationNonceLedger,
  issueExecutionDelegation,
  verifyAndConsumeExecutionDelegation,
} from '../src/delegation/execution-delegation.js';

const T0 = new Date('2026-09-30T00:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function harness() {
  const signer = new Ed25519MemorySigner('zeus-rsk-dev');
  const verifier = signer.verifier();
  const ledger = new ExecutionDelegationNonceLedger();
  const ctx = (overrides: Partial<Parameters<typeof verifyAndConsumeExecutionDelegation>[1]> = {}) => ({
    verifier,
    ledger,
    vassal: 'pr-helper',
    skill: 'deployment-health',
    capability: 'github:pull-request:merge',
    now: () => T0,
    ...overrides,
  });
  return { signer, verifier, ledger, ctx };
}

describe('deferred #33 one-time execution delegation primitive', () => {
  it('issues a signed, capability-bound delegation that verifies once', async () => {
    const { signer, ctx } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'operator@zeus', skill: 'deployment-health', vassal: 'pr-helper', capabilities: ['github:pull-request:merge'] },
      { signer, now: () => T0 },
    );
    expect(d.kind).toBe('zeus-execution-delegation');
    expect(d.nonce).toBeTruthy();
    expect(d.sig).toBeTruthy();
    expect(Date.parse(d.expiresAt) - Date.parse(d.issuedAt)).toBe(EXECUTION_DELEGATION_DEFAULT_TTL_MS);

    const first = await verifyAndConsumeExecutionDelegation(d, ctx());
    expect(first).toEqual({ ok: true, nonce: d.nonce });
    // Single-use: the same signed delegation cannot authorize a second write.
    const replay = await verifyAndConsumeExecutionDelegation(d, ctx());
    expect(replay).toEqual({ ok: false, reason: 'replayed' });
  });

  it('refuses missing delegation fail-closed (no authorization -> no external write)', async () => {
    const { ctx } = harness();
    expect(await verifyAndConsumeExecutionDelegation(undefined, ctx())).toEqual({ ok: false, reason: 'missing' });
  });

  it('binds vassal, skill and capability; a mismatch is refused before consuming the nonce', async () => {
    const { signer, ctx, ledger } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', vassal: 'pr-helper', capabilities: ['github:pull-request:merge'] },
      { signer, now: () => T0 },
    );
    expect(await verifyAndConsumeExecutionDelegation(d, ctx({ vassal: 'loom' }))).toEqual({ ok: false, reason: 'wrong-vassal' });
    expect(await verifyAndConsumeExecutionDelegation(d, ctx({ skill: 'other-skill' }))).toEqual({ ok: false, reason: 'wrong-skill' });
    expect(await verifyAndConsumeExecutionDelegation(d, ctx({ capability: 'github:repo:delete' }))).toEqual({
      ok: false,
      reason: 'capability-not-covered',
    });
    // A binding failure must not burn the nonce: the legitimate branch still works.
    expect(ledger.size).toBe(0);
    expect((await verifyAndConsumeExecutionDelegation(d, ctx())).ok).toBe(true);
  });

  it('rejects a tampered signature and an untrusted key id', async () => {
    const { signer, ctx } = harness();
    const attacker = new Ed25519MemorySigner('attacker-key');
    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', capabilities: ['github:pull-request:merge'] },
      { signer, now: () => T0 },
    );
    // Tamper a signature-covered field that does not change the binding check,
    // so the failure must surface at the cryptographic step, not earlier.
    const forged = { ...d, grantedBy: 'attacker' };
    expect(await verifyAndConsumeExecutionDelegation(forged as typeof d, ctx())).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await verifyAndConsumeExecutionDelegation(d, ctx({ acceptedKeyIds: ['a-different-key'] }))).toEqual({
      ok: false,
      reason: 'unknown-key',
    });
    // A delegation signed by an untrusted key verifies false.
    const evil = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', capabilities: ['github:pull-request:merge'] },
      { signer: attacker, now: () => T0 },
    );
    expect(await verifyAndConsumeExecutionDelegation(evil, ctx())).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('expires after ttl and refuses an over-long or malformed issuance', async () => {
    const { signer, ctx } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', capabilities: ['x'], ttlMs: 1000 },
      { signer, now: () => T0 },
    );
    expect(await verifyAndConsumeExecutionDelegation(d, ctx({ now: () => at(999), capability: 'x' }))).toMatchObject({ ok: true });
    const fresh = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', capabilities: ['x'], ttlMs: 1000 },
      { signer, now: () => T0 },
    );
    expect(await verifyAndConsumeExecutionDelegation(fresh, ctx({ now: () => at(1001), capability: 'x' }))).toEqual({ ok: false, reason: 'expired' });

    await expect(
      issueExecutionDelegation(
        { grantedBy: 'op', skill: 's', capabilities: ['x'], ttlMs: EXECUTION_DELEGATION_MAX_TTL_MS + 1 },
        { signer, now: () => T0 },
      ),
    ).rejects.toThrow(/ceiling/);
    await expect(
      issueExecutionDelegation({ grantedBy: 'op', skill: 's', capabilities: ['x'], ttlMs: 0 }, { signer, now: () => T0 }),
    ).rejects.toThrow(/positive/);
  });

  it('rejects malformed issuance inputs and malformed delegation payloads', async () => {
    const { signer, ctx } = harness();
    await expect(issueExecutionDelegation({ grantedBy: '', skill: 's', capabilities: ['x'] }, { signer })).rejects.toThrow(/grantedBy/);
    await expect(issueExecutionDelegation({ grantedBy: 'op', skill: '', capabilities: ['x'] }, { signer })).rejects.toThrow(/skill/);
    await expect(issueExecutionDelegation({ grantedBy: 'op', skill: 's', capabilities: [] }, { signer })).rejects.toThrow(/capabilit/);

    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 's', capabilities: ['x', 'x', ' y '] },
      { signer, now: () => T0 },
    );
    // Capabilities are trimmed, deduped and sorted deterministically.
    expect(d.capabilities).toEqual(['x', 'y']);

    const bad = { ...d, version: 9 } as unknown as Parameters<typeof verifyAndConsumeExecutionDelegation>[0];
    expect(await verifyAndConsumeExecutionDelegation(bad, ctx({ skill: 's', capability: 'x' }))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('deduplicates capabilities and a vassal-less delegation is consumed by the first eligible branch only', async () => {
    const { signer, ctx } = harness();
    const d = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'deployment-health', capabilities: ['github:pull-request:merge'], nonce: 'fixed-nonce' },
      { signer, now: () => T0 },
    );
    expect(d.vassal).toBeUndefined();
    expect(d.nonce).toBe('fixed-nonce');
    expect((await verifyAndConsumeExecutionDelegation(d, ctx())).ok).toBe(true);
    // A second vassal in the same fan-out cannot reuse it even without vassal binding.
    expect(await verifyAndConsumeExecutionDelegation(d, ctx({ vassal: 'loom' }))).toEqual({ ok: false, reason: 'replayed' });
  });

  it('persists and restores the consumed-nonce ledger across a restart', () => {
    const ledger = new ExecutionDelegationNonceLedger();
    expect(ledger.consume('n1')).toBe(true);
    expect(ledger.consume('n2')).toBe(true);
    const restored = new ExecutionDelegationNonceLedger();
    restored.importState(ledger.exportState());
    expect(restored.isSpent('n1')).toBe(true);
    expect(restored.consume('n2')).toBe(false);
    expect(restored.size).toBe(2);
  });
});

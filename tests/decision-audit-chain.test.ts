import { describe, expect, it } from 'vitest';
import { Ed25519MemorySigner } from '../src/core/signing.js';
import {
  DecisionAuditChain,
  DecisionAuditValidationError,
  auditEntryHash,
  auditSigningText,
  validateAuditEntry,
  validateAuditPayload,
  verifyDecisionAuditChain,
  type DecisionAuditChainVerifier,
} from '../src/core/audit/audit-chain.js';
import { AUDIT_GENESIS, type DecisionAuditEntry } from '../src/core/audit/types.js';

const KEY_ID = 'audit-test-v1';
const FIXED_AT = '2026-10-22T08:00:00.000Z';

function signer(keyId = KEY_ID): Ed25519MemorySigner {
  return new Ed25519MemorySigner(keyId);
}
function verifierFor(s: Ed25519MemorySigner): DecisionAuditChainVerifier {
  return s.verifier();
}

async function buildChain(
  count: number,
  s: Ed25519MemorySigner = signer(),
): Promise<{ chain: DecisionAuditChain; entries: DecisionAuditEntry[] }> {
  const chain = new DecisionAuditChain(s, () => FIXED_AT);
  for (let i = 0; i < count; i += 1) {
    await chain.append({
      kind: 'decision.created',
      decisionId: `dec-${i}`,
      ...(i % 2 === 0 ? { actor: 'tester' } : {}),
      data: { grade: i % 2 === 0 ? 'D2' : 'D0', ruleId: 'r1', index: i },
    });
  }
  return { chain, entries: [...chain.list()] };
}

function cloneEntry(entry: DecisionAuditEntry | undefined): DecisionAuditEntry {
  return JSON.parse(JSON.stringify(entry)) as DecisionAuditEntry;
}

describe('decision audit chain (ADR-04, per-record sealing)', () => {
  it('empty chain verifies with count 0', async () => {
    const s = signer();
    const chain = new DecisionAuditChain(s);
    const result = await verifyDecisionAuditChain(chain.list(), verifierFor(s));
    expect(result).toEqual({ ok: true, count: 0 });
    expect(chain.headHash()).toBe(AUDIT_GENESIS);
  });

  it('seals contiguous seq with genesis prevHash and chained hashes', async () => {
    const { chain, entries } = await buildChain(3);
    expect(entries.map(e => e.seq)).toEqual([0, 1, 2]);
    expect(entries[0]?.prevHash).toBe(AUDIT_GENESIS);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect(entries[2]?.prevHash).toBe(entries[1]?.hash);
    expect(entries[0]?.keyId).toBe(KEY_ID);
    expect(entries[0]?.payload.at).toBe(FIXED_AT);
    const hashes = new Set(entries.map(e => e.hash));
    expect(hashes.size).toBe(3);
    expect(entries.every(e => e.signature.length > 20)).toBe(true);
    expect(chain.headHash()).toBe(entries[2]?.hash);
  });

  it('verifies a healthy chain', async () => {
    const s = signer();
    const { entries } = await buildChain(3, s);
    const result = await verifyDecisionAuditChain(entries, verifierFor(s));
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it('fails when payload.data is tampered at seq 1', async () => {
    const s = signer();
    const { entries } = await buildChain(3, s);
    const tampered = entries.map(cloneEntry);
    (tampered[1] as DecisionAuditEntry).payload.data = { grade: 'D3' };
    const result = await verifyDecisionAuditChain(tampered, verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.seq).toBe(1);
      expect(result.reason).toMatch(/hash mismatch/);
    }
  });

  it('fails when payload.kind is tampered', async () => {
    const s = signer();
    const { entries } = await buildChain(2, s);
    const tampered = entries.map(cloneEntry);
    (tampered[0] as DecisionAuditEntry).payload.kind = 'decision.completed';
    const result = await verifyDecisionAuditChain(tampered, verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.seq).toBe(0);
  });

  it('fails when the stored hash field alone is altered', async () => {
    const s = signer();
    const { entries } = await buildChain(2, s);
    const tampered = entries.map(cloneEntry);
    (tampered[0] as DecisionAuditEntry).hash = 'sha256:0000000000000000';
    const result = await verifyDecisionAuditChain(tampered, verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.seq).toBe(0);
      expect(result.reason).toMatch(/hash mismatch|prevHash/);
    }
  });

  it('fails when signature is forged (payload re-hashed but unsigned)', async () => {
    const s = signer();
    const { entries } = await buildChain(2, s);
    const tampered = entries.map(cloneEntry);
    const e = tampered[1] as DecisionAuditEntry;
    // Attacker can recompute the hash but holds no private key, so they
    // keep the signature from the original record.
    e.payload.data = { grade: 'D3', injected: true };
    e.hash = auditEntryHash({ seq: e.seq, prevHash: e.prevHash, keyId: e.keyId, payload: e.payload });
    const result = await verifyDecisionAuditChain(tampered, verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.seq).toBe(1);
      expect(result.reason).toMatch(/signature/);
    }
  });

  it('fails when an entry is deleted from the middle', async () => {
    const s = signer();
    const { entries } = await buildChain(3, s);
    const gapped = [entries[0], entries[2]].map(cloneEntry) as DecisionAuditEntry[];
    const result = await verifyDecisionAuditChain(gapped, verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.seq).toBe(1);
      expect(result.reason).toMatch(/seq discontinuity/);
    }
  });

  it('fails when entries are reordered', async () => {
    const s = signer();
    const { entries } = await buildChain(3, s);
    const swapped = [entries[1], entries[0], entries[2]].map(cloneEntry) as DecisionAuditEntry[];
    const result = await verifyDecisionAuditChain(swapped, verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.seq).toBe(0);
  });

  it('fails when prevHash is altered', async () => {
    const s = signer();
    const { entries } = await buildChain(2, s);
    const tampered = entries.map(cloneEntry);
    (tampered[1] as DecisionAuditEntry).prevHash = AUDIT_GENESIS;
    const result = await verifyDecisionAuditChain(tampered, verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.seq).toBe(1);
      expect(result.reason).toMatch(/prevHash/);
    }
  });

  it('fails when an unsigned entry is appended at the tail', async () => {
    const s = signer();
    const { entries } = await buildChain(2, s);
    const forged = cloneEntry(entries[1] as DecisionAuditEntry);
    forged.seq = 2;
    forged.prevHash = (entries[1] as DecisionAuditEntry).hash;
    forged.payload = { kind: 'decision.completed', at: FIXED_AT, decisionId: 'dec-99', data: {} };
    forged.hash = auditEntryHash({ seq: 2, prevHash: forged.prevHash, keyId: forged.keyId, payload: forged.payload });
    forged.signature = 'Zm9yZ2Vk';
    const result = await verifyDecisionAuditChain([...entries.map(cloneEntry), forged], verifierFor(s));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.seq).toBe(2);
      expect(result.reason).toMatch(/signature/);
    }
  });

  it('fails when the verifier does not hold the sealing key', async () => {
    const s = signer();
    const stranger = signer('audit-stranger');
    const { entries } = await buildChain(2, s);
    const result = await verifyDecisionAuditChain(entries, stranger.verifier());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.seq).toBe(0);
      expect(result.reason).toContain(KEY_ID);
    }
  });

  it('accepts a key rotation set when both verifiers are registered', async () => {
    const s1 = signer('audit-key-1');
    const s2 = signer('audit-key-2');
    const chain = DecisionAuditChain.hydrate(s1, []);
    const e0 = await chain.append({ kind: 'decision.created', data: { grade: 'D0' } });
    // Rotate: hydrate with signer 2 starting from the existing entry.
    const chain2 = DecisionAuditChain.hydrate(s2, [e0]);
    const e1 = await chain2.append({ kind: 'policy.updated', data: { version: 2 } });
    const multiVerifier = s1.verifier([s2.keyId, s2.publicKey]);
    const result = await verifyDecisionAuditChain([e0, e1], multiVerifier);
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it('hydrated chain continues seq and linkage from persisted entries', async () => {
    const s = signer();
    const { entries } = await buildChain(3, s);
    const restored = DecisionAuditChain.hydrate(s, entries.map(cloneEntry), () => FIXED_AT);
    const next = await restored.append({ kind: 'decision.completed', decisionId: 'dec-3', data: { result: 'ok' } });
    expect(next.seq).toBe(3);
    expect(next.prevHash).toBe(entries[2]?.hash);
    const result = await verifyDecisionAuditChain([...entries.map(cloneEntry), next], verifierFor(s));
    expect(result).toEqual({ ok: true, count: 4 });
  });

  it('applies the injected clock and omits optional fields', async () => {
    const s = signer();
    const chain = new DecisionAuditChain(s, () => '2030-01-01T00:00:00.000Z');
    const entry = await chain.append({ kind: 'decision.failed', data: { reason: 'x' } });
    expect(entry.payload.at).toBe('2030-01-01T00:00:00.000Z');
    expect(entry.payload.decisionId).toBeUndefined();
    expect(entry.payload.actor).toBeUndefined();
  });

  it('defaults missing data to an empty object', async () => {
    const s = signer();
    const chain = new DecisionAuditChain(s);
    const entry = await chain.append({ kind: 'decision.timed-out', data: undefined as unknown as Record<string, unknown> });
    expect(entry.payload.data).toEqual({});
  });

  it('rejects malformed payloads with a ValidationError listing issues', async () => {
    const s = signer();
    const chain = new DecisionAuditChain(s);
    await expect(
      chain.append({ kind: 'nope' as unknown as 'decision.created', data: {} }),
    ).rejects.toBeInstanceOf(DecisionAuditValidationError);
  });

  it('validateAuditPayload reports every issue', () => {
    const issues = validateAuditPayload({ kind: 'bad', at: '', data: [], rogue: 1 });
    expect(issues.join('\n')).toMatch(/kind/);
    expect(issues.join('\n')).toMatch(/at/);
    expect(issues.join('\n')).toMatch(/data/);
    expect(issues.join('\n')).toMatch(/rogue/);
  });

  it('validateAuditEntry rejects broken envelopes and unknown fields', () => {
    expect(validateAuditEntry(null).join('\n')).toMatch(/object/);
    expect(
      validateAuditEntry({
        seq: -1,
        prevHash: '',
        keyId: '',
        payload: { kind: 'decision.created', at: 't', data: {} },
        hash: 'nope',
        signature: '',
      }).join('\n'),
    ).toMatch(/seq|prevHash|keyId|hash|signature/);
    const issues = validateAuditEntry({
      seq: 0,
      prevHash: AUDIT_GENESIS,
      keyId: 'k',
      payload: { kind: 'decision.created', at: 't', data: {} },
      hash: 'sha256:abc',
      signature: 'sig',
      extra: 1,
    });
    expect(issues.join('\n')).toMatch(/extra/);
  });

  it('hash and signing text are stable JCS canonical forms', async () => {
    const s = signer();
    const { entries } = await buildChain(1, s);
    const e0 = entries[0] as DecisionAuditEntry;
    const doc = { seq: e0.seq, prevHash: e0.prevHash, keyId: e0.keyId, payload: e0.payload };
    // same content, reordered source keys, must hash identically
    const reordered = { payload: e0.payload, keyId: e0.keyId, prevHash: e0.prevHash, seq: e0.seq };
    expect(auditEntryHash(reordered)).toBe(e0.hash);
    expect(auditSigningText(doc)).toBe(auditSigningText(reordered));
  });
});

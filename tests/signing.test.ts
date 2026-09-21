import { describe, expect, it } from 'vitest';
import { VassalRegistry } from '../src/registry/registry.js';
import { projectPublicRoster } from '../src/registry/roster.js';
import {
  attestationMatchesCard,
  canonicalDigest,
  canonicalJson,
  createAttestation,
  digestCard,
  Ed25519MemorySigner,
  Ed25519Verifier,
  sealSnapshot,
  verifySignedSnapshot,
  type AttestationSource,
  type SignedRosterSnapshot,
} from '../src/registry/signing.js';
import type { AgentCard } from '../src/a2a/types.js';

// --- JCS subset vectors -------------------------------------------------------

describe('canonicalJson (RFC 8785 JCS subset)', () => {
  it('sorts object keys by UTF-16 code unit and strips whitespace', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ z: { y: 2, x: 1 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"z":{"x":1,"y":2}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes numbers per ECMAScript shortest form, including -0 and large integers', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson(1.0)).toBe('1');
    expect(canonicalJson(1e20)).toBe('100000000000000000000');
    expect(canonicalJson(0.0000001)).toBe('1e-7');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite/);
  });

  it('leaves printable CJK text unescaped and escapes control characters', () => {
    expect(canonicalJson({ note: '中文封臣' })).toBe('{"note":"中文封臣"}');
    expect(canonicalJson('a\nb')).toBe('"a\\nb"');
  });

  it('is stable across different insertion order and source formatting (acceptance §8.1 #8)', () => {
    const one = JSON.parse('{"name":"loom","version":"0.1.0","skills":[]}');
    const two = JSON.parse('{\n  "skills": [],\n  "version": "0.1.0",\n  "name": "loom"\n}');
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('refuses non-JSON values (undefined/function/bigint)', () => {
    expect(() => canonicalJson(undefined)).toThrow(/cannot canonicalize/);
    expect(() => canonicalJson(1n)).toThrow(/cannot canonicalize/);
  });
});

describe('digestCard', () => {
  function card(): AgentCard {
    return {
      name: 'pr-helper',
      url: 'http://x/api/a2a/tasks',
      skills: [{ id: 'create-pr', name: 'Create PR', description: '', tags: [] }],
      'x-zeus-fealty': {
        version: '1',
        swornTo: 'zeus',
        domain: 'pr-release-control',
        dataRealms: ['enterprise'],
        dataPolicy: 'read-task-scope',
        reportBack: true,
        escalationPolicy: 'auto',
        sla: { ackSeconds: 5 },
      },
    };
  }

  it('digests the whole card and the fealty block separately', () => {
    const { cardDigest, fealtyDigest } = digestCard(card());
    expect(cardDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fealtyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cardDigest).not.toBe(fealtyDigest);
  });

  it('changes cardDigest when skills change but keeps fealtyDigest stable', () => {
    const base = digestCard(card());
    const changed = card();
    changed.skills.push({ id: 'merge-pr', name: 'Merge', description: '', tags: [] });
    const after = digestCard(changed);
    expect(after.cardDigest).not.toBe(base.cardDigest);
    expect(after.fealtyDigest).toBe(base.fealtyDigest);
  });

  it('changes fealtyDigest when any commitment field changes', () => {
    const base = digestCard(card());
    const changed = card();
    changed['x-zeus-fealty']!.dataPolicy = 'none';
    expect(digestCard(changed).fealtyDigest).not.toBe(base.fealtyDigest);
  });
});

// --- §8.1 acceptance cases ----------------------------------------------------

function loomCard(): AgentCard {
  return {
    name: 'loom',
    url: 'http://loom.test/api/a2a/tasks',
    version: '0.1.0',
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'generate-content', name: 'Plan content generation', description: 'plan only', tags: ['plan-only'] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'content-production',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
      sla: { ackSeconds: 10 },
    },
  };
}

function prHelperCard(): AgentCard {
  return {
    name: 'pr-helper',
    url: 'http://pr.test/api/a2a/tasks',
    skills: [{ id: 'create-pr', name: 'Create pull request', description: 'drafts PRs', tags: ['github'] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'pr-release-control',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
      sla: { ackSeconds: 5 },
    },
  };
}

async function buildSignedFixture(now: Date, signer: Ed25519MemorySigner, maxAgeSeconds = 3600, attestationTtlSeconds = 86400) {
  const cards: Record<string, AgentCard> = { loom: loomCard(), 'pr-helper': prHelperCard() };
  const registry = new VassalRegistry(async url => {
    const name = url.includes('loom') ? 'loom' : 'pr-helper';
    return new Response(JSON.stringify(cards[name]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await registry.register('http://loom.test/api/a2a/agent-card');
  await registry.register('http://pr.test/api/a2a/agent-card');

  const snapshot = projectPublicRoster(registry.listAll(), () => now);
  const sources: AttestationSource[] = registry
    .listAll()
    .filter(e => !e.revoked)
    .map(e => ({ name: e.card.name, card: e.card, cardUrl: e.cardUrl }));
  const envelope = await sealSnapshot(snapshot, signer, { now, maxAgeSeconds, attestationTtlSeconds, sources });
  return { envelope, cards, sources };
}

const T0 = new Date('2026-09-21T10:00:00.000Z');

describe('signed roster snapshot — design-fealty-signing §8.1', () => {
  it('#1 signs and verifies a snapshot and returns the original snapshot', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const { envelope } = await buildSignedFixture(T0, signer);
    const result = await verifySignedSnapshot(envelope, signer.verifier(), T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.scope).toBe('public');
    expect(result.snapshot.entries.map(e => e.name).sort()).toEqual(['loom', 'pr-helper']);
  });

  it('#2 fails deep verification when a fealty field is tampered on the card', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const { envelope, cards } = await buildSignedFixture(T0, signer);
    const attestation = envelope.attestations.loom;

    const tampered = structuredClone(cards.loom);
    tampered['x-zeus-fealty']!.dataPolicy = 'write';
    expect(attestationMatchesCard(attestation, tampered)).toBe(false);
    expect(attestationMatchesCard(attestation, cards.loom)).toBe(true);

    // tampering with the projected commitments inside the snapshot breaks the seal
    const edited = structuredClone(envelope);
    (edited.snapshot.entries[0].commitments as { dataPolicy?: string }).dataPolicy = 'write';
    const result = await verifySignedSnapshot(edited, signer.verifier(), T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/snapshotDigest mismatch/);
  });

  it('#3 fails deep verification when skills / description / name are tampered', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const { envelope, cards } = await buildSignedFixture(T0, signer);
    const attestation = envelope.attestations['pr-helper'];

    const skillTampered = structuredClone(cards['pr-helper']);
    skillTampered.skills[0].id = 'backdoor';
    expect(attestationMatchesCard(attestation, skillTampered)).toBe(false);

    const descTampered = structuredClone(cards['pr-helper']);
    descTampered.description = 'changed';
    expect(attestationMatchesCard(attestation, descTampered)).toBe(false);
  });

  it('#4 fails the seal when entries are added/removed/reordered or scope/generatedAt edited', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const { envelope } = await buildSignedFixture(T0, signer);

    const removed = structuredClone(envelope);
    removed.snapshot.entries.pop();
    expect((await verifySignedSnapshot(removed, signer.verifier(), T0)).ok).toBe(false);

    const reordered = structuredClone(envelope);
    reordered.snapshot.entries.reverse();
    const reorderedResult = await verifySignedSnapshot(reordered, signer.verifier(), T0);
    expect(reorderedResult.ok).toBe(false);

    const scopeChanged = structuredClone(envelope);
    scopeChanged.snapshot.scope = 'internal';
    expect((await verifySignedSnapshot(scopeChanged, signer.verifier(), T0)).ok).toBe(false);

    const timeChanged = structuredClone(envelope);
    timeChanged.snapshot.generatedAt = '2030-01-01T00:00:00.000Z';
    expect((await verifySignedSnapshot(timeChanged, signer.verifier(), T0)).ok).toBe(false);

    // attacker recomputes the digest but cannot re-sign: signature must fail
    const reDigested = structuredClone(envelope) as SignedRosterSnapshot;
    reDigested.snapshot.entries.pop();
    reDigested.seal.snapshotDigest = canonicalDigest(reDigested.snapshot);
    const reDigestResult = await verifySignedSnapshot(reDigested, signer.verifier(), T0);
    expect(reDigestResult.ok).toBe(false);
    if (reDigestResult.ok) return;
    expect(reDigestResult.reason).toMatch(/seal signature verification failed/);
  });

  it('#5 rejects expired attestations and over-age seals (T3/T4 replay)', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    // long seal age, short per-entry TTL so attestation hard-expiry is exercised first
    const { envelope: attExpired } = await buildSignedFixture(T0, signer, 48 * 3600, 3600);
    const attResult = await verifySignedSnapshot(attExpired, signer.verifier(), new Date(T0.getTime() + 2 * 3600 * 1000));
    expect(attResult.ok).toBe(false);
    if (attResult.ok) return;
    expect(attResult.reason).toMatch(/expired/);

    const { envelope: sealExpired } = await buildSignedFixture(T0, signer, 3600, 86400);
    const sealResult = await verifySignedSnapshot(sealExpired, signer.verifier(), new Date(T0.getTime() + 2 * 3600 * 1000));
    expect(sealResult.ok).toBe(false);
    if (sealResult.ok) return;
    expect(sealResult.reason).toMatch(/maxAge/);
  });

  it('#6 rejects a tampered signature or a verifier holding the wrong key', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const { envelope } = await buildSignedFixture(T0, signer);

    const tamperedSig = structuredClone(envelope);
    // flip the FIRST base64url char: the final char encodes padding-zero bits and
    // changing it can leave the decoded 64-byte signature untouched
    tamperedSig.seal.sig = (tamperedSig.seal.sig.startsWith('A') ? 'B' : 'A') + tamperedSig.seal.sig.slice(1);
    expect((await verifySignedSnapshot(tamperedSig, signer.verifier(), T0)).ok).toBe(false);

    const stranger = new Ed25519MemorySigner('zeus-rsk-other');
    expect((await verifySignedSnapshot(envelope, stranger.verifier(), T0)).ok).toBe(false);

    const emptyVerifier = new Ed25519Verifier();
    expect((await verifySignedSnapshot(envelope, emptyVerifier, T0)).ok).toBe(false);
  });

  it('#7 handles key rotation overlap: old key verifies history, new key verifies fresh, over-age old envelopes refused', async () => {
    const oldSigner = new Ed25519MemorySigner('zeus-rsk-2026-08');
    const newSigner = new Ed25519MemorySigner('zeus-rsk-2026-09');
    // both keys trusted during the rotation overlap
    const overlapVerifier = newSigner.verifier([oldSigner.keyId, oldSigner.publicKey]);

    // historical envelope signed 2h ago with the old key, still within maxAge
    const past = new Date(T0.getTime() - 2 * 3600 * 1000);
    const historical = await buildSignedFixture(past, oldSigner, 48 * 3600, 48 * 3600);
    expect((await verifySignedSnapshot(historical.envelope, overlapVerifier, T0)).ok).toBe(true);

    // same old envelope but with a 1h maxAge is refused as stale even with the key present
    const stale = await buildSignedFixture(past, oldSigner, 3600, 48 * 3600);
    const staleResult = await verifySignedSnapshot(stale.envelope, overlapVerifier, T0);
    expect(staleResult.ok).toBe(false);
    if (staleResult.ok) return;
    expect(staleResult.reason).toMatch(/maxAge/);

    // fresh envelope signed by the new key verifies
    const fresh = await buildSignedFixture(T0, newSigner);
    expect((await verifySignedSnapshot(fresh.envelope, overlapVerifier, T0)).ok).toBe(true);

    // a verifier with only the new key cannot validate the old-key envelope
    const newOnly = newSigner.verifier();
    expect((await verifySignedSnapshot(historical.envelope, newOnly, T0)).ok).toBe(false);
  });

  it('refuses a snapshot entry without an attestation', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const { envelope } = await buildSignedFixture(T0, signer);
    delete envelope.attestations.loom;
    const result = await verifySignedSnapshot(envelope, signer.verifier(), T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing attestation/);
  });
});

describe('createAttestation', () => {
  it('binds the vassal name and card url with active status and a TTL window', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const card = loomCard();
    const attestation = await createAttestation(
      { name: 'loom', card, cardUrl: 'http://loom.test/api/a2a/agent-card' },
      signer,
      { now: T0, ttlSeconds: 3600 }
    );
    expect(attestation).toMatchObject({
      v: 1,
      alg: 'Ed25519',
      issuer: 'zeus',
      status: 'active',
      keyId: 'zeus-rsk-2026-09',
    });
    expect(attestation.vassal).toEqual({ name: 'loom', cardUrl: 'http://loom.test/api/a2a/agent-card' });
    expect(attestation.issuedAt).toBe('2026-09-21T10:00:00.000Z');
    expect(attestation.expiresAt).toBe('2026-09-21T11:00:00.000Z');
    expect(attestation.sig).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(attestationMatchesCard(attestation, card)).toBe(true);
  });
});

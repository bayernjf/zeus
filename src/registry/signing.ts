import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { AgentCard } from '../a2a/types.js';
import type { RosterSnapshot } from './roster.js';
import { sha256Hex } from '../util/crypto.js';

/**
 * fealty signing chain v1 — pure functions per docs/design-fealty-signing.md.
 *
 * Two-layer envelope:
 *   - per-entry Attestation (cardDigest + fealtyDigest + status + TTL),
 *   - snapshot Seal (snapshotDigest + maxAge) wrapping the existing RosterSnapshot.
 *
 * Canonicalization is a self-contained RFC 8785 (JCS) subset: UTF-8, object keys
 * sorted by UTF-16 code unit, no whitespace, ECMAScript number serialization with
 * finite-number rejection. It covers every shape Agent Cards/fealties actually
 * take (strings, booleans, integers, arrays, nested objects, CJK text). If cards
 * ever carry extreme-magnitude/special floats, swap canonicalJson for a full JCS
 * library — it is the only function that would change.
 */

// --- canonicalization (RFC 8785 JCS subset) ----------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite numbers cannot be canonicalized');
    // JSON.stringify already applies the ECMAScript shortest-round-trip rule and
    // renders -0 as "0"; JCS adopts the same Number serialization for our range.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Default sort compares by UTF-16 code unit, exactly what JCS mandates.
    const keys = Object.keys(record).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`JCS: cannot canonicalize value of type ${typeof value}`);
}

/** `"sha256:" + hex(sha256(JCS(value)))`. */
export function canonicalDigest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function digestCard(card: AgentCard): { cardDigest: string; fealtyDigest?: string } {
  const fealty = card['x-zeus-fealty'];
  return {
    cardDigest: canonicalDigest(card),
    ...(fealty ? { fealtyDigest: canonicalDigest(fealty) } : {}),
  };
}

// --- key boundary -------------------------------------------------------------

export interface RosterSigner {
  readonly keyId: string;
  /** Sign canonical text, return a base64url (unpadded) Ed25519 signature. */
  sign(canonicalText: string): Promise<string>;
}

export interface RosterVerifier {
  /** Verify a base64url Ed25519 signature against canonical text for a keyId. */
  verify(keyId: string, canonicalText: string, signatureBase64Url: string): Promise<boolean>;
}

/** In-memory Ed25519 signer. For tests and wiring only; production RSK storage
 *  (key chain / KMS) is injected as another RosterSigner at deployment time. */
export class Ed25519MemorySigner implements RosterSigner {
  readonly keyId: string;
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(keyId: string, privateKey?: KeyObject, publicKey?: KeyObject) {
    this.keyId = keyId;
    if (privateKey && publicKey) {
      this.privateKey = privateKey;
      this.publicKey = publicKey;
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
  }

  async sign(canonicalText: string): Promise<string> {
    // Ed25519 is PureEdDSA: algorithm must be null in the functional crypto API.
    return cryptoSign(null, Buffer.from(canonicalText, 'utf8'), this.privateKey).toString('base64url');
  }

  verifier(...additional: Array<[string, KeyObject]>): Ed25519Verifier {
    return new Ed25519Verifier([[this.keyId, this.publicKey], ...additional]);
  }
}

export class Ed25519Verifier implements RosterVerifier {
  private readonly keys = new Map<string, KeyObject>();

  constructor(keys: Array<[string, KeyObject]> = []) {
    for (const [keyId, key] of keys) this.keys.set(keyId, key);
  }

  addKey(keyId: string, key: KeyObject): void {
    this.keys.set(keyId, key);
  }

  async verify(keyId: string, canonicalText: string, signatureBase64Url: string): Promise<boolean> {
    const key = this.keys.get(keyId);
    if (!key) return false;
    try {
      return cryptoVerify(null, Buffer.from(canonicalText, 'utf8'), key, Buffer.from(signatureBase64Url, 'base64url'));
    } catch {
      return false;
    }
  }
}

// --- envelope -----------------------------------------------------------------

const ALG = 'Ed25519' as const;
const ENVELOPE_VERSION = 1 as const;
const ISSUER = 'zeus' as const;
/** Small tolerance for clock skew when rejecting future-dated signatures (ms). */
const CLOCK_SKEW_MS = 60_000;

export type Attestation = {
  v: 1;
  alg: 'Ed25519';
  keyId: string;
  issuer: 'zeus';
  vassal: { name: string; cardUrl: string };
  cardDigest: string;
  fealtyDigest?: string;
  status: 'active';
  issuedAt: string;
  expiresAt: string;
  sig: string;
};

export type Seal = {
  v: 1;
  alg: 'Ed25519';
  keyId: string;
  snapshotDigest: string;
  issuedAt: string;
  maxAgeSeconds: number;
  sig: string;
};

export type SignedRosterSnapshot = {
  snapshot: RosterSnapshot;
  attestations: Record<string, Attestation>;
  seal: Seal;
};

export type AttestationSource = { name: string; card: AgentCard; cardUrl: string };

function iso(date: Date): string {
  return date.toISOString();
}

export async function createAttestation(
  source: AttestationSource,
  signer: RosterSigner,
  options: { now: Date; ttlSeconds: number }
): Promise<Attestation> {
  const { cardDigest, fealtyDigest } = digestCard(source.card);
  const issuedAt = iso(options.now);
  const expiresAt = iso(new Date(options.now.getTime() + options.ttlSeconds * 1000));
  const unsigned = {
    v: ENVELOPE_VERSION,
    alg: ALG,
    keyId: signer.keyId,
    issuer: ISSUER,
    vassal: { name: source.name, cardUrl: source.cardUrl },
    cardDigest,
    ...(fealtyDigest ? { fealtyDigest } : {}),
    status: 'active' as const,
    issuedAt,
    expiresAt,
  };
  const sig = await signer.sign(canonicalJson(unsigned));
  return { ...unsigned, sig };
}

export type SealOptions = {
  now: Date;
  maxAgeSeconds: number;
  /** Entry cards to attest; every snapshot entry must have a matching source on a public seal. */
  sources?: AttestationSource[];
  /** Per-entry attestation TTL (hard expiry), seconds. */
  attestationTtlSeconds?: number;
};

export async function sealSnapshot(
  snapshot: RosterSnapshot,
  signer: RosterSigner,
  options: SealOptions
): Promise<SignedRosterSnapshot> {
  const attestations: Record<string, Attestation> = {};
  if (options.sources) {
    const ttlSeconds = options.attestationTtlSeconds ?? 24 * 3600;
    for (const source of options.sources) {
      // Only attest names actually present in this snapshot (public snapshots
      // already exclude revoked entries at the projector).
      if (snapshot.entries.some(entry => entry.name === source.name)) {
        attestations[source.name] = await createAttestation(source, signer, { now: options.now, ttlSeconds });
      }
    }
  }

  const issuedAt = iso(options.now);
  const unsignedSeal = {
    v: ENVELOPE_VERSION,
    alg: ALG,
    keyId: signer.keyId,
    snapshotDigest: canonicalDigest(snapshot),
    issuedAt,
    maxAgeSeconds: options.maxAgeSeconds,
  };
  const seal: Seal = { ...unsignedSeal, sig: await signer.sign(canonicalJson(unsignedSeal)) };

  return { snapshot, attestations, seal };
}

function stripSig(value: Record<string, unknown>): Record<string, unknown> {
  const { sig: _sig, ...unsigned } = value;
  return unsigned;
}

export type VerifyResult = { ok: true; snapshot: RosterSnapshot } | { ok: false; reason: string };

/**
 * Verify a signed snapshot offline: seal signature + snapshotDigest binding +
 * seal maxAge, then every entry's attestation (signature, active status, hard
 * expiry, name binding). Card-content deep verification (cardDigest vs a freshly
 * fetched card) is a separate step via attestationMatchesCard for parties that
 * hold the card.
 */
export async function verifySignedSnapshot(
  envelope: unknown,
  verifier: RosterVerifier,
  now: Date = new Date()
): Promise<VerifyResult> {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'envelope is not an object' };
  const candidate = envelope as Partial<SignedRosterSnapshot>;
  const { snapshot, attestations, seal } = candidate;
  if (!snapshot || !Array.isArray(snapshot.entries) || !seal) {
    return { ok: false, reason: 'envelope missing snapshot/entries/seal' };
  }
  if (!attestations || typeof attestations !== 'object') {
    return { ok: false, reason: 'envelope missing attestations' };
  }

  // 1. Seal content binding (T4: any add/remove/reorder/scope/generatedAt edit).
  if (seal.snapshotDigest !== canonicalDigest(snapshot)) {
    return { ok: false, reason: 'snapshotDigest mismatch: snapshot content was altered' };
  }

  const issuedAtMs = Date.parse(seal.issuedAt);
  if (Number.isNaN(issuedAtMs)) return { ok: false, reason: 'seal issuedAt unparseable' };
  if (now.getTime() < issuedAtMs - CLOCK_SKEW_MS) {
    return { ok: false, reason: 'seal issued in the future' };
  }
  // 2. Seal hard maxAge (T4: replay of an old but still-validly-signed snapshot).
  if (now.getTime() > issuedAtMs + seal.maxAgeSeconds * 1000) {
    return { ok: false, reason: 'snapshot seal past maxAgeSeconds' };
  }

  // 3. Seal signature.
  const sealOk = await verifier.verify(seal.keyId, canonicalJson(stripSig(seal as unknown as Record<string, unknown>)), seal.sig);
  if (!sealOk) return { ok: false, reason: `seal signature verification failed (keyId=${seal.keyId})` };

  // 4. One valid, active, unexpired attestation per entry.
  for (const entry of snapshot.entries) {
    const attestation = attestations[entry.name];
    if (!attestation) return { ok: false, reason: `missing attestation for vassal "${entry.name}"` };
    if (attestation.vassal?.name !== entry.name) {
      return { ok: false, reason: `attestation name binding failed for "${entry.name}"` };
    }
    if (attestation.status !== 'active') {
      return { ok: false, reason: `attestation for "${entry.name}" is not active` };
    }
    const attIssued = Date.parse(attestation.issuedAt);
    const attExpires = Date.parse(attestation.expiresAt);
    if (Number.isNaN(attIssued) || Number.isNaN(attExpires)) {
      return { ok: false, reason: `attestation for "${entry.name}" has unparseable dates` };
    }
    if (now.getTime() < attIssued - CLOCK_SKEW_MS) {
      return { ok: false, reason: `attestation for "${entry.name}" issued in the future` };
    }
    if (now.getTime() > attExpires) {
      return { ok: false, reason: `attestation for "${entry.name}" expired (T3 replay)` };
    }
    const attOk = await verifier.verify(
      attestation.keyId,
      canonicalJson(stripSig(attestation as unknown as Record<string, unknown>)),
      attestation.sig
    );
    if (!attOk) return { ok: false, reason: `attestation signature failed for "${entry.name}" (keyId=${attestation.keyId})` };
  }

  return { ok: true, snapshot };
}

/** Deep content check for a party that holds the (re-fetched) card: recompute
 *  digests and compare with the attestation. Detects T2 tampering with fealty,
 *  skills, description or name. */
export function attestationMatchesCard(attestation: Attestation, card: AgentCard): boolean {
  const digests = digestCard(card);
  if (attestation.cardDigest !== digests.cardDigest) return false;
  if (attestation.vassal.name !== card.name) return false;
  if (attestation.fealtyDigest || digests.fealtyDigest) {
    if (attestation.fealtyDigest !== digests.fealtyDigest) return false;
  }
  return true;
}

import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { AgentCard } from '../a2a/types.js';
import { ROSTER_SCHEMA_VERSION, type RosterSnapshot } from './roster.js';
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
  // JSON.stringify serializes through toJSON before looking at own keys, and a
  // digest has to cover what a producer actually writes. Without this a Date -
  // or any object carrying a toJSON - was canonicalized by Object.keys() into
  // `{}`, so two different values shared one digest (with a Date always
  // colliding with the empty object).
  if (typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }
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
  /** Public half of the signing key, when the backend can export it. Only the
   *  publication endpoint reads this (design-fealty-signing §5.1); signing and
   *  verification never need it, so a KMS/HSM signer may leave it undefined and
   *  simply answer 500 there. */
  readonly publicKey?: KeyObject;
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

// --- key publication ----------------------------------------------------------

/**
 * What a verifier needs to check a seal without taking the publisher's word for
 * it (design-fealty-signing §5.1/§9.3). JWKS-shaped so a standard library can
 * read `keys[]`; the two encodings after that are for the humans and the CLIs:
 * `spkiPem` is what `scripts/verify-roster.mjs --key` takes, and a fingerprint is
 * what gets announced out of band, because nobody reads 43 base64 characters off
 * a screenshot and gets them right.
 */
export type PublishedRootKey = {
  kid: string;
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  alg: 'Ed25519';
  use: 'sig';
  spkiPem: string;
  /** RFC 7638 thumbprint: the value to pin out of band. */
  jwkThumbprint: string;
  /** Colon-hex SHA-256 over the SPKI DER, for `openssl`-style pinning checklists. */
  spkiSha256: string;
};

export function publishRootKey(keyId: string, publicKey: KeyObject): PublishedRootKey {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `cannot publish a ${String(publicKey.asymmetricKeyType)} key as a Zeus root key: the signing chain is Ed25519 only`
    );
  }
  const { x } = publicKey.export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('ed25519 public key exported without a JWK x coordinate');
  const spkiPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  // RFC 7638 hashes only the required JWK members, lexicographically ordered —
  // canonicalJson already sorts keys, so this is that subset and nothing else.
  const thumbprintBase = canonicalJson({ crv: 'Ed25519', kty: 'OKP', x });
  return {
    kid: keyId,
    kty: 'OKP',
    crv: 'Ed25519',
    x,
    alg: 'Ed25519',
    use: 'sig',
    spkiPem,
    jwkThumbprint: createHash('sha256').update(thumbprintBase, 'utf8').digest('base64url'),
    spkiSha256: (createHash('sha256').update(spkiDer).digest('hex').match(/.{2}/g) ?? []).join(':'),
  };
}

// --- envelope -----------------------------------------------------------------

const ALG = 'Ed25519' as const;
const ENVELOPE_VERSION = 1 as const;
const ISSUER = 'zeus' as const;
/** Small tolerance for clock skew when rejecting future-dated signatures (ms). */
const CLOCK_SKEW_MS = 60_000;

export type AttestationStatus = 'active' | 'revoked';

export type Attestation = {
  v: 1;
  alg: 'Ed25519';
  keyId: string;
  issuer: 'zeus';
  vassal: { name: string; cardUrl: string };
  cardDigest: string;
  fealtyDigest?: string;
  status: AttestationStatus;
  issuedAt: string;
  /**
   * Hard-expiry window, present only on active attestations. Revocation is a
   * permanent, non-replayable state (replaying a revoked attestation still
   * correctly denies the vassal), so revoked attestations carry no per-entry
   * expiry; freshness of an internal snapshot containing them is bound by the
   * seal maxAge. This is the v1.1 addition that lets the internal roster (which
   * keeps revoked rows for the governance trail) be sealed, per design-fealty-signing §4.
   */
  expiresAt?: string;
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

export type AttestationSource = {
  name: string;
  card: AgentCard;
  cardUrl: string;
  /** Roster status this attestation certifies; defaults to active. Revoked
   *  sources produce a permanent (non-expiring) revocation attestation. */
  status?: AttestationStatus;
};

function iso(date: Date): string {
  return date.toISOString();
}

function isPositiveSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export async function createAttestation(
  source: AttestationSource,
  signer: RosterSigner,
  options: { now: Date; ttlSeconds?: number }
): Promise<Attestation> {
  // C-audit: a non-positive TTL produces an attestation that is already expired
  // at the instant it is signed (and NaN never expires at all). Both are artifacts
  // no consumer can act on, so refuse them at the producer.
  if (options.ttlSeconds !== undefined && !isPositiveSeconds(options.ttlSeconds)) {
    throw new Error(`createAttestation: ttlSeconds must be a positive number of seconds, got ${String(options.ttlSeconds)}`);
  }
  const { cardDigest, fealtyDigest } = digestCard(source.card);
  const status: AttestationStatus = source.status ?? 'active';
  const issuedAt = iso(options.now);
  const unsigned = {
    v: ENVELOPE_VERSION,
    alg: ALG,
    keyId: signer.keyId,
    issuer: ISSUER,
    vassal: { name: source.name, cardUrl: source.cardUrl },
    cardDigest,
    ...(fealtyDigest ? { fealtyDigest } : {}),
    status,
    issuedAt,
    // Only active attestations carry a hard-expiry window. A revoked attestation
    // certifies a permanent revocation fact and must not age out.
    ...(status === 'active'
      ? { expiresAt: iso(new Date(options.now.getTime() + (options.ttlSeconds ?? 24 * 3600) * 1000)) }
      : {}),
  };
  const sig = await signer.sign(canonicalJson(unsigned));
  return { ...unsigned, sig };
}

export type SealOptions = {
  now: Date;
  maxAgeSeconds: number;
  /** Entry cards to attest; every snapshot entry must have a matching source — a
   *  seal without sources produced `attestations: {}`, an artifact no verifier
   *  can accept. Required, so omitting it is a compile error rather than a
   *  silently unverifiable artifact. */
  sources: AttestationSource[];
  /** Per-entry attestation TTL (hard expiry), seconds. */
  attestationTtlSeconds?: number;
};

export async function sealSnapshot(
  snapshot: RosterSnapshot,
  signer: RosterSigner,
  options: SealOptions
): Promise<SignedRosterSnapshot> {
  // C-audit: maxAgeSeconds is the freshness bound the verifier enforces. A
  // non-positive value seals an artifact that is stale the moment it is issued,
  // and NaN removes the bound entirely — the one thing the field exists to do.
  if (!isPositiveSeconds(options.maxAgeSeconds)) {
    throw new Error(`sealSnapshot: maxAgeSeconds must be a positive number of seconds, got ${String(options.maxAgeSeconds)}`);
  }
  if (options.attestationTtlSeconds !== undefined && !isPositiveSeconds(options.attestationTtlSeconds)) {
    throw new Error(
      `sealSnapshot: attestationTtlSeconds must be a positive number of seconds, got ${String(options.attestationTtlSeconds)}`
    );
  }
  const attestations: Record<string, Attestation> = {};
  const ttlSeconds = options.attestationTtlSeconds ?? 24 * 3600;
  // `sources` is required by the type; the fallback covers a caller reaching
  // this from plain JS, which then gets the explicit per-entry refusal below
  // instead of a TypeError out of `.map`.
  const sourceByName = new Map((options.sources ?? []).map(source => [source.name, source]));
  // Every snapshot entry must be attested, and the source status must match the
  // projected entry status — this is what lets the internal roster (which keeps
  // revoked rows) be sealed: active rows get active (expiring) attestations,
  // revoked rows get permanent revocation attestations.
  for (const entry of snapshot.entries) {
    const source = sourceByName.get(entry.name);
    if (!source) {
      throw new Error(`sealSnapshot: no attestation source provided for snapshot entry "${entry.name}"`);
    }
    const sourceStatus: AttestationStatus = source.status ?? 'active';
    if (sourceStatus !== entry.status) {
      throw new Error(
        `sealSnapshot: attestation status "${sourceStatus}" does not match roster entry status "${entry.status}" for "${entry.name}"`
      );
    }
    attestations[entry.name] = await createAttestation(source, signer, { now: options.now, ttlSeconds });
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type VerifyResult = { ok: true; snapshot: RosterSnapshot } | { ok: false; reason: string };

/**
 * Verify a signed snapshot offline: seal signature + snapshotDigest binding +
 * seal maxAge, then every entry's attestation (signature, exact status match,
 * name binding; active entries also hard-expire, revoked entries do not).
 * Card-content deep verification (cardDigest vs a freshly fetched card) is a
 * separate step via attestationMatchesCard for parties that hold the card.
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

  // 0. Version gates. Both are checked before any cryptography: a verifier that
  //    cannot understand the shape must say so rather than fail deeper with a
  //    digest or signature error. A missing payload schemaVersion is the
  //    pre-v1.2 artifact shape and reads as 1; a missing/foreign envelope `v` was
  //    previously ignored, which made the field decorative — it is now enforced.
  const schemaVersion = (snapshot as { schemaVersion?: unknown }).schemaVersion ?? 1;
  if (schemaVersion !== ROSTER_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported roster schemaVersion ${String(schemaVersion)}; this build reads ${ROSTER_SCHEMA_VERSION}`,
    };
  }
  if (seal.v !== ENVELOPE_VERSION) {
    return { ok: false, reason: `unsupported seal envelope version ${String(seal.v)}` };
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

  // 3. Seal signature. VerifyResult promises a reason and never a throw: a
  //    KMS/network-backed verifier that fails has to be reported as a failed
  //    verification, not escape past the caller as an exception.
  let sealOk: boolean;
  try {
    sealOk = await verifier.verify(seal.keyId, canonicalJson(stripSig(seal as unknown as Record<string, unknown>)), seal.sig);
  } catch (error) {
    return { ok: false, reason: `seal signature verification could not run (keyId=${seal.keyId}): ${describeError(error)}` };
  }
  if (!sealOk) return { ok: false, reason: `seal signature verification failed (keyId=${seal.keyId})` };

  // C-audit: the seal covers the snapshot, not the attestation map, so a row that
  // no entry binds rode along unread. Refuse an attestation the snapshot does not
  // account for rather than silently ignoring it.
  const boundNames = new Set(snapshot.entries.map(entry => entry.name));
  const unbound = Object.keys(attestations).filter(name => !boundNames.has(name));
  if (unbound.length > 0) {
    return { ok: false, reason: `attestations carry rows no snapshot entry binds: ${unbound.join(', ')}` };
  }

  // 4. One attestation per entry. Its status must exactly match the projected
  //    entry status (an active attestation cannot cover a revoked row and vice
  //    versa — no elevating or downgrading). Active entries carry a hard-expiry
  //    window; revoked entries certify a permanent state and rely on the seal
  //    maxAge for snapshot freshness.
  for (const entry of snapshot.entries) {
    const attestation = attestations[entry.name];
    if (!attestation) return { ok: false, reason: `missing attestation for vassal "${entry.name}"` };
    if (attestation.v !== ENVELOPE_VERSION) {
      return {
        ok: false,
        reason: `unsupported attestation envelope version ${String(attestation.v)} for "${entry.name}"`,
      };
    }
    // C-audit: alg, issuer and keyId used to be decorative — nothing compared
    // them with the envelope, so an attestation could declare a different
    // algorithm or a foreign issuer and still verify, and one signed by a
    // different trusted key than the seal passed as well.
    if (attestation.alg !== ALG) {
      return { ok: false, reason: `attestation for "${entry.name}" declares alg "${String(attestation.alg)}", expected "${ALG}"` };
    }
    if (attestation.issuer !== ISSUER) {
      return { ok: false, reason: `attestation for "${entry.name}" declares issuer "${String(attestation.issuer)}", expected "${ISSUER}"` };
    }
    if (attestation.keyId !== seal.keyId) {
      return {
        ok: false,
        reason: `attestation for "${entry.name}" is signed by keyId "${String(attestation.keyId)}", not the seal keyId "${String(seal.keyId)}"`,
      };
    }
    if (attestation.vassal?.name !== entry.name) {
      return { ok: false, reason: `attestation name binding failed for "${entry.name}"` };
    }
    if (attestation.status !== entry.status) {
      return {
        ok: false,
        reason: `attestation status "${attestation.status}" does not match entry status "${entry.status}" for "${entry.name}"`,
      };
    }
    const attIssued = Date.parse(attestation.issuedAt);
    if (Number.isNaN(attIssued)) {
      return { ok: false, reason: `attestation for "${entry.name}" has unparseable issuedAt` };
    }
    if (now.getTime() < attIssued - CLOCK_SKEW_MS) {
      return { ok: false, reason: `attestation for "${entry.name}" issued in the future` };
    }
    if (attestation.status === 'active') {
      if (!attestation.expiresAt) {
        return { ok: false, reason: `active attestation for "${entry.name}" is missing expiresAt` };
      }
      const attExpires = Date.parse(attestation.expiresAt);
      if (Number.isNaN(attExpires)) {
        return { ok: false, reason: `attestation for "${entry.name}" has unparseable expiresAt` };
      }
      if (now.getTime() > attExpires) {
        return { ok: false, reason: `attestation for "${entry.name}" expired (T3 replay)` };
      }
    }
    let attOk: boolean;
    try {
      attOk = await verifier.verify(
        attestation.keyId,
        canonicalJson(stripSig(attestation as unknown as Record<string, unknown>)),
        attestation.sig
      );
    } catch (error) {
      return {
        ok: false,
        reason: `attestation verification could not run for "${entry.name}" (keyId=${attestation.keyId}): ${describeError(error)}`,
      };
    }
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

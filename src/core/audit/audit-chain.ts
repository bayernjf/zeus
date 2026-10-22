import { canonicalDigest, canonicalJson } from '../signing.js';
import {
  AUDIT_ENTRY_KEYS,
  AUDIT_GENESIS,
  AUDIT_PAYLOAD_KEYS,
  DECISION_AUDIT_KINDS,
  type DecisionAuditEntry,
  type DecisionAuditInput,
  type DecisionAuditKind,
  type DecisionAuditPayload,
} from './types.js';

/** Anything that can seal and store an audit event. The in-memory chain and
 *  the shell-side JSONL store both satisfy it. */
export interface DecisionAuditAppender {
  append(input: DecisionAuditInput): Promise<DecisionAuditEntry>;
}

/**
 * Signing boundary for the decision audit chain. Structurally identical to the
 * roster signer/verifier in `../signing.ts`; declared locally so the audit
 * chain does not depend on roster semantics.
 */
export interface DecisionAuditChainSigner {
  readonly keyId: string;
  /** Sign canonical text, return a base64url (unpadded) Ed25519 signature. */
  sign(canonicalText: string): Promise<string>;
}

export interface DecisionAuditChainVerifier {
  /** Verify a base64url Ed25519 signature against canonical text for a keyId. */
  verify(keyId: string, canonicalText: string, signatureBase64Url: string): Promise<boolean>;
}

/** The exact document every hash and signature covers. */
export interface AuditSealingDoc {
  seq: number;
  prevHash: string;
  keyId: string;
  payload: DecisionAuditPayload;
}

function sealingDoc(entry: Pick<DecisionAuditEntry, 'seq' | 'prevHash' | 'keyId' | 'payload'>): AuditSealingDoc {
  return {
    seq: entry.seq,
    prevHash: entry.prevHash,
    keyId: entry.keyId,
    payload: entry.payload,
  };
}

/** Canonical text that gets signed. */
export function auditSigningText(doc: AuditSealingDoc): string {
  return canonicalJson(doc);
}

/** Recompute a link hash. Verification always recomputes — it never trusts the
 *  stored `hash` field, or a tampered entry could just re-state its own hash. */
export function auditEntryHash(doc: AuditSealingDoc): string {
  return canonicalDigest(doc);
}

/** Strict structural validation of a payload. Returns all issues found. */
export function validateAuditPayload(value: unknown, at = 'payload'): string[] {
  const out: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.push(`${at}: expected an object, got ${value === null ? 'null' : typeof value}`);
    return out;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!AUDIT_PAYLOAD_KEYS.includes(key as (typeof AUDIT_PAYLOAD_KEYS)[number])) {
      out.push(`${at}.${key}: unknown field`);
    }
  }
  if (typeof record.kind !== 'string' || !DECISION_AUDIT_KINDS.includes(record.kind as DecisionAuditKind)) {
    out.push(`${at}.kind: expected one of ${DECISION_AUDIT_KINDS.join('/')}, got ${JSON.stringify(record.kind)}`);
  }
  if (typeof record.at !== 'string' || record.at === '') {
    out.push(`${at}.at: expected a non-empty ISO timestamp, got ${JSON.stringify(record.at)}`);
  }
  if (record.decisionId !== undefined && typeof record.decisionId !== 'string') {
    out.push(`${at}.decisionId: expected a string, got ${typeof record.decisionId}`);
  }
  if (record.actor !== undefined && typeof record.actor !== 'string') {
    out.push(`${at}.actor: expected a string, got ${typeof record.actor}`);
  }
  if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data)) {
    out.push(`${at}.data: expected an object, got ${record.data === null ? 'null' : typeof record.data}`);
  }
  return out;
}

/** Strict structural validation of a sealed envelope. */
export function validateAuditEntry(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`entry: expected an object, got ${value === null ? 'null' : typeof value}`];
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!AUDIT_ENTRY_KEYS.includes(key as (typeof AUDIT_ENTRY_KEYS)[number])) {
      out.push(`entry.${key}: unknown field`);
    }
  }
  if (!Number.isInteger(record.seq) || (record.seq as number) < 0) {
    out.push(`entry.seq: expected a non-negative integer, got ${JSON.stringify(record.seq)}`);
  }
  if (typeof record.prevHash !== 'string' || record.prevHash === '') {
    out.push('entry.prevHash: expected a non-empty string');
  }
  if (typeof record.keyId !== 'string' || record.keyId === '') {
    out.push('entry.keyId: expected a non-empty string');
  }
  if (typeof record.hash !== 'string' || !record.hash.startsWith('sha256:')) {
    out.push('entry.hash: expected a sha256:-labeled digest');
  }
  if (typeof record.signature !== 'string' || record.signature === '') {
    out.push('entry.signature: expected a non-empty base64url signature');
  }
  out.push(...validateAuditPayload(record.payload, 'entry.payload'));
  return out;
}

/**
 * Append-only in-memory chain. Every append seals a link immediately
 * (per-record granularity — ADR-04): there is no unsigned window between
 * batch boundaries, and one Ed25519 sign per decision is negligible.
 */
export class DecisionAuditChain {
  private readonly entries: DecisionAuditEntry[] = [];

  constructor(
    private readonly signer: DecisionAuditChainSigner,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Rebuild a chain from persisted entries (already verified by the caller). */
  static hydrate(
    signer: DecisionAuditChainSigner,
    entries: readonly DecisionAuditEntry[],
    clock?: () => string,
  ): DecisionAuditChain {
    const chain = new DecisionAuditChain(signer, clock);
    for (const entry of entries) chain.entries.push({ ...entry, payload: { ...entry.payload, data: { ...entry.payload.data } } });
    return chain;
  }

  /** Seal and append one event; returns the persisted envelope. */
  async append(input: DecisionAuditInput): Promise<DecisionAuditEntry> {
    const payload: DecisionAuditPayload = {
      data: input.data ?? {},
      ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      kind: input.kind,
      at: input.at ?? this.clock(),
    };
    const issues = validateAuditPayload(payload);
    if (issues.length > 0) throw new DecisionAuditValidationError(issues);

    const seq = this.entries.length;
    const prev = this.entries[seq - 1];
    const doc: AuditSealingDoc = {
      seq,
      prevHash: prev ? prev.hash : AUDIT_GENESIS,
      keyId: this.signer.keyId,
      payload,
    };
    const hash = auditEntryHash(doc);
    const signature = await this.signer.sign(auditSigningText(doc));
    const entry: DecisionAuditEntry = { ...doc, hash, signature };
    this.entries.push(entry);
    return entry;
  }

  get length(): number {
    return this.entries.length;
  }

  list(): readonly DecisionAuditEntry[] {
    return this.entries;
  }

  /** Hash of the latest link, or GENESIS for an empty chain. */
  headHash(): string {
    const last = this.entries[this.entries.length - 1];
    return last ? last.hash : AUDIT_GENESIS;
  }
}

export class DecisionAuditValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`decision audit payload invalid:\n- ${issues.join('\n- ')}`);
    this.name = 'DecisionAuditValidationError';
  }
}

export type AuditVerification =
  | { ok: true; count: number }
  | { ok: false; seq: number; reason: string };

/**
 * Verify a chain from its sealed envelopes. Nothing stored in an entry is
 * trusted on its own: structural shape, sequence contiguity, the previous
 * link's hash (recomputed), this link's own hash (recomputed) and the
 * signature must all agree. The first failure is reported with its seq.
 */
export async function verifyDecisionAuditChain(
  entries: readonly DecisionAuditEntry[],
  verifier: DecisionAuditChainVerifier,
): Promise<AuditVerification> {
  let previousHash = AUDIT_GENESIS;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) return { ok: false, seq: i, reason: 'missing entry' };

    const issues = validateAuditEntry(entry);
    if (issues.length > 0) return { ok: false, seq: i, reason: issues.join('; ') };

    if (entry.seq !== i) {
      return { ok: false, seq: i, reason: `seq discontinuity: expected ${i}, got ${entry.seq}` };
    }
    if (entry.prevHash !== previousHash) {
      return { ok: false, seq: i, reason: `prevHash mismatch (link broken or record inserted/removed)` };
    }

    const doc = sealingDoc(entry);
    const recomputedHash = auditEntryHash(doc);
    if (recomputedHash !== entry.hash) {
      return { ok: false, seq: i, reason: 'hash mismatch: payload or envelope fields were altered' };
    }

    const validSig = await verifier.verify(entry.keyId, auditSigningText(doc), entry.signature);
    if (!validSig) {
      return { ok: false, seq: i, reason: `signature verification failed for keyId ${entry.keyId}` };
    }

    previousHash = recomputedHash;
  }
  return { ok: true, count: entries.length };
}

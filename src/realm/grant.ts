import { randomUUID } from 'node:crypto';
import { canonicalJson, type RosterSigner, type RosterVerifier } from '../registry/signing.js';
import type { DriverWriteGrant, GrantVerification, SignedDriverWriteGrant } from './types.js';

/**
 * E3.5 driver write grants (design-realm §7.5, deferred #14).
 *
 * A grant is a signed statement: "key K authorized a write into realm R until
 * time T, once". Before this module the kernel could only check a grant's
 * *shape*, which meant `verifyDriverWriteGrant` trusted that the JSON it was
 * handed came from the driver - anyone able to reach `write()` could author an
 * authorization. Issuance, signature verification and nonce consumption are
 * what turn it into a credential.
 */

/** Default lifetime of an issued grant: enough to do one write, short enough
 *  that a leaked grant expires before anyone notices. */
export const DRIVER_GRANT_DEFAULT_TTL_MS = 5 * 60_000;
/** A grant that asks to live longer than this is refused rather than clamped:
 *  a long-lived write credential is a different object, and pretending
 *  otherwise would silently downgrade what the driver signed. */
export const DRIVER_GRANT_MAX_TTL_MS = 24 * 3600_000;

export type IssueDriverGrantInput = {
  realmId: string;
  /** Who authorized it, as a human-readable identity (not a key id: `keyId` carries that). */
  grantedBy: string;
  reason?: string;
  ttlMs?: number;
  /** Defaults to a fresh random UUID. Provide one only to make issuance deterministic in a test. */
  nonce?: string;
};

export type IssueDriverGrantOptions = {
  signer: RosterSigner;
  now?: () => Date;
  maxTtlMs?: number;
};

export class DriverGrantError extends Error {}

/**
 * One record per issued write grant. Issuance is the moment a human said "yes,
 * write this", so it belongs on the audit spine even when the write that follows
 * never happens.
 */
export type DriverGrantAuditEntry = {
  at: string;
  decision: 'driver-grant-issued';
  realmId: string;
  grantedBy: string;
  keyId: string;
  expiresAt: string;
  reason?: string;
};

/** The fields the signature covers: everything except the signature itself. */
function grantClaim(grant: DriverWriteGrant): Record<string, unknown> {
  const { sig: _sig, ...claim } = grant;
  return claim;
}

/**
 * Mint and sign a single-use write grant for one enterprise realm.
 *
 * Refuses an unknown realm type at the caller boundary is the transport's job;
 * this refuses malformed inputs and an unbounded lifetime, because those are the
 * two ways a "grant" stops meaning "one write".
 */
export async function issueDriverWriteGrant(
  input: IssueDriverGrantInput,
  options: IssueDriverGrantOptions
): Promise<SignedDriverWriteGrant> {
  const now = (options.now ?? (() => new Date()))();
  if (!input.realmId?.trim()) throw new DriverGrantError('grant needs a realmId');
  if (!input.grantedBy?.trim()) throw new DriverGrantError('grant needs a grantedBy identity');
  const ttlMs = input.ttlMs ?? DRIVER_GRANT_DEFAULT_TTL_MS;
  const maxTtlMs = options.maxTtlMs ?? DRIVER_GRANT_MAX_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new DriverGrantError(`grant ttl must be a positive number of ms: ${String(input.ttlMs)}`);
  if (ttlMs > maxTtlMs) throw new DriverGrantError(`grant ttl ${ttlMs}ms exceeds the ${maxTtlMs}ms ceiling`);
  const nonce = input.nonce?.trim() || randomUUID();
  if (!nonce) throw new DriverGrantError('grant needs a nonce');

  const grant: SignedDriverWriteGrant = {
    kind: 'driver-write',
    realmId: input.realmId.trim(),
    grantedBy: input.grantedBy.trim(),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    nonce,
    keyId: options.signer.keyId,
    sig: '',
  };
  grant.sig = await options.signer.sign(canonicalJson(grantClaim(grant)));
  return grant;
}

/**
 * Bounded set of consumed nonces. A grant is single-use, and that is the only
 * thing standing between a captured grant and a second write inside its ttl -
 * so the window has to be at least as long as the longest ttl in force.
 *
 * Bounded on purpose: an unbounded ledger is a memory leak in a long-running
 * kernel, and `MAX_SPENT` entries at grant-issue rates far past anything this
 * project sees still covers hours. Evicting the oldest is logged through
 * `onEvict` so a deployment that wants the audit trail can keep it.
 */
export const MAX_SPENT_GRANT_NONCES = 10_000;

export type DriverGrantLedgerOptions = {
  limit?: number;
  /** Fired when a nonce is newly consumed. The ledger is only worth having if it
   *  survives a restart, so the kernel persists state from here rather than
   *  waiting for shutdown - a nonce lost to a crash is a grant that replays. */
  onChange?: () => void;
  /** Fired when the bounded window evicts an old nonce. */
  onEvict?: (nonce: string) => void;
};

export class DriverGrantLedger {
  private spent = new Set<string>();
  private order: string[] = [];
  private readonly limit: number;
  private readonly onChange?: () => void;
  private readonly onEvict: (nonce: string) => void;

  constructor(options: DriverGrantLedgerOptions = {}) {
    this.limit = options.limit ?? MAX_SPENT_GRANT_NONCES;
    this.onChange = options.onChange;
    this.onEvict = options.onEvict ?? (() => {});
  }

  isSpent(nonce: string): boolean {
    return this.spent.has(nonce);
  }

  /** Claim a nonce. False means it was already consumed (replay). */
  consume(nonce: string): boolean {
    if (this.spent.has(nonce)) return false;
    this.spent.add(nonce);
    this.order.push(nonce);
    let evicted = false;
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.spent.delete(oldest);
        this.onEvict(oldest);
        evicted = true;
      }
    }
    if (!evicted) this.onChange?.();
    return true;
  }

  get size(): number {
    return this.spent.size;
  }

  exportState(): string[] {
    return [...this.order];
  }

  importState(nonces: string[]): void {
    this.spent.clear();
    this.order = [];
    for (const nonce of nonces ?? []) {
      if (typeof nonce !== 'string' || !nonce.trim() || this.spent.has(nonce)) continue;
      this.spent.add(nonce);
      this.order.push(nonce);
    }
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.spent.delete(oldest);
    }
  }
}

export type GrantVerificationContext = {
  now?: () => Date;
  /** When present, the grant must carry a signature this verifier accepts. */
  verifier?: RosterVerifier;
  /** Key ids treated as driver keys. Empty/absent accepts any key the verifier knows. */
  acceptedKeyIds?: string[];
  /** When present, nonces are compared and consumed (single-use enforcement). */
  ledger?: DriverGrantLedger;
};

/**
 * Verify a driver write grant against the realm about to be written.
 *
 * Order matters: shape and binding first (cheap, and they say what is wrong),
 * then the signature (the expensive check that proves provenance), then expiry,
 * then consumption. A grant that fails any check never reaches the ledger, so a
 * rejected attempt cannot burn someone else's nonce.
 */
export async function verifyDriverWriteGrant(
  grant: DriverWriteGrant | undefined,
  realmId: string,
  context: GrantVerificationContext = {}
): Promise<GrantVerification> {
  if (!grant) return { ok: false, reason: 'missing' };

  const malformed =
    grant.kind !== 'driver-write' ||
    typeof grant.realmId !== 'string' ||
    grant.realmId.length === 0 ||
    typeof grant.grantedBy !== 'string' ||
    grant.grantedBy.length === 0 ||
    typeof grant.grantedAt !== 'string' ||
    Number.isNaN(Date.parse(grant.grantedAt)) ||
    typeof grant.nonce !== 'string' ||
    grant.nonce.length === 0 ||
    (grant.expiresAt !== undefined && Number.isNaN(Date.parse(grant.expiresAt)));
  if (malformed) return { ok: false, reason: 'malformed' };

  if (grant.realmId !== realmId) return { ok: false, reason: 'wrong-realm' };

  if (context.verifier) {
    if (typeof grant.sig !== 'string' || grant.sig.length === 0) return { ok: false, reason: 'unsigned' };
    if (typeof grant.keyId !== 'string' || grant.keyId.length === 0) return { ok: false, reason: 'unsigned' };
    if (context.acceptedKeyIds && context.acceptedKeyIds.length > 0 && !context.acceptedKeyIds.includes(grant.keyId)) {
      return { ok: false, reason: 'unknown-key' };
    }
    const valid = await context.verifier.verify(grant.keyId, canonicalJson(grantClaim(grant)), grant.sig);
    if (!valid) return { ok: false, reason: 'bad-signature' };
  }

  const now = (context.now ?? (() => new Date()))();
  if (grant.expiresAt === undefined) {
    // An open-ended write credential is not a credential; it is a permission,
    // and permissions are E6.4's business (DomainGrant), not this one's.
    return { ok: false, reason: 'no-expiry' };
  }
  if (now.getTime() > Date.parse(grant.expiresAt)) return { ok: false, reason: 'expired' };

  if (context.ledger && !context.ledger.consume(grant.nonce)) {
    return { ok: false, reason: 'replayed' };
  }

  return { ok: true };
}

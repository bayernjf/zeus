import { randomUUID } from 'node:crypto';
import { canonicalJson, type RosterSigner, type RosterVerifier } from '../registry/signing.js';

/**
 * One-time, short-lived authorization for an executing vassal to perform an
 * external write. It is not a stored credential: the operator signs approval
 * for a bounded purpose, the vassal uses its own downstream credential, and the
 * nonce makes a captured authorization unreplayable.
 */
export type ExecutionDelegation = {
  kind: 'zeus-execution-delegation';
  version: 1;
  /** Human identity that approved the external write. */
  grantedBy: string;
  /** Skill the approval is bound to; a different skill cannot consume it. */
  skill: string;
  /**
   * Optional vassal binding. When omitted, the first eligible branch consumes
   * the single nonce; a second branch in the same fan-out cannot.
   */
  vassal?: string;
  /** Explicit external capabilities, e.g. ['github:pull-request:merge']. */
  capabilities: string[];
  /** Optional operator-supplied reason for audit display. */
  reason?: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
  /** base64url Ed25519 signature over the canonical claim minus `sig`. */
  sig: string;
};

/** Default lifetime: enough to dispatch once, short enough to limit replay risk. */
export const EXECUTION_DELEGATION_DEFAULT_TTL_MS = 5 * 60_000;
/** Maximum lifetime the issuer accepts; a longer-lived execute credential is refused. */
export const EXECUTION_DELEGATION_MAX_TTL_MS = 60 * 60_000;

export type IssueExecutionDelegationInput = {
  grantedBy: string;
  skill: string;
  capabilities: string[];
  vassal?: string;
  reason?: string;
  ttlMs?: number;
  nonce?: string;
};

export class ExecutionDelegationError extends Error {}

export type ExecutionDelegationVerification =
  | { ok: true; nonce: string }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'malformed'
        | 'wrong-vassal'
        | 'wrong-skill'
        | 'capability-not-covered'
        | 'unsigned'
        | 'unknown-key'
        | 'bad-signature'
        | 'no-expiry'
        | 'expired'
        | 'replayed'
        | 'no-trust-anchor';
    };

export type VerifyExecutionDelegationContext = {
  verifier: RosterVerifier;
  ledger: ExecutionDelegationNonceLedger;
  vassal: string;
  skill: string;
  capability: string;
  acceptedKeyIds?: string[];
  now?: () => Date;
};

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities.map(capability => capability.trim()).filter(Boolean))].sort();
}

function delegationClaim(delegation: ExecutionDelegation): Record<string, unknown> {
  const { sig: _sig, ...claim } = delegation;
  return claim;
}

export async function issueExecutionDelegation(
  input: IssueExecutionDelegationInput,
  options: { signer: RosterSigner; now?: () => Date; maxTtlMs?: number },
): Promise<ExecutionDelegation> {
  const now = (options.now ?? (() => new Date()))();
  const grantedBy = input.grantedBy?.trim();
  const skill = input.skill?.trim();
  const capabilities = normalizeCapabilities(input.capabilities ?? []);
  if (!grantedBy) throw new ExecutionDelegationError('execution delegation needs grantedBy');
  if (!skill) throw new ExecutionDelegationError('execution delegation needs skill');
  if (capabilities.length === 0) throw new ExecutionDelegationError('execution delegation needs at least one capability');
  if (input.vassal !== undefined && !input.vassal.trim()) {
    throw new ExecutionDelegationError('execution delegation vassal must be a non-empty string when provided');
  }

  const ttlMs = input.ttlMs ?? EXECUTION_DELEGATION_DEFAULT_TTL_MS;
  const maxTtlMs = options.maxTtlMs ?? EXECUTION_DELEGATION_MAX_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ExecutionDelegationError(`execution delegation ttl must be a positive number of ms: ${String(input.ttlMs)}`);
  }
  if (ttlMs > maxTtlMs) {
    throw new ExecutionDelegationError(`execution delegation ttl ${ttlMs}ms exceeds the ${maxTtlMs}ms ceiling`);
  }

  const unsigned = {
    kind: 'zeus-execution-delegation' as const,
    version: 1 as const,
    grantedBy,
    skill,
    ...(input.vassal?.trim() ? { vassal: input.vassal.trim() } : {}),
    capabilities,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    nonce: input.nonce?.trim() || randomUUID(),
    keyId: options.signer.keyId,
    sig: '',
  };

  return { ...unsigned, sig: await options.signer.sign(canonicalJson(delegationClaim(unsigned))) };
}

/**
 * Bounded consumed-nonce set. Failed verification never consumes a nonce, so a
 * malformed or expired attempt cannot burn a valid later retry.
 */
export class ExecutionDelegationNonceLedger {
  private readonly spent = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 10_000, private readonly onChange?: () => void) {}

  isSpent(nonce: string): boolean {
    return this.spent.has(nonce);
  }

  consume(nonce: string): boolean {
    if (this.spent.has(nonce)) return false;
    this.spent.add(nonce);
    this.order.push(nonce);
    while (this.order.length > this.limit) {
      this.spent.delete(this.order.shift()!);
    }
    this.onChange?.();
    return true;
  }

  get size(): number {
    return this.spent.size;
  }

  exportState(): string[] {
    return [...this.order];
  }

  importState(nonces: readonly string[]): void {
    this.spent.clear();
    this.order.length = 0;
    for (const nonce of nonces ?? []) {
      if (typeof nonce === 'string' && nonce.trim() && !this.spent.has(nonce)) {
        this.spent.add(nonce);
        this.order.push(nonce);
      }
    }
    while (this.order.length > this.limit) this.spent.delete(this.order.shift()!);
  }
}

export async function verifyAndConsumeExecutionDelegation(
  delegation: ExecutionDelegation | undefined,
  context: VerifyExecutionDelegationContext,
): Promise<ExecutionDelegationVerification> {
  if (!delegation) return { ok: false, reason: 'missing' };

  const malformed =
    delegation.kind !== 'zeus-execution-delegation' ||
    delegation.version !== 1 ||
    typeof delegation.grantedBy !== 'string' ||
    !delegation.grantedBy.trim() ||
    typeof delegation.skill !== 'string' ||
    !delegation.skill.trim() ||
    !Array.isArray(delegation.capabilities) ||
    delegation.capabilities.some(capability => typeof capability !== 'string' || !capability.trim()) ||
    typeof delegation.issuedAt !== 'string' ||
    Number.isNaN(Date.parse(delegation.issuedAt)) ||
    typeof delegation.nonce !== 'string' ||
    !delegation.nonce.trim() ||
    (delegation.vassal !== undefined && typeof delegation.vassal !== 'string');
  if (malformed) return { ok: false, reason: 'malformed' };

  if (delegation.vassal && delegation.vassal !== context.vassal) {
    return { ok: false, reason: 'wrong-vassal' };
  }
  if (delegation.skill !== context.skill) return { ok: false, reason: 'wrong-skill' };
  if (!delegation.capabilities.includes(context.capability)) {
    return { ok: false, reason: 'capability-not-covered' };
  }

  if (!delegation.sig || !delegation.keyId) return { ok: false, reason: 'unsigned' };
  if (context.acceptedKeyIds && !context.acceptedKeyIds.includes(delegation.keyId)) {
    return { ok: false, reason: 'unknown-key' };
  }

  // Execute is fail-closed: a caller cannot pass shape validation by omitting a
  // trust anchor the way a shape-only enterprise write check historically could.
  if (!context.verifier) return { ok: false, reason: 'no-trust-anchor' };
  const valid = await context.verifier.verify(
    delegation.keyId,
    canonicalJson(delegationClaim(delegation)),
    delegation.sig,
  );
  if (!valid) return { ok: false, reason: 'bad-signature' };

  if (!delegation.expiresAt || Number.isNaN(Date.parse(delegation.expiresAt))) {
    return { ok: false, reason: 'no-expiry' };
  }
  const now = (context.now ?? (() => new Date()))();
  if (now.getTime() > Date.parse(delegation.expiresAt)) return { ok: false, reason: 'expired' };

  if (!context.ledger.consume(delegation.nonce)) return { ok: false, reason: 'replayed' };
  return { ok: true, nonce: delegation.nonce };
}

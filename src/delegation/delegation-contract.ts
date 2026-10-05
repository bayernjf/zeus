import { randomUUID } from 'node:crypto';
import { canonicalJson, type RosterSigner, type RosterVerifier } from '../registry/signing.js';
import {
  EXECUTION_DELEGATION_DEFAULT_TTL_MS,
  issueExecutionDelegation,
  type ExecutionDelegation,
} from './execution-delegation.js';

/**
 * A bounded delegation contract: the operator's signed permission for the kernel
 * to mint execution tickets **later, with nobody present** (the `watch` trigger).
 * A per-dispatch ticket cannot carry that, because at dispatch time there is no
 * one left to sign.
 *
 * The contract widens only *who may obtain a ticket*, never *what a ticket does*:
 * the child is an ordinary `ExecutionDelegation` with its own TTL and single
 * nonce, consumed by the existing dispatch gate.
 *
 * Design: docs/design-self-host-loop.md §4 (unimplemented beyond this file until
 * the trigger and the HTTP face land).
 */
export type DelegationContract = {
  id: string;
  kind: 'zeus-delegation-contract';
  version: 1;
  /** Same identity semantics as a child ticket's `grantedBy`. */
  grantedBy: string;
  skill: string;
  /** When set, a child may only name this vassal. */
  vassal?: string;
  /** Full set children draw from; every child capability set must be a subset. */
  capabilities: string[];
  limits: {
    maxChildTickets: number;
    maxConcurrent: number;
    /** May outlive a single child TTL; nothing derives after it. */
    windowEndsAt: string;
  };
  /**
   * Kernel bookkeeping, deliberately **not** part of the signed claim: counters
   * move every time the approval is spent, and signing them would invalidate the
   * signature on first use. The signature commits to the boundary the operator
   * approved, not to how much of it has been consumed.
   */
  used: { childTickets: number; inFlight: number };
  /** Unsigned for the same reason - revocation is a write to the record. */
  revokedAt?: string;
  issuedAt: string;
  keyId: string;
  /** base64url Ed25519 over the canonical claim minus `sig`, `used`, `revokedAt`. */
  sig: string;
};

/** The dispatch gate asks every child ticket for this capability, so a contract
 *  that does not cover it could only ever mint inert tickets. */
export const DELEGATION_CONTRACT_REQUIRED_CAPABILITY = 'execute';

export class DelegationContractError extends Error {}

export type IssueDelegationContractInput = {
  grantedBy: string;
  skill: string;
  capabilities: string[];
  limits: { maxChildTickets: number; maxConcurrent: number; windowEndsAt: string };
  vassal?: string;
  id?: string;
};

export type DelegationContractRefusal =
  | 'unknown-contract'
  | 'malformed'
  | 'unsigned'
  | 'unknown-key'
  | 'bad-signature'
  | 'no-window'
  | 'window-ended'
  | 'revoked'
  | 'no-trust-anchor';

export type DelegationContractCheck = { ok: true } | { ok: false; reason: DelegationContractRefusal };

export type DeriveRefusal =
  | DelegationContractRefusal
  | 'child-capability-not-covered'
  | 'child-vassal-mismatch'
  | 'child-ticket-limit-reached'
  | 'concurrent-limit-reached';

export type DeriveExecutionDelegationInput = {
  capabilities: string[];
  vassal?: string;
  reason?: string;
  ttlMs?: number;
  nonce?: string;
};

export type DeriveResult =
  | { ok: true; contractId: string; delegation: ExecutionDelegation }
  | { ok: false; reason: DeriveRefusal };

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities.map(capability => capability.trim()).filter(Boolean))].sort();
}

/** What the signature commits to: the approved boundary, without the parts the
 *  kernel writes as it spends that approval. */
function contractClaim(contract: DelegationContract): Record<string, unknown> {
  const { sig: _sig, used: _used, revokedAt: _revokedAt, ...claim } = contract;
  return claim;
}

export async function issueDelegationContract(
  input: IssueDelegationContractInput,
  options: { signer: RosterSigner; now?: () => Date },
): Promise<DelegationContract> {
  const now = (options.now ?? (() => new Date()))();
  const grantedBy = input.grantedBy?.trim();
  const skill = input.skill?.trim();
  const capabilities = normalizeCapabilities(input.capabilities ?? []);
  if (!grantedBy) throw new DelegationContractError('delegation contract needs grantedBy');
  if (!skill) throw new DelegationContractError('delegation contract needs skill');
  if (capabilities.length === 0) throw new DelegationContractError('delegation contract needs at least one capability');
  if (!capabilities.includes(DELEGATION_CONTRACT_REQUIRED_CAPABILITY)) {
    throw new DelegationContractError(
      `delegation contract must cover "${DELEGATION_CONTRACT_REQUIRED_CAPABILITY}"; a plan-only intent needs no ticket at all`,
    );
  }
  if (input.vassal !== undefined && !input.vassal.trim()) {
    throw new DelegationContractError('delegation contract vassal must be a non-empty string when provided');
  }

  const maxChildTickets = input.limits?.maxChildTickets;
  const maxConcurrent = input.limits?.maxConcurrent;
  if (!Number.isInteger(maxChildTickets) || maxChildTickets <= 0) {
    throw new DelegationContractError(`delegation contract maxChildTickets must be a positive integer: ${String(maxChildTickets)}`);
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new DelegationContractError(`delegation contract maxConcurrent must be a positive integer: ${String(maxConcurrent)}`);
  }
  const windowEndsAt = input.limits?.windowEndsAt;
  if (typeof windowEndsAt !== 'string' || Number.isNaN(Date.parse(windowEndsAt))) {
    throw new DelegationContractError(`delegation contract windowEndsAt must be a parseable date: ${String(windowEndsAt)}`);
  }
  if (Date.parse(windowEndsAt) <= now.getTime()) {
    throw new DelegationContractError('delegation contract windowEndsAt must be in the future');
  }

  const unsigned: DelegationContract = {
    id: input.id?.trim() || randomUUID(),
    kind: 'zeus-delegation-contract',
    version: 1,
    grantedBy,
    skill,
    ...(input.vassal?.trim() ? { vassal: input.vassal.trim() } : {}),
    capabilities,
    limits: { maxChildTickets, maxConcurrent, windowEndsAt: new Date(windowEndsAt).toISOString() },
    used: { childTickets: 0, inFlight: 0 },
    issuedAt: now.toISOString(),
    keyId: options.signer.keyId,
    sig: '',
  };

  return { ...unsigned, sig: await options.signer.sign(canonicalJson(contractClaim(unsigned))) };
}

/** Structural checks run before any key lookup, so a record that could never be
 *  valid is refused without spending a verify on it. */
function isWellFormed(contract: DelegationContract): boolean {
  return (
    contract.kind === 'zeus-delegation-contract' &&
    contract.version === 1 &&
    typeof contract.id === 'string' &&
    !!contract.id.trim() &&
    typeof contract.grantedBy === 'string' &&
    !!contract.grantedBy.trim() &&
    typeof contract.skill === 'string' &&
    !!contract.skill.trim() &&
    Array.isArray(contract.capabilities) &&
    contract.capabilities.length > 0 &&
    contract.capabilities.every(capability => typeof capability === 'string' && !!capability.trim()) &&
    typeof contract.limits?.maxChildTickets === 'number' &&
    Number.isInteger(contract.limits.maxChildTickets) &&
    contract.limits.maxChildTickets > 0 &&
    typeof contract.limits?.maxConcurrent === 'number' &&
    Number.isInteger(contract.limits.maxConcurrent) &&
    contract.limits.maxConcurrent > 0 &&
    typeof contract.limits?.windowEndsAt === 'string' &&
    typeof contract.issuedAt === 'string' &&
    !Number.isNaN(Date.parse(contract.issuedAt)) &&
    typeof contract.used?.childTickets === 'number' &&
    typeof contract.used?.inFlight === 'number' &&
    (contract.vassal === undefined || typeof contract.vassal === 'string') &&
    (contract.revokedAt === undefined || typeof contract.revokedAt === 'string')
  );
}

export async function verifyDelegationContract(
  contract: DelegationContract | undefined,
  context: { verifier?: RosterVerifier; acceptedKeyIds?: string[]; now?: () => Date },
): Promise<DelegationContractCheck> {
  if (!contract || !isWellFormed(contract)) return { ok: false, reason: 'malformed' };
  if (!contract.sig || !contract.keyId) return { ok: false, reason: 'unsigned' };
  if (context.acceptedKeyIds && !context.acceptedKeyIds.includes(contract.keyId)) {
    return { ok: false, reason: 'unknown-key' };
  }
  // Same fail-closed rule as the child ticket: leaving the trust anchor out is
  // not a route to a shape-only pass.
  if (!context.verifier) return { ok: false, reason: 'no-trust-anchor' };
  if (!(await context.verifier.verify(contract.keyId, canonicalJson(contractClaim(contract)), contract.sig))) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (Number.isNaN(Date.parse(contract.limits.windowEndsAt))) return { ok: false, reason: 'no-window' };
  const now = (context.now ?? (() => new Date()))();
  if (now.getTime() > Date.parse(contract.limits.windowEndsAt)) return { ok: false, reason: 'window-ended' };
  if (contract.revokedAt) return { ok: false, reason: 'revoked' };
  return { ok: true };
}

/**
 * Contracts in memory, exportable to the kernel snapshot.
 *
 * `used.inFlight` counts tickets that have been derived and not yet released.
 * Nothing releases them until the execute path is wired (implementation step
 * 4), so until then the concurrency ceiling behaves as a total ceiling - which
 * is the safe direction for the error to be wrong in.
 */
export class DelegationContractRegistry {
  private readonly contracts = new Map<string, DelegationContract>();
  private readonly outstanding = new Map<string, string>();

  constructor(private readonly onChange?: () => void) {}

  /** Insert an already-signed contract (issuance, or a snapshot restore). */
  add(contract: DelegationContract): void {
    if (!contract?.id) throw new DelegationContractError('delegation contract needs an id before it can be registered');
    if (this.contracts.has(contract.id)) {
      throw new DelegationContractError(`delegation contract ${contract.id} already exists`);
    }
    this.contracts.set(contract.id, structuredClone(contract));
    this.onChange?.();
  }

  get(id: string): DelegationContract | undefined {
    const contract = this.contracts.get(id);
    return contract ? structuredClone(contract) : undefined;
  }

  list(): DelegationContract[] {
    return [...this.contracts.values()].map(contract => structuredClone(contract));
  }

  /** Revocation is a write to the record, and must not disturb the signed claim. */
  revoke(id: string, now: Date = new Date()): boolean {
    const contract = this.contracts.get(id);
    if (!contract || contract.revokedAt) return false;
    contract.revokedAt = now.toISOString();
    this.onChange?.();
    return true;
  }

  /**
   * Check the two ceilings and spend a slot in one synchronous step, so two
   * concurrent derivations cannot both pass a ceiling before either reserves.
   */
  reserve(contractId: string, nonce: string): { ok: true } | { ok: false; reason: DeriveRefusal } {
    const contract = this.contracts.get(contractId);
    if (!contract) return { ok: false, reason: 'unknown-contract' };
    if (contract.used.childTickets >= contract.limits.maxChildTickets) {
      return { ok: false, reason: 'child-ticket-limit-reached' };
    }
    if (contract.used.inFlight >= contract.limits.maxConcurrent) {
      return { ok: false, reason: 'concurrent-limit-reached' };
    }
    contract.used.childTickets += 1;
    contract.used.inFlight += 1;
    this.outstanding.set(nonce, contractId);
    this.onChange?.();
    return { ok: true };
  }

  /** Undo a reservation whose ticket never came into existence. */
  cancelReservation(nonce: string): void {
    const contractId = this.outstanding.get(nonce);
    if (!contractId) return;
    this.outstanding.delete(nonce);
    const contract = this.contracts.get(contractId);
    if (contract) {
      contract.used.childTickets = Math.max(0, contract.used.childTickets - 1);
      contract.used.inFlight = Math.max(0, contract.used.inFlight - 1);
    }
    this.onChange?.();
  }

  /** Hand a concurrency slot back once the branch that holds it settles. */
  release(nonce: string): boolean {
    const contractId = this.outstanding.get(nonce);
    if (!contractId) return false;
    this.outstanding.delete(nonce);
    const contract = this.contracts.get(contractId);
    if (contract) contract.used.inFlight = Math.max(0, contract.used.inFlight - 1);
    this.onChange?.();
    return true;
  }

  contractOf(nonce: string): string | undefined {
    return this.outstanding.get(nonce);
  }

  exportState(): { contracts: DelegationContract[]; outstanding: { nonce: string; contractId: string }[] } {
    return {
      contracts: [...this.contracts.values()].map(contract => structuredClone(contract)),
      outstanding: [...this.outstanding.entries()].map(([nonce, contractId]) => ({ nonce, contractId })),
    };
  }

  importState(state: {
    contracts?: DelegationContract[];
    outstanding?: { nonce?: string; contractId?: string }[];
  } | undefined): void {
    this.contracts.clear();
    this.outstanding.clear();
    for (const contract of state?.contracts ?? []) {
      if (contract && typeof contract.id === 'string' && contract.id.trim()) {
        this.contracts.set(contract.id, structuredClone(contract));
      }
    }
    for (const entry of state?.outstanding ?? []) {
      if (entry?.nonce && entry?.contractId && this.contracts.has(entry.contractId)) {
        this.outstanding.set(entry.nonce, entry.contractId);
      }
    }
  }
}

/**
 * Mint one child ticket under a contract. Never touches the child's own rules
 * (TTL ceiling, single nonce, signature): the contract only decides whether a
 * ticket may be minted at all, and with what boundary inside it.
 */
export async function deriveExecutionDelegation(
  contractId: string,
  input: DeriveExecutionDelegationInput,
  context: { registry: DelegationContractRegistry; signer: RosterSigner; verifier?: RosterVerifier; now?: () => Date },
): Promise<DeriveResult> {
  const stored = context.registry.get(contractId);
  if (!stored) return { ok: false, reason: 'unknown-contract' };
  const check = await verifyDelegationContract(stored, {
    ...(context.verifier ? { verifier: context.verifier } : {}),
    ...(context.now ? { now: context.now } : {}),
  });
  if (!check.ok) return check;

  const now = (context.now ?? (() => new Date()))();
  const childCapabilities = normalizeCapabilities(input.capabilities ?? []);
  // Derivation shortens, never widens: subset of the contract's set, the same
  // skill, and still carrying what the dispatch gate will ask for.
  if (
    childCapabilities.length === 0 ||
    !childCapabilities.every(capability => stored.capabilities.includes(capability)) ||
    !childCapabilities.includes(DELEGATION_CONTRACT_REQUIRED_CAPABILITY)
  ) {
    return { ok: false, reason: 'child-capability-not-covered' };
  }
  const childVassal = input.vassal?.trim();
  if (stored.vassal && childVassal && childVassal !== stored.vassal) return { ok: false, reason: 'child-vassal-mismatch' };

  const nonce = input.nonce?.trim() || randomUUID();
  const reserve = context.registry.reserve(contractId, nonce);
  if (!reserve.ok) return reserve;

  // Clamp to the window so a long ask cannot produce a child that outlives the
  // approval it came from; the child's own ceiling still applies on top.
  const windowLeftMs = Date.parse(stored.limits.windowEndsAt) - now.getTime();
  const ttlMs = Math.min(input.ttlMs ?? EXECUTION_DELEGATION_DEFAULT_TTL_MS, windowLeftMs);

  try {
    const delegation = await issueExecutionDelegation(
      {
        grantedBy: stored.grantedBy,
        skill: stored.skill,
        capabilities: childCapabilities,
        ...(childVassal ? { vassal: childVassal } : stored.vassal ? { vassal: stored.vassal } : {}),
        reason: input.reason?.trim()
          ? `${input.reason.trim()} (contract ${contractId})`
          : `derived from contract ${contractId}`,
        ttlMs,
        nonce,
      },
      { signer: context.signer, ...(context.now ? { now: context.now } : {}) },
    );
    return { ok: true, contractId, delegation };
  } catch (error) {
    context.registry.cancelReservation(nonce);
    throw error;
  }
}

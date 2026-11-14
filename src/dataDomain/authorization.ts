/**
 * Cross-domain authorization (design-dataDomain.md §8.3, E6.4).
 *
 * One decision function, so every face that touches a dataDomain (dispatch-time
 * retrieval, the MCP resource handler, the operator API) answers the same
 * question the same way:
 *
 *   personal -> enterprise   needs a DomainGrant, one subject at one dataDomain
 *   enterprise -> personal   refused, and there is deliberately no shape that
 *                            could authorize it
 *   enterprise -> enterprise the tenant subtree rule, structural and NOT
 *                            grant-loosenable
 *
 * A grant is honored only while it is in the registry's live list: `list()`
 * returns grants that have not been revoked, so a revoked credential is not
 * re-presentable. The nonce set is an issuance-uniqueness guard (a nonce cannot
 * be re-used by a later grant, even after the original is revoked), NOT a
 * consumption ledger - these grants stay valid until they expire or are
 * revoked, because they mean "this subject may touch that domain" and not "this
 * one crossing is authorized". The single-use credential is E3.5's
 * OperatorWriteGrant, not this one.
 */
import { randomUUID } from 'node:crypto';
import type { DomainDecision, DomainGrant, DataDomainAccess, DataDomainActor, TenantScope } from './types.js';
import { formatTenant, tenantReaches } from './tenant.js';

export type ScopedDataDomain = {
  dataDomainId: string;
  type: 'personal' | 'enterprise';
  tenant?: TenantScope;
  readOnly: boolean;
};

export type GrantVerification =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'wrong-subject' | 'wrong-dataDomain' | 'wrong-access' | 'expired' };

export function verifyDomainGrant(
  grant: DomainGrant,
  expected: { subject: string; dataDomainId: string; access: DataDomainAccess },
  now: () => Date = () => new Date(),
): GrantVerification {
  const malformed =
    grant.kind !== 'domain-access' ||
    typeof grant.grantId !== 'string' ||
    grant.grantId.length === 0 ||
    typeof grant.subject !== 'string' ||
    grant.subject.length === 0 ||
    typeof grant.dataDomainId !== 'string' ||
    grant.dataDomainId.length === 0 ||
    (grant.access !== 'read' && grant.access !== 'write') ||
    typeof grant.grantedBy !== 'string' ||
    grant.grantedBy.length === 0 ||
    typeof grant.nonce !== 'string' ||
    grant.nonce.length === 0 ||
    Number.isNaN(Date.parse(grant.grantedAt)) ||
    (grant.expiresAt !== undefined && Number.isNaN(Date.parse(grant.expiresAt)));
  if (malformed) return { ok: false, reason: 'malformed' };

  if (grant.subject !== expected.subject) return { ok: false, reason: 'wrong-subject' };
  if (grant.dataDomainId !== expected.dataDomainId) return { ok: false, reason: 'wrong-dataDomain' };
  // A read grant must never be laundered into a write by asking for more.
  if (grant.access !== expected.access) return { ok: false, reason: 'wrong-access' };
  if (grant.expiresAt !== undefined && now().getTime() > Date.parse(grant.expiresAt)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/**
 * The single access decision. `grants` is the set currently on record; expired
 * entries simply never match, so callers can pass the raw list.
 */
export function decideDataDomainAccess(input: {
  actor: DataDomainActor;
  dataDomain: ScopedDataDomain;
  access: DataDomainAccess;
  grants?: DomainGrant[];
  now?: () => Date;
}): DomainDecision {
  const { actor, dataDomain, access } = input;
  const now = input.now ?? (() => new Date());

  const refuse = (reason: Exclude<DomainDecision, { ok: true }>['reason'], detail: string): DomainDecision => ({
    ok: false,
    reason,
    detail,
  });

  if (dataDomain.readOnly && access === 'write') {
    return refuse('read-only', `dataDomain was connected read-only: ${dataDomain.dataDomainId}`);
  }

  // The operator IS the data sovereign: asking is the authorization. Enterprise
  // writes still need the per-write OperatorWriteGrant at the store (E3.5).
  if (actor.kind === 'operator') return { ok: true, via: 'same-domain' };

  const subjectTenant = actor.tenant;

  if (dataDomain.type === 'personal') {
    if (subjectTenant) {
      return refuse(
        'enterprise-to-personal',
        `an enterprise-scoped subject (${formatTenant(subjectTenant)}) may not reach the personal dataDomain ${dataDomain.dataDomainId}`,
      );
    }
    return { ok: true, via: 'same-domain' };
  }

  // Enterprise target from an enterprise-subject: structural hierarchy only.
  if (subjectTenant) {
    if (!dataDomain.tenant || !tenantReaches(subjectTenant, dataDomain.tenant)) {
      return refuse(
        'tenant-out-of-scope',
        `subject ${formatTenant(subjectTenant)} is not at or above dataDomain tenant ${dataDomain.tenant ? formatTenant(dataDomain.tenant) : '(unscoped)'} for ${dataDomain.dataDomainId}`,
      );
    }
    return { ok: true, via: 'tenant-hierarchy' };
  }

  // Personal-side subject into an enterprise dataDomain: needs an explicit grant.
  // A grant that exists but lapsed, or that covers the other access, is reported
  // as such - "no grant" would send the operator looking for a record that is
  // already there.
  let nearMiss: DomainDecision | undefined;
  for (const candidate of input.grants ?? []) {
    const checked = verifyDomainGrant(candidate, { subject: actor.id, dataDomainId: dataDomain.dataDomainId, access }, now);
    if (checked.ok) return { ok: true, via: 'grant', grantId: candidate.grantId };
    if (nearMiss) continue;
    if (checked.reason === 'expired') {
      nearMiss = refuse(
        'grant-expired',
        `grant ${candidate.grantId} for ${actor.id} on ${dataDomain.dataDomainId} expired ${String(candidate.expiresAt)}`,
      );
    } else if (checked.reason === 'wrong-access') {
      nearMiss = refuse(
        'access-not-granted',
        `grant ${candidate.grantId} covers ${candidate.access} only, not ${access}, for ${actor.id} on ${dataDomain.dataDomainId}`,
      );
    }
  }
  if (nearMiss) return nearMiss;
  return refuse(
    'no-grant',
    `subject ${actor.id} has no ${access} grant for enterprise dataDomain ${dataDomain.dataDomainId}`,
  );
}

export class DomainGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainGrantError';
  }
}

export type GrantAuditEntry = {
  at: string;
  decision: 'grant-issued' | 'grant-revoked';
  grantId: string;
  subject: string;
  dataDomainId: string;
  access: DataDomainAccess;
  grantedBy: string;
};

/** What the runtime persists: the live grants plus every nonce ever issued, so a
 *  restart neither widens access (a revoked grant stays revoked) nor re-admits
 *  a nonce for a new grant. */
export type DomainGrantState = { grants: DomainGrant[]; spentNonces: string[] };

/**
 * Live set of cross-domain grants. In-memory with an exportable snapshot (the
 * runtime persists it on every issue/revoke, so a restart neither silently
 * widens nor silently drops an authorization).
 *
 * `seenNonces` holds every nonce this registry ever minted, live or revoked
 * (hence the persisted key `spentNonces`); it exists to keep nonces unique
 * across grants, not to mark a grant consumed - see the file header.
 */
export class DomainGrantRegistry {
  private grants = new Map<string, DomainGrant>();
  private seenNonces = new Set<string>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly audit: (entry: GrantAuditEntry) => void = () => {},
  ) {}

  /** Ids of every grant currently on record (expired ones still answer: the
   *  verifier decides, so callers cannot disagree about what is live). */
  list(): DomainGrant[] {
    return [...this.grants.values()].map(grant => structuredClone(grant));
  }

  get(grantId: string): DomainGrant | undefined {
    const found = this.grants.get(grantId);
    return found ? structuredClone(found) : undefined;
  }

  issue(input: Omit<DomainGrant, 'kind' | 'grantId' | 'grantedAt' | 'nonce'> & { grantId?: string; nonce?: string }): DomainGrant {
    const grantId = input.grantId?.trim() || `grant-${this.now().getTime().toString(36)}-${this.grants.size + 1}`;
    if (this.grants.has(grantId)) throw new DomainGrantError(`grant already exists: ${grantId}`);
    // The nonce is minted here, not supplied by whoever asks: it exists so a
    // revoked-or-spent credential can never be re-presented as fresh, and an
    // operator inventing entropy by hand is how that guarantee gets lost.
    const nonce = input.nonce?.trim() || randomUUID();
    if (this.seenNonces.has(nonce)) throw new DomainGrantError(`nonce already used by an earlier grant: ${nonce}`);
    if (input.access !== 'read' && input.access !== 'write') throw new DomainGrantError(`access must be read or write, got ${String(input.access)}`);
    for (const field of ['subject', 'dataDomainId', 'grantedBy'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new DomainGrantError(`${field} is required`);
      }
    }
    if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new DomainGrantError(`expiresAt is not a valid date: ${input.expiresAt}`);
    }

    const grant: DomainGrant = {
      kind: 'domain-access',
      grantId,
      subject: input.subject.trim(),
      dataDomainId: input.dataDomainId.trim(),
      access: input.access,
      grantedBy: input.grantedBy.trim(),
      ...(input.reason ? { reason: input.reason } : {}),
      grantedAt: this.now().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      nonce,
    };
    this.grants.set(grantId, grant);
    this.seenNonces.add(nonce);
    this.audit({
      at: grant.grantedAt,
      decision: 'grant-issued',
      grantId,
      subject: grant.subject,
      dataDomainId: grant.dataDomainId,
      access: grant.access,
      grantedBy: grant.grantedBy,
    });
    return structuredClone(grant);
  }

  revoke(grantId: string): DomainGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new DomainGrantError(`unknown grant: ${grantId}`);
    this.grants.delete(grantId);
    // The nonce stays spent: revoking must not make a replayed credential valid.
    this.audit({
      at: this.now().toISOString(),
      decision: 'grant-revoked',
      grantId,
      subject: grant.subject,
      dataDomainId: grant.dataDomainId,
      access: grant.access,
      grantedBy: grant.grantedBy,
    });
    return structuredClone(grant);
  }

  /** For decideDataDomainAccess: the live list, cheap to hand out. */
  decisionsInput(): DomainGrant[] {
    return this.list();
  }

  exportState(): DomainGrantState {
    return {
      grants: this.list(),
      spentNonces: [...this.seenNonces],
    };
  }

  importState(state: DomainGrantState | undefined): void {
    if (!state) return;
    for (const grant of state.grants ?? []) {
      if (!grant?.grantId) continue;
      this.grants.set(grant.grantId, structuredClone(grant));
    }
    for (const nonce of state.spentNonces ?? []) this.seenNonces.add(nonce);
  }
}

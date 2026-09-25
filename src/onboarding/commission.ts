/**
 * Commission ledger and gate (E9.1 / E9.2).
 *
 * "上岗即用" is only worth building if the gate can actually refuse. So each of
 * the four stages reads its evidence from the layer that owns it:
 *
 *   seat          - the department establishment (OrgRegistry, E9.3)
 *   account       - the live vassal directory (revoked or unknown both refuse)
 *   authorization - decideRealmAccess (E3.6 tenancy + E6.4 grants)
 *   mentorship    - certified MentorshipLedger records (E2.5: certification came
 *                   from competency checks, not attendance)
 *
 * Nothing here caches those facts. `commission()` checks them at the moment of
 * decision, and first-task eligibility re-checks them again, so revoking a
 * vassal or dismissing its mentorship retires the commission without anyone
 * having to remember to edit a record.
 */
import type { VassalLookup } from '../registry/registry.js';
import type { OrgRegistry } from '../org/registry.js';
import type { MentorshipLedger } from '../skills/mentor.js';
import { decideRealmAccess, type DomainGrantRegistry } from '../realm/authorization.js';
import { formatTenant, normalizeTenant, tenantReaches } from '../realm/tenant.js';
import type { RealmActor, RealmStore, TenantScope } from '../realm/types.js';
import {
  commissionId,
  CommissionError,
  type CommissionCheck,
  type CommissionGate,
  type EvidenceGate,
  type CommissionRecord,
  type CommissionStage,
  type CommissionVerdict,
  type MentorshipCheck,
} from './types.js';

export type CommissionDeps = {
  org: Pick<OrgRegistry, 'listDepartments'>;
  vassals: VassalLookup;
  realms: Pick<RealmStore, 'connections'>;
  grants: Pick<DomainGrantRegistry, 'list'>;
  mentorships: Pick<MentorshipLedger, 'list'>;
  now?: () => Date;
};

export type CommissionAuditEntry = {
  at: string;
  decision: 'commission-granted' | 'commission-waived' | 'commission-withdrawn' | 'commission-refused';
  commissionId: string;
  agentId: string;
  departmentId: string;
  by: string;
  detail: string;
};

export type OpenCommissionInput = {
  agentId: string;
  departmentId: string;
  realmId: string;
  tenant?: string | TenantScope;
  requiredSkills?: string[];
  openedBy: string;
};

const pass = (reason: string): CommissionCheck => ({ ok: true, reason });
const fail = (reason: string): CommissionCheck => ({ ok: false, reason });

export function verifyCommission(
  record: CommissionRecord,
  deps: CommissionDeps,
): CommissionVerdict {
  const now = deps.now ?? (() => new Date());

  const department = deps.org.listDepartments().find(entry => entry.departmentId === record.departmentId);
  const seatMember = department?.members.find(member => member.agentId === record.agentId);
  const seat: CommissionCheck = !department
    ? fail(`unknown department ${record.departmentId}`)
    : seatMember
      ? pass(`${record.agentId} holds the ${seatMember.role} seat${seatMember.title ? ` "${seatMember.title}"` : ''} of ${department.name}`)
      : fail(`${record.agentId} is not on the ${department.name} roster (assign it first)`);

  const status = deps.vassals.statusOf(record.agentId);
  const account: CommissionCheck =
    status === 'active'
      ? pass('vassal registered and active')
      : status === 'revoked'
        ? fail(`vassal ${record.agentId} has been revoked`)
        : fail(`no vassal named ${record.agentId} is registered (an org member with no card cannot be dispatched)`);

  const realm = deps.realms.connections().find(entry => entry.realmId === record.realmId);
  let authorization: CommissionCheck;
  if (!realm) {
    authorization = fail(`realm not connected: ${record.realmId}`);
  } else {
    const actor: RealmActor = record.tenant
      ? { kind: 'agent', id: record.agentId, tenant: record.tenant }
      : { kind: 'agent', id: record.agentId };
    const read = decideRealmAccess({ actor, realm, access: 'read', grants: deps.grants.list(), now });
    authorization = read.ok
      ? pass(`read of ${record.realmId} allowed via ${read.via}${realm.tenant ? ` (realm tenant ${formatTenant(realm.tenant)})` : ''}`)
      : fail(read.detail);
  }

  const certified = deps.mentorships
    .list({ status: 'certified' })
    .filter(entry => entry.learnerId === record.agentId);
  const certifiedIds = new Set(certified.map(entry => entry.skillId));
  const missing = record.requiredSkills.filter(skillId => !certifiedIds.has(skillId));
  // Requirements always win: a waiver cannot cover a seat that does state them,
  // otherwise one careless waive call would empty the gate it was meant to skip.
  const waived = missing.length === 0 && record.requiredSkills.length === 0 && Boolean(record.waiver);
  const mentorship: MentorshipCheck = {
    ...(record.requiredSkills.length === 0
      ? waived
        ? pass(`no competencies required for this seat (waived by ${record.waiver?.by}: ${record.waiver?.reason})`)
        : fail('this seat states no required competencies and no waiver - list them or waive the stage explicitly')
      : missing.length === 0
        ? pass(`certified in ${record.requiredSkills.join(', ')}`)
        : fail(`missing certification for ${missing.join(', ')}`)),
    certified: certified.map(entry => ({
      skillId: entry.skillId,
      version: entry.version,
      mentorId: entry.mentorId,
      score: entry.score,
      ...(entry.certifiedAt ? { certifiedAt: entry.certifiedAt } : {}),
    })),
    missing,
    waived,
  };

  const blockers: string[] = [];
  if (!seat.ok) blockers.push(`seat: ${seat.reason}`);
  if (!account.ok) blockers.push(`account: ${account.reason}`);
  if (!authorization.ok) blockers.push(`authorization: ${authorization.reason}`);
  if (!mentorship.ok) blockers.push(`mentorship: ${mentorship.reason}`);
  const commission: CommissionCheck = !record.commissioned
    ? fail('not commissioned yet')
    : record.withdrawn
      ? fail(`commission was withdrawn by ${record.withdrawn.by}: ${record.withdrawn.reason}`)
      : blockers.length > 0
        ? fail(`commission is stale - ${blockers.join('; ')}`)
        : pass(`commissioned by ${record.commissioned.by} at ${record.commissioned.at}`);

  // Stage reports what has actually been achieved, in order - a seat that is
  // merely "assigned" is still 'opened', not a stage of its own.
  let stage: CommissionStage = 'opened';
  if (seat.ok && account.ok) stage = 'account';
  if (seat.ok && account.ok && authorization.ok) stage = 'authorization';
  if (seat.ok && account.ok && authorization.ok && mentorship.ok) stage = 'mentorship';
  if (commission.ok) stage = 'commissioned';

  const blockedOn = !seat.ok
    ? 'seat'
    : !account.ok
      ? 'account'
      : !authorization.ok
        ? 'authorization'
        : !mentorship.ok
          ? 'mentorship'
          : !commission.ok
            ? 'commissioned'
            : null;

  return {
    id: record.id,
    departmentId: record.departmentId,
    agentId: record.agentId,
    stage,
    blockedOn,
    checks: { seat, account, authorization, mentorship, commission },
    ...(record.commissioned ? { commissionedAt: record.commissioned.at } : {}),
  };
}

export class CommissionLedger {
  private records = new Map<string, CommissionRecord>();

  constructor(
    private readonly deps: CommissionDeps,
    private readonly now: () => Date = () => new Date(),
    private readonly audit: (entry: CommissionAuditEntry) => void = () => {},
  ) {}

  /** Open a commissioning file. Fails early on a seat or realm that cannot hold
   *  one, so a driver never discovers at commission time that the paperwork was
   *  for a department that does not exist. */
  open(input: OpenCommissionInput): CommissionRecord {
    const agentId = input.agentId?.trim();
    const openedBy = input.openedBy?.trim();
    if (!agentId) throw new CommissionError('agentId is required', 'invalid');
    if (!openedBy) throw new CommissionError('openedBy is required (onboarding needs an author)', 'invalid');

    const department = this.deps.org.listDepartments().find(entry => entry.departmentId === input.departmentId);
    if (!department) throw new CommissionError(`unknown department ${input.departmentId}`, 'not-found');
    if (!department.members.some(member => member.agentId === agentId)) {
      throw new CommissionError(`${agentId} is not on the ${department.name} roster; assign the seat first`, 'invalid');
    }

    const realm = this.deps.realms.connections().find(entry => entry.realmId === input.realmId);
    if (!realm) throw new CommissionError(`realm not connected: ${input.realmId}`, 'not-found');
    const tenant = normalizeTenant(input.tenant);
    if (tenant && realm.type !== 'enterprise') {
      throw new CommissionError(`a tenant scope belongs to an enterprise realm, not '${realm.type}': ${formatTenant(tenant)}`, 'invalid');
    }
    // A seat may be scoped at or below its realm, never above it: placing an
    // agent in one department with org-wide scope would hand it the siblings.
    if (tenant && realm.tenant && !tenantReaches(realm.tenant, tenant)) {
      throw new CommissionError(
        `a seat in realm tenant ${formatTenant(realm.tenant)} cannot be scoped broader than it (${formatTenant(tenant)}); place it at or below the realm's own scope`,
        'invalid',
      );
    }
    if (realm.type === 'enterprise' && !tenant && !realm.tenant) {
      throw new CommissionError(
        `cannot place ${agentId} in enterprise realm ${realm.realmId} without a tenant scope (the realm itself is unscoped)`,
        'invalid',
      );
    }

    const id = commissionId(department.departmentId, agentId);
    const existing = this.records.get(id);
    if (existing && !existing.withdrawn) throw new CommissionError(`commission file already open: ${id}`, 'conflict');

    const record: CommissionRecord = {
      format: 'zeus-commission',
      version: 1,
      id,
      departmentId: department.departmentId,
      agentId,
      realmId: realm.realmId,
      ...(tenant ?? realm.tenant ? { tenant: tenant ?? (realm.tenant as TenantScope) } : {}),
      requiredSkills: [...new Set((input.requiredSkills ?? []).map(skill => skill.trim()).filter(Boolean))],
      openedAt: this.now().toISOString(),
      openedBy,
    };
    this.records.set(id, record);
    return structuredClone(record);
  }

  waiveMentorship(id: string, input: { reason: string; by: string }): CommissionRecord {
    const record = this.require(id);
    const reason = input.reason?.trim();
    const by = input.by?.trim();
    if (!reason) throw new CommissionError('a mentorship waiver needs a reason', 'invalid');
    if (!by) throw new CommissionError('a mentorship waiver needs an author', 'invalid');
    if (record.requiredSkills.length > 0) {
      throw new CommissionError(
        `this seat requires ${record.requiredSkills.join(', ')}; a waiver cannot cover a stated requirement - remove the requirement or certify it`,
        'invalid',
      );
    }
    const waiver = { reason, by, at: this.now().toISOString() };
    const next: CommissionRecord = { ...record, waiver };
    this.records.set(id, next);
    this.audit({
      at: waiver.at,
      decision: 'commission-waived',
      commissionId: id,
      agentId: record.agentId,
      departmentId: record.departmentId,
      by,
      detail: `mentorship waived: ${reason}`,
    });
    return structuredClone(next);
  }

  /** The gate itself: nothing is recorded unless every stage verifies now. */
  commission(id: string, input: { by: string; note?: string }): CommissionRecord {
    const record = this.require(id);
    const by = input.by?.trim();
    if (!by) throw new CommissionError('commissioning needs an author (who decided)', 'invalid');
    const verdict = verifyCommission(record, { ...this.deps, now: this.now });
    const unmet = firstUnmetEvidenceGate(verdict);
    if (unmet) {
      const reason = verdict.checks[unmet].reason;
      this.audit({
        at: this.now().toISOString(),
        decision: 'commission-refused',
        commissionId: id,
        agentId: record.agentId,
        departmentId: record.departmentId,
        by,
        detail: `${unmet}: ${reason}`,
      });
      throw new CommissionError(`cannot commission ${record.agentId} yet - ${unmet}: ${reason}`, 'gate', { blockedOn: unmet, reason });
    }
    const commissioned = { by, at: this.now().toISOString(), ...(input.note ? { note: input.note } : {}) };
    const next: CommissionRecord = { ...record, commissioned };
    delete next.withdrawn;
    this.records.set(id, next);
    this.audit({
      at: commissioned.at,
      decision: 'commission-granted',
      commissionId: id,
      agentId: record.agentId,
      departmentId: record.departmentId,
      by,
      detail: `commissioned for ${record.realmId}${next.tenant ? ` (tenant ${formatTenant(next.tenant)})` : ''}`,
    });
    return structuredClone(next);
  }

  withdraw(id: string, input: { by: string; reason: string }): CommissionRecord {
    const record = this.require(id);
    if (!record.commissioned) throw new CommissionError(`${id} was never commissioned; nothing to withdraw`, 'conflict');
    if (!input.by?.trim() || !input.reason?.trim()) throw new CommissionError('withdrawing needs an author and a reason', 'invalid');
    const withdrawn = { by: input.by.trim(), at: this.now().toISOString(), reason: input.reason.trim() };
    const next: CommissionRecord = { ...record, withdrawn };
    this.records.set(id, next);
    this.audit({
      at: withdrawn.at,
      decision: 'commission-withdrawn',
      commissionId: id,
      agentId: record.agentId,
      departmentId: record.departmentId,
      by: withdrawn.by,
      detail: `commission withdrawn: ${withdrawn.reason}`,
    });
    return structuredClone(next);
  }

  verify(id: string): CommissionVerdict {
    return verifyCommission(this.require(id), { ...this.deps, now: this.now });
  }

  /**
   * The gate a first task must pass: commissioned, and every evidence gate
   * still holding *now*. A vassal revoked or a mentorship dismissed after the
   * sign-off takes the eligibility away by itself.
   */
  assertCommissioned(id: string): CommissionRecord {
    const record = this.require(id);
    const verdict = verifyCommission(record, { ...this.deps, now: this.now });
    const unmet = firstUnmetEvidenceGate(verdict) ?? (verdict.checks.commission.ok ? null : 'commissioned');
    if (unmet) {
      const reason = unmet === 'commissioned' ? verdict.checks.commission.reason : verdict.checks[unmet].reason;
      throw new CommissionError(`${record.agentId} cannot take this task - ${unmet}: ${reason}`, 'gate', {
        blockedOn: unmet,
        reason,
      });
    }
    return structuredClone(record);
  }

    get(id: string): CommissionRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  list(filter: { departmentId?: string; agentId?: string } = {}): CommissionRecord[] {
    return [...this.records.values()]
      .filter(record =>
        (!filter.departmentId || record.departmentId === filter.departmentId) &&
        (!filter.agentId || record.agentId === filter.agentId))
      .map(record => structuredClone(record))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  exportState(): CommissionRecord[] {
    return [...this.records.values()].map(record => structuredClone(record));
  }

  importState(records: CommissionRecord[]): void {
    this.records = new Map(records.map(record => {
      const clone = structuredClone(record);
      if (!clone.id && clone.departmentId && clone.agentId) {
        clone.id = commissionId(clone.departmentId, clone.agentId);
      }
      return [clone.id, clone];
    }));
  }

  private require(id: string): CommissionRecord {
    const record = this.records.get(id);
    if (!record) throw new CommissionError(`no commission file: ${id}`, 'not-found');
    return record;
  }

}

/** The first of the four evidence gates that does not hold, or null. */
export function firstUnmetEvidenceGate(verdict: CommissionVerdict): EvidenceGate | null {
  for (const gate of ['seat', 'account', 'authorization', 'mentorship'] as const) {
    if (!verdict.checks[gate].ok) return gate;
  }
  return null;
}

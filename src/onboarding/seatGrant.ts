/**
 * SeatGrant ledger and gate (E9.1 / E9.2).
 *
 * "上岗即用" is only worth building if the gate can actually refuse. So each of
 * the four stages reads its evidence from the layer that owns it:
 *
 *   seat          - the department establishment (OrgRegistry, E9.3)
 *   account       - the live executor directory (revoked or unknown both refuse)
 *   authorization - decideDataDomainAccess (E3.6 tenancy + E6.4 grants)
 *   mentorship    - certified MentorshipLedger records (E2.5: certification came
 *                   from competency checks, not attendance)
 *
 * Nothing here caches those facts. `seatGrant()` checks them at the moment of
 * decision, and first-task eligibility re-checks them again, so revoking a
 * executor or dismissing its mentorship retires the seatGrant without anyone
 * having to remember to edit a record.
 */
import type { ExecutorLookup } from '../registry/registry.js';
import type { OrgRegistry } from '../org/registry.js';
import type { MentorshipLedger } from '../skills/mentor.js';
import { decideDataDomainAccess, type DomainGrantRegistry } from '../dataDomain/authorization.js';
import { formatTenant, normalizeTenant, tenantReaches } from '../dataDomain/tenant.js';
import type { DataDomainActor, DataDomainStore, TenantScope } from '../dataDomain/types.js';
import {
  seatGrantId,
  SeatGrantError,
  type SeatGrantCheck,
  type EvidenceGate,
  type SeatGrantRecord,
  type SeatGrantStage,
  type SeatGrantVerdict,
  type MentorshipCheck,
} from './types.js';

export type SeatGrantDeps = {
  org: Pick<OrgRegistry, 'listDepartments'>;
  executors: ExecutorLookup;
  dataDomains: Pick<DataDomainStore, 'connections'>;
  grants: Pick<DomainGrantRegistry, 'list'>;
  mentorships: Pick<MentorshipLedger, 'list'>;
  now?: () => Date;
};

export type SeatGrantAuditEntry = {
  at: string;
  decision: 'seatGrant-granted' | 'seatGrant-waived' | 'seatGrant-withdrawn' | 'seatGrant-refused';
  seatGrantId: string;
  agentId: string;
  departmentId: string;
  by: string;
  detail: string;
};

export type OpenSeatGrantInput = {
  agentId: string;
  departmentId: string;
  dataDomainId: string;
  tenant?: string | TenantScope;
  requiredSkills?: string[];
  openedBy: string;
};

const pass = (reason: string): SeatGrantCheck => ({ ok: true, reason });
const fail = (reason: string): SeatGrantCheck => ({ ok: false, reason });

export function verifySeatGrant(
  record: SeatGrantRecord,
  deps: SeatGrantDeps,
): SeatGrantVerdict {
  const now = deps.now ?? (() => new Date());

  const department = deps.org.listDepartments().find(entry => entry.departmentId === record.departmentId);
  const seatMember = department?.members.find(member => member.agentId === record.agentId);
  const seat: SeatGrantCheck = !department
    ? fail(`unknown department ${record.departmentId}`)
    : seatMember
      ? pass(`${record.agentId} holds the ${seatMember.role} seat${seatMember.title ? ` "${seatMember.title}"` : ''} of ${department.name}`)
      : fail(`${record.agentId} is not on the ${department.name} roster (assign it first)`);

  const status = deps.executors.statusOf(record.agentId);
  const account: SeatGrantCheck =
    status === 'active'
      ? pass('executor registered and active')
      : status === 'revoked'
        ? fail(`executor ${record.agentId} has been revoked`)
        : fail(`no executor named ${record.agentId} is registered (an org member with no card cannot be dispatched)`);

  const dataDomain = deps.dataDomains.connections().find(entry => entry.dataDomainId === record.dataDomainId);
  let authorization: SeatGrantCheck;
  if (!dataDomain) {
    authorization = fail(`dataDomain not connected: ${record.dataDomainId}`);
  } else {
    const actor: DataDomainActor = record.tenant
      ? { kind: 'agent', id: record.agentId, tenant: record.tenant }
      : { kind: 'agent', id: record.agentId };
    const read = decideDataDomainAccess({ actor, dataDomain, access: 'read', grants: deps.grants.list(), now });
    authorization = read.ok
      ? pass(`read of ${record.dataDomainId} allowed via ${read.via}${dataDomain.tenant ? ` (dataDomain tenant ${formatTenant(dataDomain.tenant)})` : ''}`)
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
  const seatGrant: SeatGrantCheck = !record.seatGranted
    ? fail('not seatGranted yet')
    : record.withdrawn
      ? fail(`seatGrant was withdrawn by ${record.withdrawn.by}: ${record.withdrawn.reason}`)
      : blockers.length > 0
        ? fail(`seatGrant is stale - ${blockers.join('; ')}`)
        : pass(`seatGranted by ${record.seatGranted.by} at ${record.seatGranted.at}`);

  // Stage reports what has actually been achieved, in order - a seat that is
  // merely "assigned" is still 'opened', not a stage of its own.
  let stage: SeatGrantStage = 'opened';
  if (seat.ok && account.ok) stage = 'account';
  if (seat.ok && account.ok && authorization.ok) stage = 'authorization';
  if (seat.ok && account.ok && authorization.ok && mentorship.ok) stage = 'mentorship';
  if (seatGrant.ok) stage = 'seatGranted';

  const blockedOn = !seat.ok
    ? 'seat'
    : !account.ok
      ? 'account'
      : !authorization.ok
        ? 'authorization'
        : !mentorship.ok
          ? 'mentorship'
          : !seatGrant.ok
            ? 'seatGranted'
            : null;

  return {
    id: record.id,
    departmentId: record.departmentId,
    agentId: record.agentId,
    stage,
    blockedOn,
    checks: { seat, account, authorization, mentorship, seatGrant },
    ...(record.seatGranted ? { seatGrantedAt: record.seatGranted.at } : {}),
  };
}

export class SeatGrantLedger {
  private records = new Map<string, SeatGrantRecord>();

  constructor(
    private readonly deps: SeatGrantDeps,
    private readonly now: () => Date = () => new Date(),
    private readonly audit: (entry: SeatGrantAuditEntry) => void = () => {},
  ) {}

  /** Open a seatGranting file. Fails early on a seat or dataDomain that cannot hold
   *  one, so a operator never discovers at seatGrant time that the paperwork was
   *  for a department that does not exist. */
  open(input: OpenSeatGrantInput): SeatGrantRecord {
    const agentId = input.agentId?.trim();
    const openedBy = input.openedBy?.trim();
    if (!agentId) throw new SeatGrantError('agentId is required', 'invalid');
    if (!openedBy) throw new SeatGrantError('openedBy is required (onboarding needs an author)', 'invalid');

    const department = this.deps.org.listDepartments().find(entry => entry.departmentId === input.departmentId);
    if (!department) throw new SeatGrantError(`unknown department ${input.departmentId}`, 'not-found');
    if (!department.members.some(member => member.agentId === agentId)) {
      throw new SeatGrantError(`${agentId} is not on the ${department.name} roster; assign the seat first`, 'invalid');
    }

    const dataDomain = this.deps.dataDomains.connections().find(entry => entry.dataDomainId === input.dataDomainId);
    if (!dataDomain) throw new SeatGrantError(`dataDomain not connected: ${input.dataDomainId}`, 'not-found');
    const tenant = normalizeTenant(input.tenant);
    if (tenant && dataDomain.type !== 'enterprise') {
      throw new SeatGrantError(`a tenant scope belongs to an enterprise dataDomain, not '${dataDomain.type}': ${formatTenant(tenant)}`, 'invalid');
    }
    // A seat may be scoped at or below its dataDomain, never above it: placing an
    // agent in one department with org-wide scope would hand it the siblings.
    if (tenant && dataDomain.tenant && !tenantReaches(dataDomain.tenant, tenant)) {
      throw new SeatGrantError(
        `a seat in dataDomain tenant ${formatTenant(dataDomain.tenant)} cannot be scoped broader than it (${formatTenant(tenant)}); place it at or below the dataDomain's own scope`,
        'invalid',
      );
    }
    if (dataDomain.type === 'enterprise' && !tenant && !dataDomain.tenant) {
      throw new SeatGrantError(
        `cannot place ${agentId} in enterprise dataDomain ${dataDomain.dataDomainId} without a tenant scope (the dataDomain itself is unscoped)`,
        'invalid',
      );
    }

    const id = seatGrantId(department.departmentId, agentId);
    const existing = this.records.get(id);
    if (existing && !existing.withdrawn) throw new SeatGrantError(`seatGrant file already open: ${id}`, 'conflict');

    const record: SeatGrantRecord = {
      format: 'zeus-seatGrant',
      version: 1,
      id,
      departmentId: department.departmentId,
      agentId,
      dataDomainId: dataDomain.dataDomainId,
      ...(tenant ?? dataDomain.tenant ? { tenant: tenant ?? (dataDomain.tenant as TenantScope) } : {}),
      requiredSkills: [...new Set((input.requiredSkills ?? []).map(skill => skill.trim()).filter(Boolean))],
      openedAt: this.now().toISOString(),
      openedBy,
    };
    this.records.set(id, record);
    return structuredClone(record);
  }

  waiveMentorship(id: string, input: { reason: string; by: string }): SeatGrantRecord {
    const record = this.require(id);
    const reason = input.reason?.trim();
    const by = input.by?.trim();
    if (!reason) throw new SeatGrantError('a mentorship waiver needs a reason', 'invalid');
    if (!by) throw new SeatGrantError('a mentorship waiver needs an author', 'invalid');
    if (record.requiredSkills.length > 0) {
      throw new SeatGrantError(
        `this seat requires ${record.requiredSkills.join(', ')}; a waiver cannot cover a stated requirement - remove the requirement or certify it`,
        'invalid',
      );
    }
    const waiver = { reason, by, at: this.now().toISOString() };
    const next: SeatGrantRecord = { ...record, waiver };
    this.records.set(id, next);
    this.audit({
      at: waiver.at,
      decision: 'seatGrant-waived',
      seatGrantId: id,
      agentId: record.agentId,
      departmentId: record.departmentId,
      by,
      detail: `mentorship waived: ${reason}`,
    });
    return structuredClone(next);
  }

  /** The gate itself: nothing is recorded unless every stage verifies now. */
  seatGrant(id: string, input: { by: string; note?: string }): SeatGrantRecord {
    const record = this.require(id);
    const by = input.by?.trim();
    if (!by) throw new SeatGrantError('seatGranting needs an author (who decided)', 'invalid');
    const verdict = verifySeatGrant(record, { ...this.deps, now: this.now });
    const unmet = firstUnmetEvidenceGate(verdict);
    if (unmet) {
      const reason = verdict.checks[unmet].reason;
      this.audit({
        at: this.now().toISOString(),
        decision: 'seatGrant-refused',
        seatGrantId: id,
        agentId: record.agentId,
        departmentId: record.departmentId,
        by,
        detail: `${unmet}: ${reason}`,
      });
      throw new SeatGrantError(`cannot seatGrant ${record.agentId} yet - ${unmet}: ${reason}`, 'gate', { blockedOn: unmet, reason });
    }
    const seatGranted = { by, at: this.now().toISOString(), ...(input.note ? { note: input.note } : {}) };
    const next: SeatGrantRecord = { ...record, seatGranted };
    delete next.withdrawn;
    this.records.set(id, next);
    this.audit({
      at: seatGranted.at,
      decision: 'seatGrant-granted',
      seatGrantId: id,
      agentId: record.agentId,
      departmentId: record.departmentId,
      by,
      detail: `seatGranted for ${record.dataDomainId}${next.tenant ? ` (tenant ${formatTenant(next.tenant)})` : ''}`,
    });
    return structuredClone(next);
  }

  withdraw(id: string, input: { by: string; reason: string }): SeatGrantRecord {
    const record = this.require(id);
    if (!record.seatGranted) throw new SeatGrantError(`${id} was never seatGranted; nothing to withdraw`, 'conflict');
    if (!input.by?.trim() || !input.reason?.trim()) throw new SeatGrantError('withdrawing needs an author and a reason', 'invalid');
    const withdrawn = { by: input.by.trim(), at: this.now().toISOString(), reason: input.reason.trim() };
    const next: SeatGrantRecord = { ...record, withdrawn };
    this.records.set(id, next);
    this.audit({
      at: withdrawn.at,
      decision: 'seatGrant-withdrawn',
      seatGrantId: id,
      agentId: record.agentId,
      departmentId: record.departmentId,
      by: withdrawn.by,
      detail: `seatGrant withdrawn: ${withdrawn.reason}`,
    });
    return structuredClone(next);
  }

  verify(id: string): SeatGrantVerdict {
    return verifySeatGrant(this.require(id), { ...this.deps, now: this.now });
  }

  /**
   * The gate a first task must pass: seatGranted, and every evidence gate
   * still holding *now*. A executor revoked or a mentorship dismissed after the
   * sign-off takes the eligibility away by itself.
   */
  assertSeatGranted(id: string): SeatGrantRecord {
    const record = this.require(id);
    const verdict = verifySeatGrant(record, { ...this.deps, now: this.now });
    const unmet = firstUnmetEvidenceGate(verdict) ?? (verdict.checks.seatGrant.ok ? null : 'seatGranted');
    if (unmet) {
      const reason = unmet === 'seatGranted' ? verdict.checks.seatGrant.reason : verdict.checks[unmet].reason;
      throw new SeatGrantError(`${record.agentId} cannot take this task - ${unmet}: ${reason}`, 'gate', {
        blockedOn: unmet,
        reason,
      });
    }
    return structuredClone(record);
  }

    get(id: string): SeatGrantRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  list(filter: { departmentId?: string; agentId?: string } = {}): SeatGrantRecord[] {
    return [...this.records.values()]
      .filter(record =>
        (!filter.departmentId || record.departmentId === filter.departmentId) &&
        (!filter.agentId || record.agentId === filter.agentId))
      .map(record => structuredClone(record))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  exportState(): SeatGrantRecord[] {
    return [...this.records.values()].map(record => structuredClone(record));
  }

  importState(records: SeatGrantRecord[]): void {
    this.records = new Map(records.map(record => {
      const clone = structuredClone(record);
      if (!clone.id && clone.departmentId && clone.agentId) {
        clone.id = seatGrantId(clone.departmentId, clone.agentId);
      }
      return [clone.id, clone];
    }));
  }

  private require(id: string): SeatGrantRecord {
    const record = this.records.get(id);
    if (!record) throw new SeatGrantError(`no seatGrant file: ${id}`, 'not-found');
    return record;
  }

}

/** The first of the four evidence gates that does not hold, or null. */
export function firstUnmetEvidenceGate(verdict: SeatGrantVerdict): EvidenceGate | null {
  for (const gate of ['seat', 'account', 'authorization', 'mentorship'] as const) {
    if (!verdict.checks[gate].ok) return gate;
  }
  return null;
}

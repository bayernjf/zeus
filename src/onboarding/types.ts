/**
 * E9.1 / E9.2 onboarding types.
 *
 * The commission record stores only *decisions* (who opened it, who commissioned
 * it, who waived what). Whether the commission is still valid is always
 * recomputed from live evidence - a roster seat that got struck, a vassal that
 * got revoked, a grant that expired or a mentorship that was dismissed must be
 * able to take the commission away without anyone remembering to edit a cache.
 */
import { OrgError } from '../org/types.js';
import type { TenantScope } from '../realm/types.js';

/** The five gates, in the order a seat must clear them. */
export type CommissionGate = 'seat' | 'account' | 'authorization' | 'mentorship' | 'commissioned';

/** The four gates whose evidence comes from another layer; the fifth is the sign-off itself. */
export type EvidenceGate = Exclude<CommissionGate, 'commissioned'>;

export type CommissionStage = 'opened' | 'account' | 'authorization' | 'mentorship' | 'commissioned';

export type CommissionRecord = {
  format: 'zeus-commission';
  version: 1;
  /** `<departmentId>::<agentId>` - one seat per agent per department. */
  id: string;
  departmentId: string;
  agentId: string;
  /** The data domain this seat works in; authorization is judged against it. */
  realmId: string;
  /** E3.6 scope the agent acts at inside an enterprise realm. Never set for a
   *  personal realm - that combination has no meaning and is refused on open. */
  tenant?: TenantScope;
  /** Competencies the seat demands. Empty only with an explicit waiver. */
  requiredSkills: string[];
  openedAt: string;
  openedBy: string;
  waiver?: { reason: string; by: string; at: string };
  commissioned?: { by: string; at: string; note?: string };
  withdrawn?: { by: string; at: string; reason: string };
};

export type CommissionCheck = { ok: boolean; reason: string };

export type MentorshipCheck = CommissionCheck & {
  certified: Array<{ skillId: string; version: string; mentorId: string; score: number; certifiedAt?: string }>;
  missing: string[];
  waived: boolean;
};

export type CommissionVerdict = {
  id: string;
  departmentId: string;
  agentId: string;
  stage: CommissionStage;
  /** The first unmet gate, named after the evidence it needs; null when clear. */
  blockedOn: CommissionGate | null;
  checks: {
    seat: CommissionCheck;
    account: CommissionCheck;
    authorization: CommissionCheck;
    mentorship: MentorshipCheck;
    commission: CommissionCheck;
  };
  commissionedAt?: string;
};

/**
 * Why a commission call failed, as data rather than as message text: the
 * transport maps `kind` to a status, so nobody has to keep a regex of error
 * strings in sync with the gate.
 */
export type CommissionErrorKind = 'invalid' | 'not-found' | 'conflict' | 'gate';

export class CommissionError extends OrgError {
  constructor(
    message: string,
    readonly kind: CommissionErrorKind = 'invalid',
    /** Set when kind is 'gate': which stage refused and why. */
    readonly blocked?: { blockedOn: CommissionGate; reason: string },
  ) {
    super(message);
    this.name = 'CommissionError';
  }
}

export function commissionId(departmentId: string, agentId: string): string {
  return `${departmentId}::${agentId}`;
}

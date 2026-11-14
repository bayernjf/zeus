/**
 * E9.1 / E9.2 onboarding types.
 *
 * The seatGrant record stores only *decisions* (who opened it, who seatGranted
 * it, who waived what). Whether the seatGrant is still valid is always
 * recomputed from live evidence - a roster seat that got struck, a executor that
 * got revoked, a grant that expired or a mentorship that was dismissed must be
 * able to take the seatGrant away without anyone remembering to edit a cache.
 */
import { OrgError } from '../org/types.js';
import type { TenantScope } from '../dataDomain/types.js';

/** The five gates, in the order a seat must clear them. */
export type SeatGrantGate = 'seat' | 'account' | 'authorization' | 'mentorship' | 'seatGranted';

/** The four gates whose evidence comes from another layer; the fifth is the sign-off itself. */
export type EvidenceGate = Exclude<SeatGrantGate, 'seatGranted'>;

export type SeatGrantStage = 'opened' | 'account' | 'authorization' | 'mentorship' | 'seatGranted';

export type SeatGrantRecord = {
  format: 'zeus-seatGrant';
  version: 1;
  /** `<departmentId>::<agentId>` - one seat per agent per department. */
  id: string;
  departmentId: string;
  agentId: string;
  /** The data domain this seat works in; authorization is judged against it. */
  dataDomainId: string;
  /** E3.6 scope the agent acts at inside an enterprise dataDomain. Never set for a
   *  personal dataDomain - that combination has no meaning and is refused on open. */
  tenant?: TenantScope;
  /** Competencies the seat demands. Empty only with an explicit waiver. */
  requiredSkills: string[];
  openedAt: string;
  openedBy: string;
  waiver?: { reason: string; by: string; at: string };
  seatGranted?: { by: string; at: string; note?: string };
  withdrawn?: { by: string; at: string; reason: string };
};

export type SeatGrantCheck = { ok: boolean; reason: string };

export type MentorshipCheck = SeatGrantCheck & {
  certified: Array<{ skillId: string; version: string; mentorId: string; score: number; certifiedAt?: string }>;
  missing: string[];
  waived: boolean;
};

export type SeatGrantVerdict = {
  id: string;
  departmentId: string;
  agentId: string;
  stage: SeatGrantStage;
  /** The first unmet gate, named after the evidence it needs; null when clear. */
  blockedOn: SeatGrantGate | null;
  checks: {
    seat: SeatGrantCheck;
    account: SeatGrantCheck;
    authorization: SeatGrantCheck;
    mentorship: MentorshipCheck;
    seatGrant: SeatGrantCheck;
  };
  seatGrantedAt?: string;
};

/**
 * Why a seatGrant call failed, as data rather than as message text: the
 * transport maps `kind` to a status, so nobody has to keep a regex of error
 * strings in sync with the gate.
 */
export type SeatGrantErrorKind = 'invalid' | 'not-found' | 'conflict' | 'gate';

export class SeatGrantError extends OrgError {
  constructor(
    message: string,
    readonly kind: SeatGrantErrorKind = 'invalid',
    /** Set when kind is 'gate': which stage refused and why. */
    readonly blocked?: { blockedOn: SeatGrantGate; reason: string },
  ) {
    super(message);
    this.name = 'SeatGrantError';
  }
}

export function seatGrantId(departmentId: string, agentId: string): string {
  return `${departmentId}::${agentId}`;
}

/**
 * M4 F4.2 — SOP experience candidates.
 *
 * A settled task is turned into zero or more *candidates* by deterministic
 * rules (no model call). Candidates are inert: they never change the SOP
 * catalog until a human promotes one. That two-stage shape is the whole
 * point — automatic rewriting of the catalog would let one bad task
 * permanently "teach" the org the wrong lesson.
 */

/** Why the insight exists: a failure to avoid, or a success worth repeating. */
export type ExperienceCandidateKind = 'failure-avoidance' | 'success-recipe';

export type ExperienceCandidateStatus = 'pending' | 'promoted';

export interface ExperienceCandidate {
  format: 'zeus-experience-candidate';
  version: 1;
  id: string;
  organizationId: string;
  /** Task the insight was derived from (one task can yield several rules). */
  taskId: string;
  /** Job-family skill id, when the task's required skill maps to one. */
  skillId?: string;
  /** Stable rule id; `(taskId, ruleId)` is the dedupe key. */
  ruleId: string;
  kind: ExperienceCandidateKind;
  title: string;
  detail: string;
  createdAt: string;
  status: ExperienceCandidateStatus;
  promotedAt?: string;
}

/**
 * A promoted candidate as it appears in a catalog query. Deliberately an
 * advisory, not an executable step: a reviewed insight is guidance for the
 * operator/executor, and pretending it is a tool call would fabricate a
 * capability the org does not have.
 */
export interface SopAdvisory {
  id: string;
  candidateId: string;
  skillId: string;
  summary: string;
  detail: string;
  promotedAt: string;
}

/** A catalog entry as returned to readers: static SOP plus promoted advisories. */
export interface PositionSopView {
  skillId: string;
  workflow: string;
  template: string;
  steps: readonly { id: string; order: number; tool: string; requiredGrade: string; humanCheckpoint: boolean; outputs: readonly string[] }[];
  advisories: SopAdvisory[];
}

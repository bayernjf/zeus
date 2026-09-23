import { sha256Hex } from '../util/crypto.js';
import type { SkillRegistry } from './registry.js';
import { SkillNotFoundError } from './registry.js';

/**
 * E2.5 Mentor skill transfer.
 *
 * A mentorship is the auditable path by which an existing provider (mentor)
 * teaches a skill to a learner: commission (mentor must already hold the
 * skill) → teach (lessons recorded) → assess (competency checks, not
 * attendance) → certify. Only a certified learner is registered as a provider,
 * so "学习结果可验证" is enforced: a failed assessment leaves the learner off
 * the team and the skill slot unchanged.
 */

export type MentorshipStatus = 'teaching' | 'certified' | 'failed' | 'dismissed';

/** One competency observation from a supervised practical exercise. */
export interface CompetencyCheck {
  criterion: string;
  /** Hard gates: a failed required check blocks certification regardless of score. */
  required?: boolean;
  /** Relative weight in the aggregate score (default 1). */
  weight?: number;
  passed: boolean;
  /** 0..1 performance on this criterion. */
  score: number;
  note?: string;
}

export interface LessonEntry {
  at: string;
  topic: string;
  /** Optional reference to transferred material (event/resource id). */
  ref?: string;
}

export interface MentorshipRecord {
  id: string;
  skillId: string;
  /** Spec version taught and certified against. */
  version: string;
  mentorId: string;
  learnerId: string;
  realmId?: string;
  status: MentorshipStatus;
  lessons: LessonEntry[];
  checks: CompetencyCheck[];
  /** Aggregate weighted competency score at assessment, 0..1. */
  score: number;
  startedAt: string;
  assessedAt?: string;
  certifiedAt?: string;
  failureReason?: string;
}

export interface CommissionMentorshipInput {
  skillId: string;
  mentorId: string;
  learnerId: string;
  version?: string;
  realmId?: string;
}

export interface AssessOptions {
  /** Weighted score required for certification. Default 0.8. */
  threshold?: number;
}

export class MentorshipError extends Error {}

const DEFAULT_PASS_SCORE = 0.8;

/**
 * Mentorship ledger. Pure aside from the one side effect that certification
 * grants the learner as a provider in the skill registry. Records persist with
 * the kernel snapshot and rebuild on restart.
 */
export class MentorshipLedger {
  private records = new Map<string, MentorshipRecord>();

  constructor(
    private skillRegistry: SkillRegistry,
    private now: () => Date = () => new Date(),
  ) {}

  commission(input: CommissionMentorshipInput): MentorshipRecord {
    const spec = input.version
      ? this.skillRegistry.get(input.skillId, input.version)
      : this.skillRegistry.get(input.skillId);
    if (!spec) throw new SkillNotFoundError(`skill ${input.skillId} not found`);
    if (spec.status !== 'active') {
      throw new MentorshipError(`cannot teach ${input.skillId}@${spec.version} (${spec.status})`);
    }
    if (!this.skillRegistry.isProvider(input.skillId, input.mentorId)) {
      throw new MentorshipError(`${input.mentorId} is not an active provider of ${input.skillId}`);
    }
    if (input.mentorId === input.learnerId) {
      throw new MentorshipError('mentor and learner must be different agents');
    }

    const id = `mentor-${sha256Hex(
      `${spec.version}␟${input.skillId}␟${input.mentorId}␟${input.learnerId}`,
    ).slice(0, 12)}`;
    if (this.records.has(id)) {
      throw new MentorshipError(`mentorship ${id} already exists`);
    }

    const record: MentorshipRecord = {
      id,
      skillId: input.skillId,
      version: spec.version,
      mentorId: input.mentorId,
      learnerId: input.learnerId,
      ...(input.realmId ? { realmId: input.realmId } : {}),
      status: 'teaching',
      lessons: [],
      checks: [],
      score: 0,
      startedAt: this.now().toISOString(),
    };
    this.records.set(id, record);
    return structuredClone(record);
  }

  /** Append taught units while the mentorship is open. */
  teach(id: string, lessons: Array<{ topic: string; ref?: string }>): MentorshipRecord {
    const record = this.requireOpen(id);
    for (const lesson of lessons) {
      record.lessons.push({ at: this.now().toISOString(), ...lesson });
    }
    return structuredClone(record);
  }

  /**
   * Assess the learner's practical competency. Certification requires every
   * required check to pass and an aggregate weighted score at/over threshold;
   * a pass registers the learner as a provider, a fail marks the mentorship
   * failed without touching the provider set.
   */
  assess(id: string, checks: CompetencyCheck[], options: AssessOptions = {}): MentorshipRecord {
    const record = this.requireOpen(id);
    const threshold = options.threshold ?? DEFAULT_PASS_SCORE;
    if (checks.length === 0) throw new MentorshipError('cannot certify without any competency check');
    for (const check of checks) {
      if (check.score < 0 || check.score > 1) {
        throw new MentorshipError(`check '${check.criterion}' score out of range`);
      }
    }

    let weighted = 0;
    let totalWeight = 0;
    for (const check of checks) {
      const weight = check.weight ?? 1;
      weighted += check.score * weight;
      totalWeight += weight;
    }
    const score = totalWeight > 0 ? weighted / totalWeight : 0;
    const failedRequired = checks.some(c => c.required && !c.passed);
    const passes = !failedRequired && score >= threshold;

    record.checks = checks.map(c => ({ ...c }));
    record.score = score;
    record.assessedAt = this.now().toISOString();

    if (passes) {
      this.skillRegistry.grantProvider(record.skillId, record.learnerId, record.version);
      record.status = 'certified';
      record.certifiedAt = this.now().toISOString();
    } else {
      record.status = 'failed';
      record.failureReason = failedRequired
        ? 'failed a required competency check'
        : `competency score ${score.toFixed(2)} below threshold ${threshold}`;
    }
    return structuredClone(record);
  }

  /** Abandon an open mentorship without certifying. */
  dismiss(id: string, reason: string): MentorshipRecord {
    const record = this.requireOpen(id);
    record.status = 'dismissed';
    record.failureReason = reason;
    return structuredClone(record);
  }

  get(id: string): MentorshipRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  list(filter: { status?: MentorshipStatus; skillId?: string } = {}): MentorshipRecord[] {
    return [...this.records.values()]
      .filter(r =>
        (!filter.status || r.status === filter.status) &&
        (!filter.skillId || r.skillId === filter.skillId))
      .map(r => structuredClone(r))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  exportState(): MentorshipRecord[] {
    return [...this.records.values()].map(r => structuredClone(r));
  }

  importState(records: MentorshipRecord[]): void {
    this.records = new Map(records.map(r => {
      const clone = structuredClone(r);
      return [clone.id, clone];
    }));
  }

  private requireOpen(id: string): MentorshipRecord {
    const record = this.records.get(id);
    if (!record) throw new MentorshipError(`mentorship ${id} not found`);
    if (record.status !== 'teaching') {
      throw new MentorshipError(`mentorship ${id} is ${record.status}, not open`);
    }
    return record;
  }
}

/**
 * Durable experience candidate store (F4.2). Same thin-mapping stance as the
 * other SQLite stores: the table is the schema, this class only moves rows.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ExperienceStore } from '../org/experience/store.js';
import type { ExperienceCandidate, ExperienceCandidateKind } from '../org/experience/types.js';

interface Row {
  id: string;
  organization_id: string;
  task_id: string;
  skill_id: string | null;
  rule_id: string;
  kind: string;
  title: string;
  detail: string;
  status: string;
  created_at: string;
  promoted_at: string | null;
}

function toCandidate(row: Row): ExperienceCandidate {
  return {
    format: 'zeus-experience-candidate',
    version: 1,
    id: row.id,
    organizationId: row.organization_id,
    taskId: row.task_id,
    ...(row.skill_id ? { skillId: row.skill_id } : {}),
    ruleId: row.rule_id,
    kind: row.kind as ExperienceCandidateKind,
    title: row.title,
    detail: row.detail,
    createdAt: row.created_at,
    status: row.status === 'promoted' ? 'promoted' : 'pending',
    ...(row.promoted_at ? { promotedAt: row.promoted_at } : {}),
  };
}

export class SqliteExperienceStore implements ExperienceStore {
  constructor(private readonly db: DatabaseSync) {}

  putCandidate(candidate: ExperienceCandidate): void {
    this.db
      .prepare(
        `INSERT INTO sop_experience_candidates
           (id, organization_id, task_id, skill_id, rule_id, kind, title, detail, status, created_at, promoted_at)
         VALUES (@id, @organization_id, @task_id, @skill_id, @rule_id, @kind, @title, @detail, @status, @created_at, @promoted_at)
         ON CONFLICT(id) DO UPDATE SET
           skill_id=@skill_id, kind=@kind, title=@title, detail=@detail,
           status=@status, promoted_at=@promoted_at`,
      )
      .run({
        id: candidate.id,
        organization_id: candidate.organizationId,
        task_id: candidate.taskId,
        skill_id: candidate.skillId ?? null,
        rule_id: candidate.ruleId,
        kind: candidate.kind,
        title: candidate.title,
        detail: candidate.detail,
        status: candidate.status,
        created_at: candidate.createdAt,
        promoted_at: candidate.promotedAt ?? null,
      });
  }

  getCandidate(id: string): ExperienceCandidate | undefined {
    const row = this.db
      .prepare('SELECT * FROM sop_experience_candidates WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? toCandidate(row) : undefined;
  }

  listCandidates(organizationId?: string): ExperienceCandidate[] {
    const rows = (
      organizationId
        ? this.db
            .prepare('SELECT * FROM sop_experience_candidates WHERE organization_id = ? ORDER BY created_at, id')
            .all(organizationId)
        : this.db.prepare('SELECT * FROM sop_experience_candidates ORDER BY created_at, id').all()
    ) as unknown as Row[];
    return rows.map(toCandidate);
  }

  findCandidate(taskId: string, ruleId: string): ExperienceCandidate | undefined {
    const row = this.db
      .prepare('SELECT * FROM sop_experience_candidates WHERE task_id = ? AND rule_id = ?')
      .get(taskId, ruleId) as Row | undefined;
    return row ? toCandidate(row) : undefined;
  }
}

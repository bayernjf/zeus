/**
 * Durable org store (T-M6-01). Implements the OrgStore port; the format/
 * version discriminators (not stored as columns) are reattached on read.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  Organization,
  Department,
  Position,
  OrgTask,
  OrgTaskFailureKind,
  OrgTaskProgress,
  OrgTaskTransition,
} from '../org/types.js';
import type { OrgStore, OrgSnapshot } from '../org/store.js';

const parse = <T>(json: string): T => JSON.parse(json) as T;
const opt = <T>(value: T | undefined): T | null => value ?? null;
/** Read credential refs; null/empty/malformed maps to undefined (no grants). */
function parseCredentialRefs(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const refs = parse<unknown>(value);
    if (!Array.isArray(refs)) return undefined;
    const cleaned = refs.filter((r): r is string => typeof r === 'string' && r.trim() !== '');
    return cleaned.length ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

export class SqliteOrgStore implements OrgStore {
  constructor(private readonly db: DatabaseSync) {}

  // Organizations
  putOrganization(org: Organization): void {
    this.db
      .prepare(
        `INSERT INTO organizations (id, name, scale_tier, parent_id, created_at)
         VALUES (@id, @name, @scale_tier, @parent_id, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name=@name, scale_tier=@scale_tier, parent_id=@parent_id`,
      )
      .run({
        id: org.id,
        name: org.name,
        scale_tier: org.scaleTier,
        parent_id: opt(org.parentId),
        created_at: org.createdAt,
      });
  }

  getOrganization(id: string): Organization | undefined {
    const row = this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          format: 'zeus-organization',
          version: 1,
          id: String(row.id),
          name: String(row.name),
          scaleTier: row.scale_tier as Organization['scaleTier'],
          ...(row.parent_id ? { parentId: String(row.parent_id) } : {}),
          createdAt: String(row.created_at),
        }
      : undefined;
  }

  listOrganizations(): Organization[] {
    const rows = this.db.prepare('SELECT id FROM organizations').all() as { id: string }[];
    return rows.map((r) => this.getOrganization(r.id)!);
  }

  // Departments
  putDepartment(dept: Department): void {
    this.db
      .prepare(
        `INSERT INTO departments (id, organization_id, name, mission, parent_id, created_at)
         VALUES (@id, @organization_id, @name, @mission, @parent_id, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           organization_id=@organization_id, name=@name, mission=@mission, parent_id=@parent_id`,
      )
      .run({
        id: dept.id,
        organization_id: dept.organizationId,
        name: dept.name,
        mission: dept.mission,
        parent_id: opt(dept.parentId),
        created_at: dept.createdAt,
      });
  }

  getDepartment(id: string): Department | undefined {
    const row = this.db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          format: 'zeus-department-v1',
          version: 1,
          id: String(row.id),
          organizationId: String(row.organization_id),
          name: String(row.name),
          mission: String(row.mission),
          ...(row.parent_id ? { parentId: String(row.parent_id) } : {}),
          createdAt: String(row.created_at),
        }
      : undefined;
  }

  listDepartments(organizationId?: string): Department[] {
    const rows = (organizationId === undefined
      ? this.db.prepare('SELECT id FROM departments').all()
      : this.db.prepare('SELECT id FROM departments WHERE organization_id = ?').all(
          organizationId,
        )) as { id: string }[];
    return rows.map((r) => this.getDepartment(r.id)!);
  }

  // Positions
  putPosition(pos: Position): void {
    this.db
      .prepare(
        `INSERT INTO positions (
          id, organization_id, department_id, name, responsibilities_json,
          required_skills_json, allowed_tools_json, credential_refs_json,
          decision_scope, agent_id, created_at
        ) VALUES (
          @id, @organization_id, @department_id, @name, @responsibilities_json,
          @required_skills_json, @allowed_tools_json, @credential_refs_json,
          @decision_scope, @agent_id, @created_at
        )
        ON CONFLICT(id) DO UPDATE SET
          name=@name, responsibilities_json=@responsibilities_json,
          required_skills_json=@required_skills_json, allowed_tools_json=@allowed_tools_json,
          credential_refs_json=@credential_refs_json,
          decision_scope=@decision_scope, agent_id=@agent_id`,
      )
      .run({
        id: pos.id,
        organization_id: pos.organizationId,
        department_id: pos.departmentId,
        name: pos.name,
        responsibilities_json: JSON.stringify(pos.responsibilities),
        required_skills_json: JSON.stringify(pos.requiredSkills),
        allowed_tools_json: JSON.stringify(pos.allowedTools),
        credential_refs_json: JSON.stringify(pos.credentialRefs ?? []),
        decision_scope: pos.decisionScope,
        agent_id: opt(pos.agentId),
        created_at: pos.createdAt,
      });
  }

  getPosition(id: string): Position | undefined {
    const row = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    const credentialRefs = row ? parseCredentialRefs(row.credential_refs_json) : undefined;
    return row
      ? {
          format: 'zeus-position',
          version: 1,
          id: String(row.id),
          organizationId: String(row.organization_id),
          departmentId: String(row.department_id),
          name: String(row.name),
          responsibilities: parse<string[]>(row.responsibilities_json as string),
          requiredSkills: parse<string[]>(row.required_skills_json as string),
          allowedTools: parse<string[]>(row.allowed_tools_json as string),
          ...(credentialRefs ? { credentialRefs } : {}),
          decisionScope: row.decision_scope as Position['decisionScope'],
          ...(row.agent_id ? { agentId: String(row.agent_id) } : {}),
          createdAt: String(row.created_at),
        }
      : undefined;
  }

  listPositions(organizationId?: string): Position[] {
    const rows = (organizationId === undefined
      ? this.db.prepare('SELECT id FROM positions').all()
      : this.db.prepare('SELECT id FROM positions WHERE organization_id = ?').all(
          organizationId,
        )) as { id: string }[];
    return rows.map((r) => this.getPosition(r.id)!);
  }

  // Tasks
  putTask(task: OrgTask): void {
    this.db
      .prepare(
        `INSERT INTO org_tasks (
          id, organization_id, title, payload_json, required_skill, position_id,
          assigned_agent_id, run_id, status, decision_id, result_json, error,
          attempts, failed_kind, progress_json, next_attempt_at, deadline_at,
          idempotency_key, unmatched_reason, transitions_json, created_at, updated_at
        ) VALUES (
          @id, @organization_id, @title, @payload_json, @required_skill, @position_id,
          @assigned_agent_id, @run_id, @status, @decision_id, @result_json, @error,
          @attempts, @failed_kind, @progress_json, @next_attempt_at, @deadline_at,
          @idempotency_key, @unmatched_reason, @transitions_json, @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          assigned_agent_id=@assigned_agent_id, run_id=@run_id, status=@status,
          decision_id=@decision_id, result_json=@result_json, error=@error,
          attempts=@attempts, failed_kind=@failed_kind, progress_json=@progress_json,
          next_attempt_at=@next_attempt_at, deadline_at=@deadline_at,
          idempotency_key=@idempotency_key, unmatched_reason=@unmatched_reason,
          transitions_json=@transitions_json, updated_at=@updated_at`,
      )
      .run({
        id: task.id,
        organization_id: task.organizationId,
        title: task.title,
        payload_json: JSON.stringify(task.payload),
        required_skill: opt(task.requiredSkill),
        position_id: opt(task.positionId),
        assigned_agent_id: opt(task.assignedAgentId),
        run_id: opt(task.runId),
        status: task.status,
        decision_id: opt(task.decisionId),
        result_json: opt(task.result ? JSON.stringify(task.result) : undefined),
        error: opt(task.error),
        attempts: task.attempts ?? 0,
        failed_kind: opt(task.failedKind),
        progress_json: opt(task.progress && task.progress.length ? JSON.stringify(task.progress) : undefined),
        next_attempt_at: opt(task.nextAttemptAt),
        deadline_at: opt(task.deadlineAt),
        idempotency_key: opt(task.idempotencyKey),
        unmatched_reason: opt(task.unmatchedReason),
        transitions_json: JSON.stringify(task.transitions),
        created_at: task.createdAt,
        updated_at: task.updatedAt,
      });
  }

  getTask(id: string): OrgTask | undefined {
    const row = this.db.prepare('SELECT * FROM org_tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          format: 'zeus-org-task',
          version: 1,
          id: String(row.id),
          organizationId: String(row.organization_id),
          title: String(row.title),
          payload: parse(row.payload_json as string),
          ...(row.required_skill ? { requiredSkill: String(row.required_skill) } : {}),
          ...(row.position_id ? { positionId: String(row.position_id) } : {}),
          ...(row.assigned_agent_id ? { assignedAgentId: String(row.assigned_agent_id) } : {}),
          ...(row.run_id ? { runId: String(row.run_id) } : {}),
          status: row.status as OrgTask['status'],
          ...(row.decision_id ? { decisionId: String(row.decision_id) } : {}),
          ...(row.result_json ? { result: parse(row.result_json as string) } : {}),
          ...(row.error ? { error: String(row.error) } : {}),
          ...(typeof row.attempts === 'number' && row.attempts > 0
            ? { attempts: row.attempts as number }
            : {}),
          ...(row.failed_kind ? { failedKind: String(row.failed_kind) as OrgTaskFailureKind } : {}),
          ...(row.progress_json ? { progress: parse<OrgTaskProgress[]>(row.progress_json as string) } : {}),
          ...(row.next_attempt_at ? { nextAttemptAt: String(row.next_attempt_at) } : {}),
          ...(row.deadline_at ? { deadlineAt: String(row.deadline_at) } : {}),
          ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}),
          ...(row.unmatched_reason
            ? { unmatchedReason: String(row.unmatched_reason) }
            : {}),
          transitions: parse<OrgTaskTransition[]>(row.transitions_json as string),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }

  getTaskByIdempotencyKey(organizationId: string, idempotencyKey: string): OrgTask | undefined {
    const row = this.db
      .prepare('SELECT id FROM org_tasks WHERE organization_id = ? AND idempotency_key = ?')
      .get(organizationId, idempotencyKey) as { id: string } | undefined;
    return row ? this.getTask(row.id) : undefined;
  }

  listTasks(organizationId?: string): OrgTask[] {
    const rows = (organizationId === undefined
      ? this.db.prepare('SELECT id FROM org_tasks').all()
      : this.db.prepare('SELECT id FROM org_tasks WHERE organization_id = ?').all(
          organizationId,
        )) as { id: string }[];
    return rows.map((r) => this.getTask(r.id)!);
  }

  exportSnapshot(): OrgSnapshot {
    return {
      organizations: this.listOrganizations(),
      departments: this.listDepartments(),
      positions: this.listPositions(),
      tasks: this.listTasks(),
    };
  }

  importSnapshot(snapshot: OrgSnapshot): void {
    for (const org of snapshot.organizations) this.putOrganization(org);
    for (const dept of snapshot.departments) this.putDepartment(dept);
    for (const pos of snapshot.positions) this.putPosition(pos);
    for (const task of snapshot.tasks) this.putTask(task);
  }
}

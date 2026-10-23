/**
 * Org service (Tier0 M2; M7 T-M7-01 hardened executor). Pure orchestration
 * over the org store: organization/department/position lifecycle, hierarchy
 * cycle rejection, agent binding, and the task dispatcher state machine.
 *
 * Dispatcher state machine:
 *   pending → dispatched (match position, bound agent) → running
 *   running → awaiting_decision (the hardened runner hit a blocked decision)
 *   awaiting_decision → running (resume after approval) → done | failed
 * No matching position is an explicit, reported outcome: the task stays
 * pending with unmatchedReason and the call throws NO_MATCHING_POSITION.
 *
 * Execution is delegated to the hardened runner (execution/runner.ts), which
 * enforces tool authority, the task deadline, bounded retry and idempotency
 * around the callback-style OrgTaskExecutor. This slice runs the runner
 * synchronously inside dispatch/resume; durable async scheduling is a later
 * slice.
 */
import type { DecisionService } from '../decision-service/service.js';
import type { DecisionRecord, ApprovalRequest } from '../decision-service/types.js';
import type { DecisionPolicy } from '../grading/policy.js';
import type { Grade } from '../types.js';
import { parsePolicy } from '../grading/policy-loader.js';
import { sha256Hex } from '../../util/crypto.js';
import { MemoryOrgStore, type OrgStore } from './store.js';
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_TASK_DEADLINE_MS,
  InMemoryActionStore,
  runTask,
  type ActionResultStore,
  type OrgTaskExecutorV2,
  type RetryPolicy,
} from './execution/index.js';
import {
  ORG_ERROR_CODES as EC,
  OrgServiceError,
  type AssignAgentInput,
  type CreateDepartmentInput,
  type CreateOrganizationInput,
  type CreateOrgTaskInput,
  type CreatePositionInput,
  type Department,
  type Organization,
  type OrgTask,
  type OrgTaskProgress,
  type Position,
  type ScaleTier,
} from './types.js';

const VALID_SCALES: ScaleTier[] = ['single', 'small', 'team', 'division', 'enterprise'];
const VALID_GRADES: Grade[] = ['D0', 'D1', 'D2', 'D3'];
/** Default cap on distinct decision points a task may traverse. */
const DEFAULT_MAX_DECISION_HOPS = 10;

export interface OrgServiceDeps {
  store?: OrgStore;
  /** Decision integration; when absent, tasks cannot pause at checkpoints. */
  decisions?: DecisionService;
  clock?: () => string;
  /** Id generator (tests inject a deterministic counter). */
  newId?: (prefix: string) => string;
  /** T-M7-01 bounded retry policy for task execution. */
  retryPolicy?: RetryPolicy;
  /** T-M7-01 task-level wall-clock deadline in milliseconds. */
  taskDeadlineMs?: number;
  /** T-M7-01 cap on distinct decision points per task. */
  maxDecisionHops?: number;
  /**
   * T-M7-01 supplies the per-task idempotent action store. When omitted an
   * in-memory store is used; durable wiring (SQLite) passes a factory so action
   * results survive restart and side effects are not replayed.
   */
  actionStoreFactory?: (taskId: string) => ActionResultStore;
}

/**
 * The hardened executor contract (T-M7-01). The name is kept from M2 so call
 * sites still refer to OrgTaskExecutor; the shape is now the callback-style
 * hardened contract (see execution/contract.ts).
 */
export type OrgTaskExecutor = OrgTaskExecutorV2;

export interface DispatchResult {
  task: OrgTask;
  /** Set when the task paused at a decision checkpoint. */
  decision?: DecisionRecord;
}

function asciiSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function idFromName(prefix: string, scope: string, name: string, fallbackSalt: string): string {
  const s = asciiSlug(name);
  return `${prefix}:${scope}:${s || sha256Hex(`${scope}:${name}:${fallbackSalt}`).slice(0, 8)}`;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new OrgServiceError(EC.VALIDATION_FAILED, `${field} is required`);
  }
  return v.trim();
}

export class OrgService {
  private readonly store: OrgStore;
  private readonly decisions: DecisionService | undefined;
  private readonly clock: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly retryPolicy: RetryPolicy;
  private readonly taskDeadlineMs: number;
  private readonly maxDecisionHops: number;
  private readonly actionStoreFactory: ((taskId: string) => ActionResultStore) | undefined;
  /** Per-task idempotent action results for the default in-memory wiring. */
  private readonly actionStores = new Map<string, ActionResultStore>();
  private counter = 0;

  constructor(deps: OrgServiceDeps = {}) {
    this.store = deps.store ?? new MemoryOrgStore();
    this.decisions = deps.decisions;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? ((prefix: string) => `${prefix}-${Date.now().toString(36)}-${(this.counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.taskDeadlineMs = deps.taskDeadlineMs ?? DEFAULT_TASK_DEADLINE_MS;
    this.maxDecisionHops = deps.maxDecisionHops ?? DEFAULT_MAX_DECISION_HOPS;
    this.actionStoreFactory = deps.actionStoreFactory;
  }

  // ── Organizations ──────────────────────────────────────────────────────

  createOrganization(input: CreateOrganizationInput): Organization {
    const name = requireString(input.name, 'name');
    const scaleTier = input.scaleTier ?? 'small';
    if (!VALID_SCALES.includes(scaleTier)) {
      throw new OrgServiceError(EC.VALIDATION_FAILED, `invalid scaleTier: ${scaleTier}`);
    }
    if (input.parentId !== undefined) {
      if (!this.store.getOrganization(input.parentId)) {
        throw new OrgServiceError(EC.ORGANIZATION_NOT_FOUND, `parent organization not found: ${input.parentId}`);
      }
    }
    const now = this.clock();
    const id = input.id?.trim() || (() => {
      const s = asciiSlug(name);
      return `org:${s || sha256Hex(`org:${name}:${now}`).slice(0, 8)}`;
    })();
    if (this.store.getOrganization(id)) {
      throw new OrgServiceError(EC.ORGANIZATION_CONFLICT, `organization already exists: ${id}`);
    }
    const org: Organization = {
      format: 'zeus-organization',
      version: 1,
      id,
      name,
      scaleTier,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      createdAt: now,
    };
    this.store.putOrganization(org);
    return this.store.getOrganization(id)!;
  }

  getOrganization(id: string): Organization {
    const org = this.store.getOrganization(id);
    if (!org) throw new OrgServiceError(EC.ORGANIZATION_NOT_FOUND, `organization not found: ${id}`);
    return org;
  }

  listOrganizations(): Organization[] {
    return this.store.listOrganizations();
  }

  // ── Departments ─────────────────────────────────────────────────────────

  createDepartment(input: CreateDepartmentInput): Department {
    const org = this.getOrganization(input.organizationId);
    const name = requireString(input.name, 'name');
    const mission = requireString(input.mission, 'mission');
    if (input.parentId !== undefined) {
      const parent = this.store.getDepartment(input.parentId);
      if (!parent) {
        throw new OrgServiceError(EC.DEPARTMENT_NOT_FOUND, `parent department not found: ${input.parentId}`);
      }
      if (parent.organizationId !== org.id) {
        throw new OrgServiceError(EC.VALIDATION_FAILED, 'parent department belongs to another organization');
      }
    }
    const now = this.clock();
    const id = input.id?.trim() || idFromName('dept', org.id, name, now);
    if (this.store.getDepartment(id)) {
      throw new OrgServiceError(EC.DEPARTMENT_CONFLICT, `department already exists: ${id}`);
    }
    const dept: Department = {
      format: 'zeus-department-v1',
      version: 1,
      id,
      organizationId: org.id,
      name,
      mission,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      createdAt: now,
    };
    // Provisional cycle check against the new edge (parent → new node).
    this.assertNoCycle(dept.id, dept.parentId);
    this.store.putDepartment(dept);
    return this.store.getDepartment(id)!;
  }

  listDepartments(organizationId?: string): Department[] {
    return this.store.listDepartments(organizationId);
  }

  getDepartment(id: string): Department {
    const dept = this.store.getDepartment(id);
    if (!dept) throw new OrgServiceError(EC.DEPARTMENT_NOT_FOUND, `department not found: ${id}`);
    return dept;
  }

  /** Walk parentId links from `start`; appending `start → parentId` must not lead back to start. */
  private assertNoCycle(newNodeId: string, parentId?: string): void {
    let cur = parentId;
    const seen = new Set<string>([newNodeId]);
    while (cur !== undefined) {
      if (seen.has(cur)) {
        throw new OrgServiceError(EC.HIERARCHY_CYCLE, `department hierarchy cycle at ${cur}`);
      }
      seen.add(cur);
      const dept = this.store.getDepartment(cur);
      if (!dept) throw new OrgServiceError(EC.DEPARTMENT_NOT_FOUND, `department not found: ${cur}`);
      cur = dept.parentId;
    }
  }

  // ── Positions ───────────────────────────────────────────────────────────

  createPosition(input: CreatePositionInput): Position {
    const dept = this.getDepartment(input.departmentId);
    const name = requireString(input.name, 'name');
    const decisionScope = input.decisionScope ?? 'D2';
    if (!VALID_GRADES.includes(decisionScope)) {
      throw new OrgServiceError(EC.VALIDATION_FAILED, `invalid decisionScope: ${decisionScope}`);
    }
    const now = this.clock();
    const id = input.id?.trim() || idFromName('pos', dept.organizationId, name, now);
    if (this.store.getPosition(id)) {
      throw new OrgServiceError(EC.POSITION_CONFLICT, `position already exists: ${id}`);
    }
    const pos: Position = {
      format: 'zeus-position',
      version: 1,
      id,
      organizationId: dept.organizationId,
      departmentId: dept.id,
      name,
      responsibilities: [...(input.responsibilities ?? [])],
      requiredSkills: [...(input.requiredSkills ?? [])],
      allowedTools: [...(input.allowedTools ?? [])],
      decisionScope,
      createdAt: now,
    };
    this.store.putPosition(pos);
    return this.store.getPosition(id)!;
  }

  getPosition(id: string): Position {
    const pos = this.store.getPosition(id);
    if (!pos) throw new OrgServiceError(EC.POSITION_NOT_FOUND, `position not found: ${id}`);
    return pos;
  }

  listPositions(organizationId?: string): Position[] {
    return this.store.listPositions(organizationId);
  }

  assignAgent(positionId: string, input: AssignAgentInput): Position {
    const agentId = requireString(input.agentId, 'agentId');
    const pos = this.getPosition(positionId);
    if (pos.agentId === agentId) return pos;
    const next: Position = { ...pos, agentId };
    this.store.putPosition(next);
    return this.store.getPosition(positionId)!;
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  createTask(input: CreateOrgTaskInput): OrgTask {
    this.getOrganization(input.organizationId);
    const title = requireString(input.title, 'title');
    if (input.payload === undefined) {
      throw new OrgServiceError(EC.VALIDATION_FAILED, 'payload is required');
    }
    if (input.positionId !== undefined) this.getPosition(input.positionId);
    // Idempotent create: a repeat request with the same key (within the same
    // organization) returns the existing task instead of creating a duplicate.
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (idempotencyKey) {
      const existing = this.store.getTaskByIdempotencyKey(input.organizationId, idempotencyKey);
      if (existing) return existing;
    }
    const now = this.clock();
    const id = this.newId('task');
    const task: OrgTask = {
      format: 'zeus-org-task',
      version: 1,
      id,
      organizationId: input.organizationId,
      title,
      payload: input.payload,
      ...(input.requiredSkill ? { requiredSkill: input.requiredSkill } : {}),
      ...(input.positionId ? { positionId: input.positionId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      status: 'pending',
      transitions: [{ status: 'pending', at: now }],
      createdAt: now,
      updatedAt: now,
    };
    this.store.putTask(task);
    return this.store.getTask(id)!;
  }

  getTask(id: string): OrgTask {
    const task = this.store.getTask(id);
    if (!task) throw new OrgServiceError(EC.TASK_NOT_FOUND, `org task not found: ${id}`);
    return task;
  }

  listTasks(organizationId?: string): OrgTask[] {
    return this.store.listTasks(organizationId);
  }

  /** Match the position the task should dispatch to: explicit id, else skill. */
  private matchPosition(task: OrgTask): Position {
    if (task.positionId) {
      const pos = this.getPosition(task.positionId);
      if (pos.organizationId !== task.organizationId) {
        throw new OrgServiceError(EC.VALIDATION_FAILED, 'position belongs to another organization');
      }
      return pos;
    }
    const candidates = this.store
      .listPositions(task.organizationId)
      .filter(p => p.agentId !== undefined)
      .filter(p => !task.requiredSkill || p.requiredSkills.includes(task.requiredSkill))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (candidates.length === 0) {
      const reason = task.requiredSkill
        ? `no bound position in organization ${task.organizationId} offers skill ${task.requiredSkill}`
        : `no bound position in organization ${task.organizationId}`;
      const now = this.clock();
      const pending = this.store.getTask(task.id)!;
      this.store.putTask({ ...pending, unmatchedReason: reason, updatedAt: now });
      throw new OrgServiceError(EC.NO_MATCHING_POSITION, reason);
    }
    return candidates[0]!;
  }

  /**
   * Claim a pending task for execution: match → bind → dispatched → running,
   * without running the executor. Persists the handoff so an async worker (or
   * a restart recovery scan) can later run the claimed task. Idempotent: a
   * non-pending task is returned unchanged.
   */
  claim(taskId: string): OrgTask {
    const existing = this.getTask(taskId);
    if (existing.status !== 'pending') return existing;
    const position = this.matchPosition(existing);
    if (!position.agentId) {
      throw new OrgServiceError(EC.POSITION_UNBOUND, `position ${position.id} has no agent bound`);
    }
    const now = this.clock();
    const dispatched: OrgTask = {
      ...existing,
      positionId: position.id,
      assignedAgentId: position.agentId,
      status: 'dispatched',
      updatedAt: now,
      transitions: [...existing.transitions, { status: 'dispatched', at: now, note: position.id }],
    };
    return this.transition(dispatched, 'running', `agent ${position.agentId}`);
  }

  /**
   * Approve (or read) the blocking decision and move an awaiting_decision task
   * back to running, without running the executor. The async worker then runs
   * the claimed task.
   */
  async claimResume(taskId: string, approval?: ApprovalRequest): Promise<{ task: OrgTask; decision?: DecisionRecord }> {
    const task0 = this.getTask(taskId);
    if (task0.status !== 'awaiting_decision' || !task0.decisionId) {
      throw new OrgServiceError(EC.TASK_CONFLICT, `task ${taskId} is not awaiting_decision`);
    }
    let decision: DecisionRecord | undefined;
    if (this.decisions && approval) {
      decision = await this.decisions.approve(task0.decisionId, approval);
    } else if (this.decisions) {
      decision = await this.decisions.get(task0.decisionId);
    }
    const task = this.transition(task0, 'running', 'resumed after decision');
    return { task, ...(decision ? { decision } : {}) };
  }

  /**
   * Synchronous dispatch: claim and run to a settlement in one call. Used by
   * the in-process HTTP wiring and tests; async wiring claims and lets a
   * TaskWorker run the claimed task. Idempotent: a non-pending task is
   * returned as-is.
   */
  async dispatch(taskId: string, executor: OrgTaskExecutor): Promise<DispatchResult> {
    const existing = this.getTask(taskId);
    if (existing.status !== 'pending') return { task: existing };
    const claimed = this.claim(taskId);
    return this.runClaimed(claimed.id, executor);
  }

  /** Synchronous resume: approve and run to a settlement in one call. */
  async resume(taskId: string, executor: OrgTaskExecutor, approval?: ApprovalRequest): Promise<DispatchResult> {
    const { task } = await this.claimResume(taskId, approval);
    return this.runClaimed(task.id, executor);
  }

  /**
   * Run the hardened runner for a task already in running (freshly claimed or
   * recovered after a restart) and map the settlement onto the task state.
   * Resume is inferred from a carried, already-decided decision.
   */
  async runClaimed(taskId: string, executor: OrgTaskExecutor): Promise<DispatchResult> {
    const task = this.getTask(taskId);
    if (task.status !== 'running') {
      throw new OrgServiceError(EC.TASK_CONFLICT, `task ${taskId} is not running (status=${task.status})`);
    }
    const position = this.getPosition(task.positionId!);

    let resumed = false;
    let lastDecision: DecisionRecord | undefined;
    if (task.decisionId && this.decisions) {
      const decided = await this.decisions.get(task.decisionId);
      if (decided && decided.status === 'decided') {
        resumed = true;
        lastDecision = decided;
      }
    }

    const actionStore = this.actionStoreFor(task.id);
    const progress: OrgTaskProgress[] = [...(task.progress ?? [])];

    const settlement = await runTask({
      task,
      position,
      agentId: position.agentId!,
      executor,
      ...(this.decisions ? { decisions: this.decisions } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(lastDecision ? { lastDecision } : {}),
      actionStore,
      retryPolicy: this.retryPolicy,
      deadlineMs: this.taskDeadlineMs,
      maxDecisionHops: this.maxDecisionHops,
      iso: this.clock,
      onProgress: p => progress.push(p),
    });

    const progressPatch = progress.length ? { progress } : {};

    if (settlement.outcome === 'complete') {
      const done = this.transition(
        {
          ...task,
          ...progressPatch,
          attempts: settlement.attempts,
          runId: task.runId ?? this.newId('run'),
          ...(settlement.result !== undefined ? { result: settlement.result } : {}),
        },
        'done',
      );
      return { task: this.store.getTask(done.id)! };
    }

    if (settlement.outcome === 'awaiting_decision') {
      const paused = this.transition(
        { ...task, ...progressPatch, attempts: settlement.attempts, decisionId: settlement.decision.id },
        'awaiting_decision',
        settlement.decision.id,
      );
      return { task: this.store.getTask(paused.id)!, decision: settlement.decision };
    }

    const failed = this.transition(
      {
        ...task,
        ...progressPatch,
        attempts: settlement.attempts,
        failedKind: settlement.failureKind,
        error: settlement.error,
      },
      'failed',
      settlement.error,
    );
    return { task: this.store.getTask(failed.id)! };
  }

  /** Per-task idempotent action store; durable when a factory is wired. */
  private actionStoreFor(taskId: string): ActionResultStore {
    if (this.actionStoreFactory) return this.actionStoreFactory(taskId);
    let store = this.actionStores.get(taskId);
    if (!store) {
      store = new InMemoryActionStore();
      this.actionStores.set(taskId, store);
    }
    return store;
  }

  private transition(task: OrgTask, status: OrgTask['status'], note?: string): OrgTask {
    const now = this.clock();
    const next: OrgTask = {
      ...task,
      status,
      updatedAt: now,
      transitions: [...task.transitions, { status, at: now, ...(note ? { note } : {}) }],
    };
    this.store.putTask(next);
    return this.store.getTask(next.id)!;
  }

  // ── Snapshot/restore (kernel state) ─────────────────────────────────────

  exportSnapshot() {
    return this.store.exportSnapshot();
  }

  importSnapshot(snapshot: ReturnType<MemoryOrgStore['exportSnapshot']>): void {
    this.store.importSnapshot(snapshot);
  }

  // ── Decision threshold configuration (T-M2-04) ──────────────────────────

  /**
   * Adjust amount thresholds (CNY) and/or default grade on the current policy.
   * Amount boundaries move together: d1-amount.max = d1Max; d2-amount spans
   * (d1Max, d2Max]; d3-amount-large starts at d2Max + 0.01. The new policy is
   * validated and versioned; old records keep their policyVersion.
   */
  async applyThresholds(
    patch: { d1MaxAmount?: number; d2MaxAmount?: number; defaultGrade?: Grade; actor?: string },
  ): Promise<DecisionPolicy> {
    if (!this.decisions) {
      throw new OrgServiceError(EC.VALIDATION_FAILED, 'threshold configuration requires a DecisionService');
    }
    const current = this.decisions.getPolicy();
    const policy: DecisionPolicy = {
      ...current,
      rules: current.rules.map(r => ({ ...r, match: { ...r.match } })),
    };
    const byId = new Map(policy.rules.map(r => [r.id, r]));
    const d1 = byId.get('d1-amount');
    const d2 = byId.get('d2-amount');
    const d3 = byId.get('d3-amount-large');
    if (!d1 || !d2 || !d3 || !d1.match.amount || !d2.match.amount || !d3.match.amount) {
      throw new OrgServiceError(EC.VALIDATION_FAILED, 'current policy lacks the standard amount rules');
    }
    const d1Max = patch.d1MaxAmount ?? d1.match.amount.max ?? 500;
    const d2Max = patch.d2MaxAmount ?? d2.match.amount.max ?? 5000;
    if (
      typeof d1Max !== 'number' ||
      typeof d2Max !== 'number' ||
      !Number.isFinite(d1Max) ||
      !Number.isFinite(d2Max) ||
      d1Max < 0 ||
      d2Max <= d1Max
    ) {
      throw new OrgServiceError(
        EC.VALIDATION_FAILED,
        `invalid thresholds: require 0 <= d1Max < d2Max (got ${d1Max}, ${d2Max})`,
      );
    }
    d1.match.amount = { min: 0, max: round2(d1Max), currency: 'CNY' };
    d2.match.amount = { min: round2(d1Max + 0.01), max: round2(d2Max), currency: 'CNY' };
    d3.match.amount = { min: round2(d2Max + 0.01), currency: 'CNY' };
    if (patch.defaultGrade !== undefined) {
      if (!VALID_GRADES.includes(patch.defaultGrade)) {
        throw new OrgServiceError(EC.VALIDATION_FAILED, `invalid defaultGrade: ${patch.defaultGrade}`);
      }
      policy.defaultGrade = patch.defaultGrade;
    }
    const validated = parsePolicy({ ...policy, version: current.version + 1 });
    return this.decisions.updatePolicy(validated, patch.actor ?? 'org-config');
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

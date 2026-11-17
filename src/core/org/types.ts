/**
 * Org v1 (Tier0 M2, design §4.4/§5.1): organization / department / position /
 * org-task contract. Pure types and validation; no I/O and no framework types.
 *
 * An organization owns a department tree (parentId references, cycles are
 * rejected). Positions sit in a department and may be bound to an agent; the
 * position's decisionScope is the highest grade the bound agent may handle
 * autonomously. Org tasks enter through the dispatcher and flow through an
 * explicit state machine.
 */
import type { Grade } from '../types.js';
import { DecisionError } from '../grading/errors.js';

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** PRD §7 scale tiers; org-os opening slice covers single/small/team. */
export type ScaleTier = 'single' | 'small' | 'team' | 'division' | 'enterprise';

export interface Organization {
  format: 'zeus-organization';
  version: 1;
  id: string;
  name: string;
  scaleTier: ScaleTier;
  /** Optional parent organization (franchise/grouping); cycles rejected. */
  parentId?: string;
  /**
   * F1.1: max org tasks this deployment executes concurrently. 1 falls back to
   * the original serial behaviour; absent means the worker default (2).
   */
  concurrencyLimit?: number;
  createdAt: string;
}

/** F5.1: a recurring unit of intent the org schedules against. */
export type OrgGoalPeriod = 'daily' | 'weekly' | 'once';

export type OrgGoalStatus = 'active' | 'paused' | 'done' | 'archived';

/**
 * F5.2 trigger: UTC wall-clock window for a daily/weekly goal. The goal's
 * `period` selects the cadence; `weekdayUtc` is required only for weekly.
 */
export interface OrgGoalSchedule {
  hourUtc: number;
  minuteUtc: number;
  /** 0=Sunday .. 6=Saturday; required for weekly and absent for daily. */
  weekdayUtc?: number;
}

/** F5.2 minimal one-task template; F5.3 expands this into dependency chains. */
export interface OrgGoalTaskTemplate {
  title?: string;
  payload?: Json;
  requiredSkill?: string;
  positionId?: string;
}

export interface OrgGoal {
  format: 'zeus-org-goal';
  version: 1;
  id: string;
  organizationId: string;
  title: string;
  period: OrgGoalPeriod;
  status: OrgGoalStatus;
  /** Optional project binding (hub project id); scheduler carries it into tasks. */
  projectId?: string;
  /** Absent means registered but not scheduled (manual goals). */
  schedule?: OrgGoalSchedule;
  /** Absent means the scheduler uses the goal title + a default payload. */
  taskTemplate?: OrgGoalTaskTemplate;
  createdAt: string;
  updatedAt: string;
}

export interface Department {
  format: 'zeus-department-v1';
  version: 1;
  id: string;
  organizationId: string;
  name: string;
  mission: string;
  /** Parent department within the same organization; cycles rejected. */
  parentId?: string;
  createdAt: string;
}

export interface Position {
  format: 'zeus-position';
  version: 1;
  id: string;
  organizationId: string;
  departmentId: string;
  name: string;
  responsibilities: string[];
  requiredSkills: string[];
  allowedTools: string[];
  /**
   * Opaque credential references the bound position may resolve at call time
   * (e.g. 'agent-world:service-token'). Never secret values; secrets stay behind
   * the SecretBackend. Absent/empty means no credentials are granted.
   */
  credentialRefs?: string[];
  /** Highest grade the bound agent may decide autonomously. */
  decisionScope: Grade;
  /** Agent bound to this position; unbound positions are never dispatched. */
  agentId?: string;
  createdAt: string;
}

export type OrgTaskStatus =
  | 'pending'
  | 'dispatched'
  | 'running'
  | 'awaiting_decision'
  | 'done'
  | 'failed';

/**
 * Failure classification for a failed task (T-M7-01 hardened runner). Kept as a
 * local string union so org/types stays self-contained; it mirrors
 * execution/errors TaskFailureKind.
 */
export type OrgTaskFailureKind =
  | 'business'
  | 'retryable_exhausted'
  | 'timeout'
  | 'tool_denied';

/** A non-pausing progress / recovery point reported during execution. */
export interface OrgTaskProgress {
  stage: string;
  percent?: number;
  data?: Json;
  at: string;
}

/** F4.1: settlement record kept on the task for ledger/experience review. */
export interface OrgTaskOutcome {
  status: 'done' | 'failed';
  attempts: number;
  failedKind?: OrgTaskFailureKind;
  error?: string;
  /** Decision checkpoints the run touched, oldest first. */
  decisions: { id: string; status: string }[];
  /** When the final run entered running. */
  startedAt?: string;
  settledAt: string;
  durationMs?: number;
  workspace?: { path: string; artifact?: string; policy: 'archive' | 'discard' };
  /** First 200 chars of the JSON result, for quick scanning. */
  resultSummary?: string;
}

export interface OrgTaskTransition {
  status: OrgTaskStatus;
  at: string;
  note?: string;
}

export interface OrgTask {
  format: 'zeus-org-task';
  version: 1;
  id: string;
  organizationId: string;
  title: string;
  payload: Json;
  /** Skill the dispatcher matches positions by; optional when positionId given. */
  requiredSkill?: string;
  positionId?: string;
  assignedAgentId?: string;
  runId?: string;
  status: OrgTaskStatus;
  /** Decision id while the task is awaiting_decision. */
  decisionId?: string;
  result?: Json;
  error?: string;
  /** T-M7-01: attempts consumed by the hardened runner. */
  attempts?: number;
  /** T-M7-01: failure classification when status === 'failed'. */
  failedKind?: OrgTaskFailureKind;
  /** T-M7-01: progress/recovery points reported during execution. */
  progress?: OrgTaskProgress[];
  /** T-M7-01: caller-supplied idempotency key; unique within an organization. */
  idempotencyKey?: string;
  /** T-M7-01: when a retryable task is next eligible to run (async worker). */
  nextAttemptAt?: string;
  /** T-M7-01: task-level wall-clock deadline (ISO). */
  deadlineAt?: string;
  /** F1.2: base repo the task's isolated worktree is created from. */
  workspaceBaseRepo?: string;
  /** F1.2: git ref the worktree is checked out at; HEAD when absent. */
  workspaceBaseRef?: string;
  /** F1.2: settlement handling for the worktree; defaults to discard. */
  workspacePolicy?: 'archive' | 'discard';
  /** F1.2: absolute worktree path, set once acquired during claim. */
  workspacePath?: string;
  /** Set when no position matches; task remains pending for human handling. */
  unmatchedReason?: string;
  /** F4.1: settlement record written when the task reaches done/failed. */
  outcome?: OrgTaskOutcome;
  transitions: OrgTaskTransition[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrganizationInput {
  id?: string;
  name: string;
  scaleTier?: ScaleTier;
  parentId?: string;
  /** F1.1: bounded task concurrency; 1 = serial. Defaults to 2. */
  concurrencyLimit?: number;
}

export interface CreateDepartmentInput {
  id?: string;
  organizationId: string;
  name: string;
  mission: string;
  parentId?: string;
}

export interface CreatePositionInput {
  id?: string;
  organizationId: string;
  departmentId: string;
  name: string;
  responsibilities?: string[];
  requiredSkills?: string[];
  allowedTools?: string[];
  credentialRefs?: string[];
  decisionScope?: Grade;
}

export interface AssignAgentInput {
  agentId: string;
}

export interface CreateOrgTaskInput {
  organizationId: string;
  title: string;
  payload: Json;
  requiredSkill?: string;
  positionId?: string;
  /** T-M7-01: idempotency key; a repeat create with the same key returns the
   *  existing task instead of creating a duplicate. */
  idempotencyKey?: string;
  /** F1.2: run inside a git worktree of baseRepo (allow-listed, fail-closed). */
  workspace?: {
    baseRepo: string;
    baseRef?: string;
    policy?: 'archive' | 'discard';
  };
}

/** F5.1: create a goal record (flat intent, no OKR hierarchy). */
export interface CreateOrgGoalInput {
  organizationId: string;
  title: string;
  period?: OrgGoalPeriod;
  projectId?: string;
  status?: OrgGoalStatus;
  schedule?: OrgGoalSchedule;
  taskTemplate?: OrgGoalTaskTemplate;
}

/** F5.1: patch a goal; `projectId: null` clears the binding. */
export interface UpdateOrgGoalInput {
  title?: string;
  period?: OrgGoalPeriod;
  projectId?: string | null;
  status?: OrgGoalStatus;
  /** `null` clears the trigger; omitted leaves it untouched. */
  schedule?: OrgGoalSchedule | null;
  /** `null` clears the template; omitted leaves it untouched. */
  taskTemplate?: OrgGoalTaskTemplate | null;
}

export class OrgServiceError extends DecisionError {
  constructor(
    code: string,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(code, message, opts);
    this.name = 'OrgServiceError';
  }
}

export const ORG_ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  DEPARTMENT_NOT_FOUND: 'DEPARTMENT_NOT_FOUND',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  ORGANIZATION_CONFLICT: 'ORGANIZATION_CONFLICT',
  DEPARTMENT_CONFLICT: 'DEPARTMENT_CONFLICT',
  POSITION_CONFLICT: 'POSITION_CONFLICT',
  TASK_CONFLICT: 'TASK_CONFLICT',
  HIERARCHY_CYCLE: 'HIERARCHY_CYCLE',
  NO_MATCHING_POSITION: 'NO_MATCHING_POSITION',
  POSITION_UNBOUND: 'POSITION_UNBOUND',
  DECISION_REQUIRED: 'DECISION_REQUIRED',
  /** T-M7-03: the task claims a channel skill/workflow the SOP catalog has no SOP for. */
  SOP_MISSING: 'SOP_MISSING',
  /** T-M7-03: the matched position cannot cover the resolved SOP (missing grants / low scope). */
  SOP_INCOMPATIBLE: 'SOP_INCOMPATIBLE',
  /** F4.2: experience candidate id does not exist. */
  EXPERIENCE_NOT_FOUND: 'EXPERIENCE_NOT_FOUND',
  /** F5.1: goal id does not exist. */
  GOAL_NOT_FOUND: 'GOAL_NOT_FOUND',
} as const;

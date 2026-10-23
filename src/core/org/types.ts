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
  createdAt: string;
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
  /** Set when no position matches; task remains pending for human handling. */
  unmatchedReason?: string;
  transitions: OrgTaskTransition[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrganizationInput {
  id?: string;
  name: string;
  scaleTier?: ScaleTier;
  parentId?: string;
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
} as const;

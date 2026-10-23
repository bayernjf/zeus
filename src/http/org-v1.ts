/**
 * Org API v1 handlers (Tier0 M2, design §4.4). Pure mapping layer like
 * decision-v1: validation and orchestration live in the core OrgService.
 *
 * Routes:
 *   POST/GET /api/v1/org/organizations[/:id]
 *   POST/GET /api/v1/org/departments
 *   POST/GET /api/v1/org/positions
 *   POST     /api/v1/org/positions/:id/assign-agent
 *   POST/GET /api/v1/org/tasks, GET /api/v1/org/tasks/:id
 *   POST     /api/v1/org/tasks/:id/dispatch | /resume
 *   POST     /api/v1/org/policy/thresholds
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  OrgService,
  OrgServiceError,
  type AssignAgentInput,
  type CreateDepartmentInput,
  type CreateOrganizationInput,
  type CreateOrgTaskInput,
  type CreatePositionInput,
  type OrgTaskExecutor,
} from '../core/index.js';
import type { ApprovalRequest } from '../core/decision-service/types.js';
import type { Grade } from '../core/types.js';

function statusForOrgError(code: string): number {
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'VALIDATION_FAILED') return 400;
  if (code === 'NO_MATCHING_POSITION' || code === 'POSITION_UNBOUND') return 409;
  if (code === 'HIERARCHY_CYCLE') return 409;
  if (code.endsWith('_CONFLICT') || code === 'TASK_CONFLICT') return 409;
  return 400;
}

export function sendOrgError(reply: FastifyReply, thrown: unknown): FastifyReply {
  if (thrown instanceof OrgServiceError) {
    return reply.code(statusForOrgError(thrown.code)).send({
      code: thrown.code,
      message: thrown.message,
      retryable: thrown.retryable,
      ...(thrown.details !== undefined ? { details: thrown.details } : {}),
    });
  }
  return reply.code(500).send({
    code: 'INTERNAL_ERROR',
    message: 'org service failed',
    retryable: false,
  });
}

// ── Organizations ─────────────────────────────────────────────────────────

export async function createOrganizationRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const created = org.createOrganization(request.body as CreateOrganizationInput);
    return reply.code(201).send(created);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

export async function listOrganizationsRoute(org: OrgService, _request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  return reply.send({ organizations: org.listOrganizations() });
}

export async function getOrganizationRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    return reply.send(org.getOrganization((request.params as { id: string }).id));
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

// ── Departments ─────────────────────────────────────────────────────────

export async function createDepartmentRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const created = org.createDepartment(request.body as CreateDepartmentInput);
    return reply.code(201).send(created);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

export async function listDepartmentsRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const organizationId = (request.query as { organizationId?: string }).organizationId;
  return reply.send({ departments: org.listDepartments(organizationId) });
}

// ── Positions ─────────────────────────────────────────────────────────────

export async function createPositionRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const created = org.createPosition(request.body as CreatePositionInput);
    return reply.code(201).send(created);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

export async function listPositionsRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const organizationId = (request.query as { organizationId?: string }).organizationId;
  return reply.send({ positions: org.listPositions(organizationId) });
}

export async function assignAgentRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const id = (request.params as { id: string }).id;
    const updated = org.assignAgent(id, request.body as AssignAgentInput);
    return reply.send(updated);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export async function createTaskRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const created = org.createTask(request.body as CreateOrgTaskInput);
    return reply.code(201).send(created);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

export async function listTasksRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const organizationId = (request.query as { organizationId?: string }).organizationId;
  return reply.send({ tasks: org.listTasks(organizationId) });
}

export async function getTaskRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    return reply.send(org.getTask((request.params as { id: string }).id));
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

/** Dispatch needs the assembled executor; the server passes it in explicitly. */
export async function dispatchTaskRoute(
  org: OrgService,
  executor: OrgTaskExecutor | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  if (!executor) {
    return reply.code(503).send({
      code: 'ORG_EXECUTOR_UNCONFIGURED',
      message: 'no task executor assembled at this process',
      retryable: true,
    });
  }
  try {
    const id = (request.params as { id: string }).id;
    const res = await org.dispatch(id, executor);
    return reply.send(res);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

export async function resumeTaskRoute(
  org: OrgService,
  executor: OrgTaskExecutor | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  if (!executor) {
    return reply.code(503).send({
      code: 'ORG_EXECUTOR_UNCONFIGURED',
      message: 'no task executor assembled at this process',
      retryable: true,
    });
  }
  try {
    const id = (request.params as { id: string }).id;
    const body = request.body as { decision?: string; approver?: string; comment?: string } | undefined;
    const approval: ApprovalRequest | undefined =
      body && body.decision && body.approver
        ? {
            decision: body.decision as 'approve' | 'reject',
            approver: body.approver,
            ...(body.comment !== undefined ? { comment: body.comment } : {}),
          }
        : undefined;
    const res = await org.resume(id, executor, approval);
    return reply.send(res);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

// ── Threshold configuration (T-M2-04) ─────────────────────────────────────

export async function applyThresholdsRoute(org: OrgService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const body = request.body as {
      d1MaxAmount?: number;
      d2MaxAmount?: number;
      defaultGrade?: Grade;
      actor?: string;
    };
    const policy = await org.applyThresholds({
      ...(body.d1MaxAmount !== undefined ? { d1MaxAmount: body.d1MaxAmount } : {}),
      ...(body.d2MaxAmount !== undefined ? { d2MaxAmount: body.d2MaxAmount } : {}),
      ...(body.defaultGrade !== undefined ? { defaultGrade: body.defaultGrade } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
    });
    return reply.send(policy);
  } catch (thrown) {
    return sendOrgError(reply, thrown);
  }
}

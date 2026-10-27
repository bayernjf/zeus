/**
 * Decision API v1 handlers (design §4.2). Pure mapping layer: every rule lives
 * in the core DecisionService; this module only shapes requests/responses and
 * translates transport-free errors into HTTP.
 *
 * Error body (design §8.1): { code, message, retryable, details? }
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  DecisionError,
  DecisionRecordNotFoundError,
  DecisionService,
} from '../core/index.js';
import type {
  DecisionRecord,
  DecisionStatus,
} from '../core/index.js';
import type { DecisionWebhookStore, DecisionWebhookSubscription } from '../core/decision-service/webhook.js';
import type { DecisionRequest, DecisionPolicy } from '../core/grading/policy.js';

/** POST /api/v1/decisions response shape (design §4.2). */
export interface DecisionResponse {
  decisionId: string;
  grade: DecisionRecord['grade'];
  mode: DecisionRecord['mode'];
  status: DecisionRecord['status'];
  ruleId: string;
  proposal?: unknown;
  auditSeq: number;
}

function toResponse(record: DecisionRecord): DecisionResponse {
  return {
    decisionId: record.id,
    grade: record.grade,
    mode: record.mode,
    status: record.status,
    ruleId: record.ruleId,
    ...(record.proposal !== undefined ? { proposal: record.proposal } : {}),
    auditSeq: record.auditSeq,
  };
}

/** Map a core DecisionError to its HTTP status; POLICY_NOT_FOUND is a server
 *  configuration failure (non-retryable), state conflicts are 409. */
function statusForDecisionError(code: string): number {
  if (code === 'POLICY_NOT_FOUND') return 500;
  if (code === 'GRADE_REQUIRES_APPROVAL' || code === 'IDEMPOTENCY_CONFLICT' || code === 'APPROVAL_TIMEOUT') return 409;
  return 400; // VALIDATION_FAILED and anything structural
}

export function sendDecisionError(reply: FastifyReply, thrown: unknown): FastifyReply {
  if (thrown instanceof DecisionRecordNotFoundError) {
    return reply.code(404).send({
      code: 'DECISION_NOT_FOUND',
      message: thrown.message,
      retryable: false,
    });
  }
  if (thrown instanceof DecisionError) {
    return reply.code(statusForDecisionError(thrown.code)).send({
      code: thrown.code,
      message: thrown.message,
      retryable: thrown.retryable,
      ...(thrown.details !== undefined ? { details: thrown.details } : {}),
    });
  }
  return reply.code(500).send({
    code: 'INTERNAL_ERROR',
    message: 'decision service failed',
    retryable: false,
  });
}

export async function createDecisionRoute(service: DecisionService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const record = await service.createDecision(request.body as unknown as DecisionRequest);
    return reply.code(201).send(toResponse(record));
  } catch (thrown) {
    return sendDecisionError(reply, thrown);
  }
}

export async function getDecisionRoute(service: DecisionService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const id = (request.params as { id: string }).id;
    const record = await service.get(id);
    if (!record) {
      return reply.code(404).send({ code: 'DECISION_NOT_FOUND', message: `decision not found: ${id}`, retryable: false });
    }
    return reply.send(record);
  } catch (thrown) {
    return sendDecisionError(reply, thrown);
  }
}

export async function listDecisionsRoute(service: DecisionService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const query = request.query as { domain?: string; status?: string };
    if (query.status !== undefined && !['decided', 'awaiting_approval', 'blocked', 'rejected'].includes(query.status)) {
      return reply.code(400).send({
        code: 'VALIDATION_FAILED',
        message: `status must be one of decided/awaiting_approval/blocked/rejected, got ${query.status}`,
        retryable: false,
      });
    }
    const decisions = await service.list({
      ...(query.domain !== undefined ? { domain: query.domain } : {}),
      ...(query.status !== undefined ? { status: query.status as DecisionStatus } : {}),
    });
    return reply.send({ decisions });
  } catch (thrown) {
    return sendDecisionError(reply, thrown);
  }
}

export async function approvalRoute(service: DecisionService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const id = (request.params as { id: string }).id;
    const body = request.body as { decision?: string; approver?: string; comment?: string };
    const record = await service.approve(id, {
      decision: body?.decision as 'approve' | 'reject',
      approver: body?.approver as string,
      ...(body?.comment !== undefined ? { comment: body.comment } : {}),
    });
    return reply.send(toResponse(record));
  } catch (thrown) {
    return sendDecisionError(reply, thrown);
  }
}

export async function replayRoute(service: DecisionService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const id = (request.params as { id: string }).id;
    const query = request.query as { format?: string };
    const format = query.format ?? 'json';
    if (format !== 'json' && format !== 'text') {
      return reply.code(400).send({
        code: 'VALIDATION_FAILED',
        message: `format must be json|text, got ${String(format)}`,
        retryable: false,
      });
    }
    const record = await service.get(id);
    if (!record) {
      return reply.code(404).send({ code: 'DECISION_NOT_FOUND', message: `decision not found: ${id}`, retryable: false });
    }
    if (format === 'text') {
      return reply.type('text/plain; charset=utf-8').send(service.renderReplay(record));
    }
    return reply.send(service.replay(record));
  } catch (thrown) {
    return sendDecisionError(reply, thrown);
  }
}

export async function getPolicyRoute(service: DecisionService, _request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    return reply.send(service.getPolicy());
  } catch (thrown) {
    return sendDecisionError(reply, thrown);
  }
}

export async function putPolicyRoute(service: DecisionService, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const actor = typeof request.headers['x-zeus-actor'] === 'string' ? request.headers['x-zeus-actor'] : 'system';
    const policy = await service.updatePolicy(request.body as unknown as DecisionPolicy, actor);
    return reply.send(policy);
  } catch (thrown) {
    return sendDecisionError(reply, thrown);
  }
}

// --- Decision webhook subscriptions (push lifecycle events instead of polling) ---

const WEBHOOK_URL_PATTERN = /^https?:\/\/[^\s]+$/;
let webhookIdCounter = 0;

/** Secret is never returned: the registry is append/read of ids and urls. */
export async function listWebhooksRoute(
  store: DecisionWebhookStore,
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const webhooks = (await store.list()).map(s => ({ id: s.id, url: s.url, active: s.active }));
    return reply.send({ webhooks });
  } catch {
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'webhook registry failed',
      retryable: false,
    });
  }
}

export async function addWebhookRoute(
  store: DecisionWebhookStore,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (request.body ?? {}) as { url?: unknown; secret?: unknown; active?: unknown };
  const issues: string[] = [];
  if (typeof body.url !== 'string' || !WEBHOOK_URL_PATTERN.test(body.url)) {
    issues.push('url: expected an http(s) URL');
  }
  if (typeof body.secret !== 'string' || body.secret.length < 16) {
    issues.push('secret: expected at least 16 characters (used to HMAC-sign every delivery)');
  }
  if (issues.length > 0) {
    return reply.code(400).send({
      code: 'VALIDATION_FAILED',
      message: issues.join('; '),
      retryable: false,
      details: issues,
    });
  }
  webhookIdCounter += 1;
  const subscription: DecisionWebhookSubscription = {
    id: `wh_${Date.now().toString(36)}_${webhookIdCounter.toString(36)}`,
    url: body.url as string,
    secret: body.secret as string,
    active: body.active !== false,
  };
  await store.add(subscription);
  return reply.code(201).send({ id: subscription.id, url: subscription.url, active: subscription.active });
}

/** DELETE /api/v1/decision-webhooks/:id: hard-delete a subscription.
 *  204 on success, 404 WEBHOOK_NOT_FOUND when the id never existed (or was
 *  already deleted) — repeated deletes are idempotent in outcome. */
export async function deleteWebhookRoute(
  store: DecisionWebhookStore,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const id = (request.params as { id: string }).id;
  try {
    const removed = await store.remove(id);
    if (!removed) {
      return reply.code(404).send({
        code: 'WEBHOOK_NOT_FOUND',
        message: `decision webhook subscription not found: ${id}`,
        retryable: false,
      });
    }
    return reply.code(204).send();
  } catch {
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'webhook registry failed',
      retryable: false,
    });
  }
}

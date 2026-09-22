import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { VassalRegistry } from '../registry/registry.js';
import { projectInternalRoster, projectPublicRoster, type RosterSnapshot } from '../registry/roster.js';
import { sealSnapshot, type RosterSigner, type SignedRosterSnapshot } from '../registry/signing.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { UnknownIntentError } from '../orchestrator/orchestrator.js';
import type { AggregationRule, FanOutRequest } from '../orchestrator/types.js';
import type { OversightDesk } from '../oversight/oversight.js';
import type { EscalationStatus } from '../oversight/types.js';
import type { ConcurrencyMetrics } from '../orchestrator/metrics.js';
import { ProgressHub, type ProgressEvent } from '../orchestrator/progress.js';

/**
 * HTTP service face (docs/design-http-transport.md): a thin Fastify adapter.
 * The ONLY directory allowed to import fastify; handlers do
 * parameter/auth/serialization only — zero business logic, all state lives in
 * the kernel. No Realm routes (Realm is MCP-only, design-realm §6.1).
 *
 * H1 (public, no auth): /healthz, /api/roster/public.
 * H2 (internal, bearer): /api/roster plus the driver API — fan out intents,
 * read decisions, cancel, list/settle escalations, read metrics. The whole
 * internal group (and the H2 routes) is mounted only when an internal token is
 * configured, so a misconfigured process never exposes a write face.
 */

export const DEFAULT_SEAL_MAX_AGE_SECONDS = 3600;
export const DEFAULT_ATTESTATION_TTL_SECONDS = 24 * 3600;

const ESCALATION_STATUSES: EscalationStatus[] = ['pending', 'approved', 'rejected'];
const AGGREGATION_KINDS = new Set(['unanimous', 'majority', 'weighted']);

export type HttpDeps = {
  registry: VassalRegistry;
  signer: RosterSigner;
  /** Bearer token for the whole internal/driver face. When unset, H2 routes and GET /api/roster are not mounted. */
  internalToken?: string;
  now?: () => Date;
  version?: string;
  sealMaxAgeSeconds?: number;
  attestationTtlSeconds?: number;
  /** H2: intent fan-out / read / cancel. */
  orchestrator?: Orchestrator;
  /** H2: escalation queue and approve/reject/resolve. */
  oversight?: OversightDesk;
  /** H2: concurrency metrics snapshot. */
  metrics?: ConcurrencyMetrics;
  /** H3: per-intent progress events for the SSE stream. */
  progressHub?: ProgressHub;
};

export type StartOptions = {
  host?: string;
  port?: number;
};

export async function createHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const now = deps.now ?? (() => new Date());
  const maxAge = deps.sealMaxAgeSeconds ?? DEFAULT_SEAL_MAX_AGE_SECONDS;
  const attestationTtl = deps.attestationTtlSeconds ?? DEFAULT_ATTESTATION_TTL_SECONDS;

  // Liveness: version + time only, never vassal/Realm information.
  app.get('/healthz', async () => ({
    status: 'ok',
    ...(deps.version ? { version: deps.version } : {}),
    ts: now().toISOString(),
  }));

  // Public immutable signed snapshot (fealty-signing §4); revoked vassals and
  // internal endpoints/probe details are already removed at the projector.
  app.get('/api/roster/public', async (_request, reply) => {
    const at = now();
    const all = deps.registry.listAll();
    const snapshot = projectPublicRoster(all, () => at);
    const sources = all
      .filter(entry => !entry.revoked)
      .map(entry => ({ name: entry.card.name, card: entry.card, cardUrl: entry.cardUrl }));
    const signed: SignedRosterSnapshot = await sealSnapshot(snapshot, deps.signer, {
      now: at,
      maxAgeSeconds: maxAge,
      sources,
      attestationTtlSeconds: attestationTtl,
    });
    reply.header('Cache-Control', `public, max-age=${maxAge}`);
    reply.type('application/json; charset=utf-8');
    return signed;
  });

  // ---- Internal / driver face (H2): mounted only with a bearer token ----
  if (deps.internalToken) {
    const expected = deps.internalToken;
    const requireBearer = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!constantTimeEqual(presented, expected)) {
        await reply.code(401).send({ error: 'unauthorized' });
      }
    };

    // Internal governance roster: unsigned (contains revoked rows and endpoints).
    app.get('/api/roster', { preHandler: requireBearer }, async (): Promise<RosterSnapshot> => {
      return projectInternalRoster(deps.registry.listAll(), now);
    });

    // G1: onboard a vassal at runtime — fetch its agent card, validate fealty
    // and register it. A card without fealty / with an unsupported version is
    // rejected by the registry; an unreachable card is a bad-gateway, not a
    // malformed request.
    app.post('/api/vassals', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body ?? {}) as { cardUrl?: unknown; taskUrl?: unknown };
      if (typeof body.cardUrl !== 'string' || body.cardUrl.trim() === '') {
        return error(reply, 400, 'invalid_request', 'body.cardUrl is required');
      }
      if (body.taskUrl !== undefined && typeof body.taskUrl !== 'string') {
        return error(reply, 400, 'invalid_request', 'body.taskUrl must be a string');
      }
      try {
        const entry = await deps.registry.register(body.cardUrl, {
          ...(typeof body.taskUrl === 'string' ? { taskUrl: body.taskUrl } : {}),
        });
        return reply.code(201).send(entry);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        if (/^card fetch failed/.test(detail)) return error(reply, 502, 'bad_gateway', detail);
        return error(reply, 400, 'invalid_request', detail);
      }
    });

    // G1: revoke a vassal. Revocation takes effect for dispatch immediately;
    // an unknown / already-revoked name is 404.
    app.delete('/api/vassals/:name', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      if (!deps.registry.revoke(name)) return error(reply, 404, 'not_found', `unknown vassal: ${name}`);
      return { name, revoked: true };
    });

    if (deps.orchestrator) {
      // H2: fan one intent out to the vassals providing a skill.
      app.post('/api/intents', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as Partial<FanOutRequest>;
        if (typeof body.skill !== 'string' || body.skill.trim() === '') {
          return error(reply, 400, 'invalid_request', 'body.skill is required');
        }
        if (body.realm !== 'personal' && body.realm !== 'enterprise') {
          return error(reply, 400, 'invalid_request', 'body.realm must be "personal" or "enterprise"');
        }
        if (body.vassals !== undefined && !(Array.isArray(body.vassals) && body.vassals.every(v => typeof v === 'string'))) {
          return error(reply, 400, 'invalid_request', 'body.vassals must be an array of vassal names');
        }
        if (body.aggregation !== undefined && !validAggregation(body.aggregation)) {
          return error(reply, 400, 'invalid_request', 'body.aggregation must be unanimous | majority | weighted');
        }
        if (body.branchTimeoutMs !== undefined && (typeof body.branchTimeoutMs !== 'number' || body.branchTimeoutMs <= 0)) {
          return error(reply, 400, 'invalid_request', 'body.branchTimeoutMs must be a positive number');
        }
        const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
        const fanOutRequest: FanOutRequest = {
          skill: body.skill,
          realm: body.realm,
          params,
          ...(typeof body.intentId === 'string' ? { intentId: body.intentId } : {}),
          ...(body.vassals ? { vassals: body.vassals } : {}),
          ...(body.aggregation ? { aggregation: body.aggregation } : {}),
          ...(typeof body.branchTimeoutMs === 'number' ? { branchTimeoutMs: body.branchTimeoutMs } : {}),
          ...(body.realmHits ? { realmHits: body.realmHits } : {}),
          ...(body.runId ? { runId: body.runId } : {}),
        };
        const result = await deps.orchestrator!.fanOut(fanOutRequest);
        reply.code(200);
        return result;
      });

      // H2: read a stored intent decision.
      app.get('/api/intents/:id', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const result = deps.orchestrator!.getIntent(id);
        if (!result) return error(reply, 404, 'not_found', `unknown intent: ${id}`);
        return result;
      });

      // H2: cancel every non-terminal branch of an intent.
      app.post('/api/intents/:id/cancel', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {        const { id } = request.params as { id: string };
        try {
          return await deps.orchestrator!.cancelIntent(id);
        } catch (e) {
          return mapKernelError(reply, e);
        }
      });

      // H3: server-sent events for one intent's real-time progress. An intent
      // that has already finished is replayed as one event and closed; an
      // unknown intent 404s. The raw socket is hijacked from Fastify.
      app.get('/api/intents/:id/events', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const stored = deps.orchestrator!.getIntent(id);
        if (!stored && !deps.progressHub) {
          return error(reply, 404, 'not_found', `unknown intent: ${id}`);
        }

        const raw = reply.raw;
        const send = (event: string, data: unknown): void => {
          raw.write(`event: ${event}\n`);
          raw.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        reply.hijack();
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        raw.flushHeaders();

        if (stored) {
          send('intent', stored);
          raw.end();
          return;
        }

        const unsubscribe = deps.progressHub!.subscribe(id, (event: ProgressEvent) => {
          send(event.type, event);
          if (event.type === 'intent-finished') {
            finish();
          }
        });
        const keepalive = setInterval(() => raw.write(': ping\n\n'), 15_000);
        const finish = (): void => {
          clearInterval(keepalive);
          unsubscribe();
          raw.end();
        };
        raw.on('close', () => {
          clearInterval(keepalive);
          unsubscribe();
          raw.destroy();
        });
      });
    }

    if (deps.oversight) {
      // H2: list the escalation queue (optionally filtered by status).
      app.get('/api/escalations', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { status } = request.query as { status?: string };
        if (status !== undefined && !ESCALATION_STATUSES.includes(status as EscalationStatus)) {
          return error(reply, 400, 'invalid_request', `status must be one of ${ESCALATION_STATUSES.join(', ')}`);
        }
        return { escalations: deps.oversight!.list(status as EscalationStatus | undefined) };
      });

      // H2: approve a task-input escalation (records the decision; re-dispatch is the caller's job).
      app.post('/api/escalations/:id/approve', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const note = optionalNote(request.body);
        try {
          return deps.oversight!.approve(id, note);
        } catch (e) {
          return mapKernelError(reply, e);
        }
      });

      // H2: reject a task-input escalation (cancels the vassal-side task).
      app.post('/api/escalations/:id/reject', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const note = optionalNote(request.body);
        try {
          return await deps.oversight!.reject(id, note);
        } catch (e) {
          return mapKernelError(reply, e);
        }
      });

      // H2 (E6.3): one-click approve-and-resume — approve a task-input
      // escalation with human-supplied parameters, then automatically re-dispatch
      // that single branch and recompute the intent.
      app.post('/api/escalations/:id/approve-resume', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { params?: unknown; note?: unknown };
        if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
          return error(reply, 400, 'invalid_request', 'body.params object is required');
        }
        const escalation = deps.oversight!.get(id);
        if (!escalation) return error(reply, 404, 'not_found', `unknown escalation: ${id}`);
        if (escalation.kind !== 'task-input') {
          return error(reply, 400, 'invalid_request', `escalation ${id} is ${escalation.kind}; only task-input can resume`);
        }
        const intentId = deps.orchestrator!.findIntentForBranchRun(escalation.runId, escalation.vassal);
        if (!intentId) return error(reply, 409, 'conflict', `no stored intent branch matches escalation ${id}`);
        const note = typeof body.note === 'string' ? body.note : undefined;
        try {
          const approved = deps.oversight!.approve(id, note);
          const intent = await deps.orchestrator!.resumeBranch(intentId, escalation.vassal, body.params as Record<string, unknown>);
          return { escalation: approved, intent };
        } catch (e) {
          return mapKernelError(reply, e);
        }
      });

      // H2 (E6.2): settle an intent-conflict by accepting a stance; writes the
      // driver's decision back into the aggregated result.
      if (deps.orchestrator) {
        app.post('/api/escalations/:id/resolve', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
          const { id } = request.params as { id: string };
          const body = (request.body ?? {}) as { stance?: unknown; note?: unknown };
          if (typeof body.stance !== 'string' || body.stance.trim() === '') {
            return error(reply, 400, 'invalid_request', 'body.stance is required');
          }
          const escalation = deps.oversight!.get(id);
          if (!escalation) return error(reply, 404, 'not_found', `unknown escalation: ${id}`);
          if (escalation.kind !== 'intent-conflict') {
            return error(reply, 400, 'invalid_request', `escalation ${id} is ${escalation.kind}; use approve/reject`);
          }
          if (!escalation.intentId) return error(reply, 409, 'conflict', `escalation ${id} is not linked to an intent`);
          const note = typeof body.note === 'string' ? body.note : undefined;
          try {
            const decided = deps.oversight!.decideConflict(id, body.stance, note);
            const intent = deps.orchestrator!.resolveIntent(escalation.intentId, {
              escalationId: id,
              stance: body.stance,
              ...(note ? { note } : {}),
            });
            return { escalation: decided, intent };
          } catch (e) {
            return mapKernelError(reply, e);
          }
        });
      }
    }

    if (deps.metrics) {
      app.get('/api/metrics', { preHandler: requireBearer }, async () => deps.metrics!.snapshot());
    }
  }

  return app;
}

/** Start the long-lived process. Personal edition binds loopback by default
 *  (design-http-transport §2.1); enterprise sits behind a gateway. */
export async function startServer(deps: HttpDeps, options: StartOptions = {}): Promise<FastifyInstance> {
  const app = await createHttpServer(deps);
  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  return app;
}

function validAggregation(rule: unknown): rule is AggregationRule {
  if (typeof rule !== 'object' || rule === null) return false;
  const kind = (rule as { kind?: unknown }).kind;
  return typeof kind === 'string' && AGGREGATION_KINDS.has(kind);
}

function optionalNote(body: unknown): string | undefined {
  const note = (body as { note?: unknown } | null | undefined)?.note;
  return typeof note === 'string' ? note : undefined;
}

function error(reply: FastifyReply, status: number, code: string, detail: string): FastifyReply {
  return reply.code(status).send({ error: code, detail });
}

/** Map kernel throws to HTTP status: unknown id → 404, already decided / wrong
 *  state → 409, anything else (bad stance, malformed request) → 400. */
function mapKernelError(reply: FastifyReply, thrown: unknown): FastifyReply {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  if (thrown instanceof UnknownIntentError || /unknown (intent|escalation)/i.test(detail)) {
    return error(reply, 404, 'not_found', detail);
  }
  if (/already (approved|rejected|decided)|only needs-driver|is (approved|rejected|completed|partial|failed|canceled)/i.test(detail)) {
    return error(reply, 409, 'conflict', detail);
  }
  return error(reply, 400, 'invalid_request', detail);
}

/** Length-safe constant-time comparison for bearer tokens. */
function constantTimeEqual(presented: string, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

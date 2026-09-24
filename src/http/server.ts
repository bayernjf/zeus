import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { VassalRegistry } from '../registry/registry.js';
import { projectInternalRoster, projectPublicRoster } from '../registry/roster.js';
import { sealSnapshot, type RosterSigner, type SignedRosterSnapshot } from '../registry/signing.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { UnknownIntentError } from '../orchestrator/orchestrator.js';
import type { AggregationRule, FanOutRequest } from '../orchestrator/types.js';
import type { OversightDesk } from '../oversight/oversight.js';
import type { EscalationStatus } from '../oversight/types.js';
import type { ConcurrencyMetrics } from '../orchestrator/metrics.js';
import { ProgressHub, type ProgressEvent } from '../orchestrator/progress.js';
import { ReplayError, renderReplay, replayDecision, type DecisionReplay } from '../orchestrator/replay.js';
import type { OrgRegistry } from '../org/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import { DuplicateSkillError, SkillNotFoundError } from '../skills/registry.js';
import type { MentorshipLedger } from '../skills/mentor.js';
import type { CompetencyCheck, MentorshipStatus } from '../skills/mentor.js';
import type { SkillSpecInput, SkillStatus } from '../skills/types.js';
import { SkillValidationError } from '../skills/validate-spec.js';
import type { ConnectorRegistry } from '../mcp/connectors.js';
import type { ConnectorRecord, ConnectorStatus } from '../mcp/types.js';
import type { DecisionBackendKind } from '../decision/types.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { RealmStore } from '../realm/types.js';
import { buildDiariesFromState } from '../diary/from-memory.js';
import { persistDiary } from '../diary/persist.js';
import { DiaryUnsupportedError } from '../diary/types.js';

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
const SKILL_STATUSES: SkillStatus[] = ['active', 'deprecated', 'uninstalled'];
const MENTORSHIP_STATUSES: MentorshipStatus[] = ['teaching', 'certified', 'failed', 'dismissed'];
const CONNECTOR_STATUSES: ConnectorStatus[] = ['declared', 'connected', 'revoked'];

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
  /** H2 (E2.2/E2.3): skill catalogue, lifecycle and team resolution. */
  skillRegistry?: SkillRegistry;
  /** H2 (E2.5): mentor-commissioned skill transfer ledger. */
  mentorshipLedger?: MentorshipLedger;
  /** H2 (E7): MCP connector declarations, connect and revoke. */
  connectorRegistry?: ConnectorRegistry;
  /** H2: the decision layer this process resolved at boot. */
  decisionStatus?: DecisionStatus;
  /** H2 (E9.3): department establishment chart, staffing and accountability. */
  orgRegistry?: OrgRegistry;
  /** H2: memory source — the memory face (recall/facts/retract) and diary read/generate. */
  memoryStore?: MemoryStore;
  /** H2 (E8.3): realm target for diary persistence. */
  realmStore?: RealmStore;
};

export type StartOptions = {
  host?: string;
  port?: number;
};

/**
 * How the process resolved its decision layer at boot. Reported as
 * configuration, not measurement: it says which backend the kernel will ask and
 * which gates apply, which until now was only visible as one stderr line.
 */
export type DecisionStatus = {
  configured: boolean;
  kind?: DecisionBackendKind;
  model?: string;
  /** S2 arbitration activates with a backend; no separate enable switch. */
  arbitration: { enabled: boolean };
  judge: { enabled: boolean; threshold?: number; allowUncalibrated?: boolean };
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

    // Internal governance roster: sealed like the public view (design-fealty-signing
    // §4 "internal/public each sealed"), but it keeps revoked rows — those carry
    // permanent (non-expiring) revocation attestations — plus internal endpoints
    // and probe details. Bearer-protected and never cached by intermediaries.
    app.get('/api/roster', { preHandler: requireBearer }, async (_request, reply) => {
      const at = now();
      const all = deps.registry.listAll();
      const snapshot = projectInternalRoster(all, () => at);
      const sources = all.map(entry => ({
        name: entry.card.name,
        card: entry.card,
        cardUrl: entry.cardUrl,
        ...(entry.revoked ? { status: 'revoked' as const } : {}),
      }));
      const signed: SignedRosterSnapshot = await sealSnapshot(snapshot, deps.signer, {
        now: at,
        maxAgeSeconds: maxAge,
        sources,
        attestationTtlSeconds: attestationTtl,
      });
      reply.header('Cache-Control', 'no-store');
      reply.type('application/json; charset=utf-8');
      return signed;
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
          ...(typeof body.realmId === 'string' ? { realmId: body.realmId } : {}),
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

      // E1.6: offline replay of one stored decision — participants, dispatch
      // input, stances, aggregation, arbitration/judge and the driver's
      // settlement, rebuilt read-only from the persisted records. Nothing is
      // re-dispatched and no conclusion is re-derived. ?format=text renders the
      // human-readable timeline instead of JSON.
      app.get('/api/intents/:id/replay', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const { format } = request.query as { format?: unknown };
        if (format !== undefined && format !== 'json' && format !== 'text') {
          return error(reply, 400, 'invalid_request', 'query.format must be json | text');
        }
        const stored = deps.orchestrator!.getIntent(id);
        if (!stored) return error(reply, 404, 'not_found', `unknown intent: ${id}`);
        let replay: DecisionReplay;
        try {
          replay = replayDecision(stored, deps.orchestrator!.getRequest(id));
        } catch (e) {
          // An unreplayable record is a corrupt stored decision, not a bad
          // request: fail loud instead of serving a partial timeline.
          if (e instanceof ReplayError) return error(reply, 500, 'replay_failed', e.message);
          throw e;
        }
        if (format === 'text') {
          reply.type('text/plain; charset=utf-8');
          return renderReplay(replay);
        }
        return replay;
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

    if (deps.orgRegistry) {
      // E9.3: read the org chart (sorted, serializable establishment view).
      app.get('/api/org/chart', { preHandler: requireBearer }, async () => ({
        departments: deps.orgRegistry!.chart(),
      }));

      // E9.3: who answers for one intent's outcome — the executing agents, their
      // department leads and the driver who settled it. Agents holding no post
      // are reported as unassigned rather than dropped.
      if (deps.orchestrator) {
        app.get('/api/org/accountability/:intentId', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
          const { intentId } = request.params as { intentId: string };
          const result = deps.orchestrator!.getIntent(intentId);
          if (!result) return error(reply, 404, 'not_found', `unknown intent: ${intentId}`);
          return deps.orgRegistry!.accountability(result);
        });
      }

      // E9.3: establish a department.
      app.post('/api/org/departments', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as { name?: unknown; mission?: unknown };
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          return error(reply, 400, 'invalid_request', 'body.name is required');
        }
        if (typeof body.mission !== 'string' || body.mission.trim() === '') {
          return error(reply, 400, 'invalid_request', 'body.mission is required');
        }
        try {
          const dept = deps.orgRegistry!.createDepartment({ name: body.name, mission: body.mission });
          return reply.code(201).send(dept);
        } catch (e) {
          return mapOrgError(reply, e);
        }
      });

      // E9.3: assign (or lead) an agent into a department.
      app.post('/api/org/departments/:id/members', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { agentId?: unknown; role?: unknown; title?: unknown; skills?: unknown };
        if (typeof body.agentId !== 'string' || body.agentId.trim() === '') {
          return error(reply, 400, 'invalid_request', 'body.agentId is required');
        }
        if (body.role !== undefined && body.role !== 'lead' && body.role !== 'member') {
          return error(reply, 400, 'invalid_request', 'body.role must be lead | member');
        }
        if (body.title !== undefined && typeof body.title !== 'string') {
          return error(reply, 400, 'invalid_request', 'body.title must be a string');
        }
        if (body.skills !== undefined && !(Array.isArray(body.skills) && body.skills.every(s => typeof s === 'string'))) {
          return error(reply, 400, 'invalid_request', 'body.skills must be an array of strings');
        }
        try {
          const dept = deps.orgRegistry!.assignMember(id, {
            agentId: body.agentId,
            ...(body.role ? { role: body.role as 'lead' | 'member' } : {}),
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            ...(body.skills ? { skills: body.skills as string[] } : {}),
          });
          return reply.code(201).send(dept);
        } catch (e) {
          return mapOrgError(reply, e);
        }
      });
    }

    if (deps.memoryStore) {
      // Memory face (design-memory-consolidation): the driver reads one realm's
      // events, facts and hybrid recall, exercises the right to be forgotten and
      // checks the fact source's integrity. There is no fact write route — facts
      // change only through consolidation, so this face is read + retract.
      app.get('/api/memory/events', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as { realmId?: unknown; runId?: unknown };
        if (!isNonEmptyString(query.realmId)) {
          return error(reply, 400, 'invalid_request', 'query.realmId is required');
        }
        if (query.runId !== undefined && !isNonEmptyString(query.runId)) {
          return error(reply, 400, 'invalid_request', 'query.runId must be a string');
        }
        return { events: deps.memoryStore!.read(query.realmId, query.realmId, query.runId) };
      });

      app.get('/api/memory/facts', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as { realmId?: unknown };
        if (!isNonEmptyString(query.realmId)) {
          return error(reply, 400, 'invalid_request', 'query.realmId is required');
        }
        return { facts: deps.memoryStore!.facts(query.realmId, query.realmId) };
      });

      // Hybrid BM25 + vector recall over the realm's live facts. The index is a
      // derived artifact, rebuilt from the fact source on demand.
      app.get('/api/memory/recall', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as { realmId?: unknown; q?: unknown; limit?: unknown; alpha?: unknown };
        if (!isNonEmptyString(query.realmId)) {
          return error(reply, 400, 'invalid_request', 'query.realmId is required');
        }
        if (!isNonEmptyString(query.q)) {
          return error(reply, 400, 'invalid_request', 'query.q is required');
        }
        const limit = query.limit === undefined ? undefined : parsePositiveInt(query.limit);
        if (query.limit !== undefined && limit === undefined) {
          return error(reply, 400, 'invalid_request', 'query.limit must be a positive integer');
        }
        const alpha = query.alpha === undefined ? undefined : parseUnitInterval(query.alpha);
        if (query.alpha !== undefined && alpha === undefined) {
          return error(reply, 400, 'invalid_request', 'query.alpha must be a number in [0,1]');
        }
        const hits = deps.memoryStore!.searchRecall(query.realmId, query.realmId, query.q, {
          ...(limit !== undefined ? { limit } : {}),
          ...(alpha !== undefined ? { alpha } : {}),
        });
        return { hits };
      });

      // Right to be forgotten: facts become retracted, leave the recall index
      // immediately and gain a tombstone. Unknown / already-retracted facts are
      // a no-op, so a repeated request is safe.
      app.post('/api/memory/retract', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as {
          realmId?: unknown; factIds?: unknown; reason?: unknown; requestedBy?: unknown;
        };
        if (!isNonEmptyString(body.realmId)) {
          return error(reply, 400, 'invalid_request', 'body.realmId is required');
        }
        if (!(Array.isArray(body.factIds) && body.factIds.length > 0 && body.factIds.every(isNonEmptyString))) {
          return error(reply, 400, 'invalid_request', 'body.factIds must be a non-empty array of fact ids');
        }
        const context = retractionContext(body.reason, body.requestedBy);
        if (!context) {
          return error(reply, 400, 'invalid_request', 'body.reason and body.requestedBy are required');
        }
        return { retractions: deps.memoryStore!.retractFacts(body.realmId, body.factIds, context) };
      });

      app.post('/api/memory/forget-subject', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as {
          realmId?: unknown; subject?: unknown; reason?: unknown; requestedBy?: unknown;
        };
        if (!isNonEmptyString(body.realmId)) {
          return error(reply, 400, 'invalid_request', 'body.realmId is required');
        }
        if (!isNonEmptyString(body.subject)) {
          return error(reply, 400, 'invalid_request', 'body.subject is required');
        }
        const context = retractionContext(body.reason, body.requestedBy);
        if (!context) {
          return error(reply, 400, 'invalid_request', 'body.reason and body.requestedBy are required');
        }
        return { retractions: deps.memoryStore!.forgetSubject(body.realmId, body.subject, context) };
      });

      app.get('/api/memory/retractions', { preHandler: requireBearer }, async () => ({
        retractions: deps.memoryStore!.listRetractions(),
      }));

      // Cross-section invariants over the current fact source; a non-empty
      // violation list means the derived recall index must not be trusted.
      app.get('/api/memory/integrity', { preHandler: requireBearer }, async () => {
        const violations = deps.memoryStore!.verifyIntegrity();
        return { ok: violations.length === 0, violations };
      });

      // E8.3: read diary entries (optionally one realm/date), built on demand.
      app.get('/api/diary', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const q = request.query as { realmId?: unknown; date?: unknown; timeZone?: unknown };
        if (q.realmId !== undefined && typeof q.realmId !== 'string') {
          return error(reply, 400, 'invalid_request', 'query.realmId must be a string');
        }
        if (q.date !== undefined && !isValidDate(q.date)) {
          return error(reply, 400, 'invalid_request', 'query.date must be YYYY-MM-DD');
        }
        if (q.timeZone !== undefined && typeof q.timeZone !== 'string') {
          return error(reply, 400, 'invalid_request', 'query.timeZone must be a string');
        }
        try {
          const entries = buildDiariesFromState(deps.memoryStore!.exportState(), {
            ...(typeof q.realmId === 'string' ? { realmId: q.realmId } : {}),
            ...(isValidDate(q.date) ? { date: q.date } : {}),
            ...(typeof q.timeZone === 'string' ? { timeZone: q.timeZone } : {}),
          });
          if (q.date !== undefined && entries.length === 0) {
            return error(reply, 404, 'not_found', `no diary for ${String(q.date)}`);
          }
          return { entries };
        } catch (e) {
          return mapDiaryError(reply, e);
        }
      });

      // E8.3: build diaries and persist them through Realm.write.
      app.post('/api/diary/generate', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as {
          realmId?: unknown; date?: unknown; timeZone?: unknown; dir?: unknown;
        };
        if (body.realmId !== undefined && typeof body.realmId !== 'string') {
          return error(reply, 400, 'invalid_request', 'body.realmId must be a string');
        }
        if (body.date !== undefined && !isValidDate(body.date)) {
          return error(reply, 400, 'invalid_request', 'body.date must be YYYY-MM-DD');
        }
        if (body.timeZone !== undefined && typeof body.timeZone !== 'string') {
          return error(reply, 400, 'invalid_request', 'body.timeZone must be a string');
        }
        if (body.dir !== undefined && typeof body.dir !== 'string') {
          return error(reply, 400, 'invalid_request', 'body.dir must be a string');
        }
        if (!deps.realmStore || typeof deps.realmStore.write !== 'function') {
          return error(reply, 409, 'conflict', 'no writable realm connected; cannot persist diary');
        }
        try {
          const entries = buildDiariesFromState(deps.memoryStore!.exportState(), {
            ...(typeof body.realmId === 'string' ? { realmId: body.realmId } : {}),
            ...(isValidDate(body.date) ? { date: body.date } : {}),
            ...(typeof body.timeZone === 'string' ? { timeZone: body.timeZone } : {}),
          });
          if (entries.length === 0) {
            return error(reply, 400, 'invalid_request', 'no memory events to build a diary from');
          }
          const generated: Array<{ realmId: string; date: string; itemId: string }> = [];
          for (const entry of entries) {
            const { itemId } = await persistDiary(deps.realmStore!, entry, {
              ...(typeof body.dir === 'string' ? { dir: body.dir } : {}),
            });
            generated.push({ realmId: entry.realmId, date: entry.date, itemId });
          }
          return reply.code(201).send({ generated });
        } catch (e) {
          return mapDiaryError(reply, e);
        }
      });
    }

    if (deps.skillRegistry) {
      // E2.2: the skill catalogue. Active versions by default, filterable by
      // domain / tag / status (an explicit status reaches deprecated and
      // uninstalled specs, which stay auditable).
      app.get('/api/skills', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as { domain?: unknown; tag?: unknown; status?: unknown };
        if (query.status !== undefined && !SKILL_STATUSES.includes(query.status as SkillStatus)) {
          return error(reply, 400, 'invalid_request', `query.status must be one of ${SKILL_STATUSES.join(', ')}`);
        }
        if (query.domain !== undefined && !isNonEmptyString(query.domain)) {
          return error(reply, 400, 'invalid_request', 'query.domain must be a string');
        }
        if (query.tag !== undefined && !isNonEmptyString(query.tag)) {
          return error(reply, 400, 'invalid_request', 'query.tag must be a string');
        }
        return {
          skills: deps.skillRegistry!.list({
            ...(isNonEmptyString(query.domain) ? { domain: query.domain } : {}),
            ...(isNonEmptyString(query.tag) ? { tag: query.tag } : {}),
            ...(query.status !== undefined ? { status: query.status as SkillStatus } : {}),
          }),
        };
      });

      app.get('/api/skills/:id', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const version = optionalVersion(request.query);
        if (version === null) return error(reply, 400, 'invalid_request', 'query.version must be a string');
        const spec = deps.skillRegistry!.get(id, version);
        if (!spec) return error(reply, 404, 'not_found', `unknown skill: ${id}${version ? `@${version}` : ''}`);
        return spec;
      });

      app.get('/api/skills/:id/versions', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const versions = deps.skillRegistry!.versions(id);
        if (versions.length === 0) return error(reply, 404, 'not_found', `unknown skill: ${id}`);
        return { versions };
      });

      // E2.1: register an explicit spec. The body is copied field by field so an
      // arbitrary payload cannot smuggle unknown keys into the persisted
      // catalogue; shape problems are reported by the validator, not guessed here.
      app.post('/api/skills', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (!isNonEmptyString(body.id)) {
          return error(reply, 400, 'invalid_request', 'body.id is required');
        }
        const input = {
          id: body.id,
          name: body.name,
          description: body.description,
          version: body.version,
          ...(body.domain !== undefined ? { domain: body.domain } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...(body.inputs !== undefined ? { inputs: body.inputs } : {}),
          ...(body.outputs !== undefined ? { outputs: body.outputs } : {}),
          ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
          ...(body.dependencies !== undefined ? { dependencies: body.dependencies } : {}),
          ...(body.providedBy !== undefined ? { providedBy: body.providedBy } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        } as unknown as SkillSpecInput;
        try {
          return reply.code(201).send(deps.skillRegistry!.register(input));
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      // E2.3: install / uninstall / deprecate one registered version. Every
      // action takes effect for team resolution immediately — no cached grant.
      app.post('/api/skills/:id/install', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const version = optionalVersion(request.body);
        if (version === null) return error(reply, 400, 'invalid_request', 'body.version must be a string');
        try {
          return deps.skillRegistry!.install(id, version);
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      app.post('/api/skills/:id/uninstall', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const version = optionalVersion(request.body);
        if (version === null) return error(reply, 400, 'invalid_request', 'body.version must be a string');
        try {
          return deps.skillRegistry!.uninstall(id, version);
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      app.post('/api/skills/:id/deprecate', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const version = optionalVersion(request.body);
        if (version === null) return error(reply, 400, 'invalid_request', 'body.version must be a string');
        try {
          return deps.skillRegistry!.deprecate(id, version);
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      // E2.3: hardening can only narrow. The registry refuses a claim that is not
      // already granted, so an over-broad request is a 400, not a silent grant.
      app.post('/api/skills/:id/harden', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { version?: unknown; permissions?: unknown; constraints?: unknown };
        const version = optionalVersion(body);
        if (version === null) return error(reply, 400, 'invalid_request', 'body.version must be a string');
        if (body.permissions !== undefined && !(Array.isArray(body.permissions) && body.permissions.every(c => typeof c === 'string'))) {
          return error(reply, 400, 'invalid_request', 'body.permissions must be an array of permission claims');
        }
        if (body.constraints !== undefined && !isPlainObject(body.constraints)) {
          return error(reply, 400, 'invalid_request', 'body.constraints must be an object');
        }
        try {
          return deps.skillRegistry!.harden(id, {
            ...(body.permissions ? { permissions: body.permissions as string[] } : {}),
            ...(body.constraints ? { constraints: body.constraints as Record<string, unknown> } : {}),
          }, version);
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      // E2.4: map required skills onto providers. An ambiguous slot is reported
      // for the driver to choose; it is never resolved by picking at random.
      app.post('/api/skills/team', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as { skills?: unknown };
        if (!(Array.isArray(body.skills) && body.skills.length > 0 && body.skills.every(isNonEmptyString))) {
          return error(reply, 400, 'invalid_request', 'body.skills must be a non-empty array of skill ids');
        }
        return deps.skillRegistry!.resolveTeam(body.skills);
      });
    }

    if (deps.mentorshipLedger) {
      // E2.5: the auditable teaching path. Certification — not attendance — is
      // what registers a learner as a provider.
      app.get('/api/mentorships', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as { status?: unknown; skillId?: unknown };
        if (query.status !== undefined && !MENTORSHIP_STATUSES.includes(query.status as MentorshipStatus)) {
          return error(reply, 400, 'invalid_request', `query.status must be one of ${MENTORSHIP_STATUSES.join(', ')}`);
        }
        if (query.skillId !== undefined && !isNonEmptyString(query.skillId)) {
          return error(reply, 400, 'invalid_request', 'query.skillId must be a string');
        }
        return {
          mentorships: deps.mentorshipLedger!.list({
            ...(query.status !== undefined ? { status: query.status as MentorshipStatus } : {}),
            ...(isNonEmptyString(query.skillId) ? { skillId: query.skillId } : {}),
          }),
        };
      });

      app.post('/api/mentorships', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as {
          skillId?: unknown; mentorId?: unknown; learnerId?: unknown; version?: unknown; realmId?: unknown;
        };
        if (!isNonEmptyString(body.skillId)) return error(reply, 400, 'invalid_request', 'body.skillId is required');
        if (!isNonEmptyString(body.mentorId)) return error(reply, 400, 'invalid_request', 'body.mentorId is required');
        if (!isNonEmptyString(body.learnerId)) return error(reply, 400, 'invalid_request', 'body.learnerId is required');
        const version = optionalVersion(body);
        if (version === null) return error(reply, 400, 'invalid_request', 'body.version must be a string');
        if (body.realmId !== undefined && !isNonEmptyString(body.realmId)) {
          return error(reply, 400, 'invalid_request', 'body.realmId must be a string');
        }
        try {
          const record = deps.mentorshipLedger!.commission({
            skillId: body.skillId,
            mentorId: body.mentorId,
            learnerId: body.learnerId,
            ...(version ? { version } : {}),
            ...(isNonEmptyString(body.realmId) ? { realmId: body.realmId } : {}),
          });
          return reply.code(201).send(record);
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      app.post('/api/mentorships/:id/lessons', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { lessons?: unknown };
        if (!isLessonList(body.lessons)) {
          return error(reply, 400, 'invalid_request', 'body.lessons must be a non-empty array of { topic, ref? }');
        }
        try {
          return deps.mentorshipLedger!.teach(id, body.lessons as Array<{ topic: string; ref?: string }>);
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      app.post('/api/mentorships/:id/assess', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { checks?: unknown; threshold?: unknown };
        if (!isCheckList(body.checks)) {
          return error(reply, 400, 'invalid_request', 'body.checks must be a non-empty array of { criterion, passed, score }');
        }
        if (body.threshold !== undefined) {
          const threshold = parseUnitInterval(body.threshold);
          if (threshold === undefined || threshold === 0) {
            return error(reply, 400, 'invalid_request', 'body.threshold must be a number in (0,1]');
          }
        }
        try {
          return deps.mentorshipLedger!.assess(id, body.checks as CompetencyCheck[], {
            ...(body.threshold !== undefined ? { threshold: Number(body.threshold) } : {}),
          });
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });

      app.post('/api/mentorships/:id/dismiss', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { reason?: unknown };
        if (!isNonEmptyString(body.reason)) {
          return error(reply, 400, 'invalid_request', 'body.reason is required');
        }
        try {
          return deps.mentorshipLedger!.dismiss(id, body.reason);
        } catch (e) {
          return mapCatalogueError(reply, e);
        }
      });
    }

    if (deps.connectorRegistry) {
      // E7: the connector face. Declarations are the minimum-privilege boundary,
      // so the driver can see what was declared, attempt the handshake and revoke
      // — but never read back the token a connector presents upstream.
      app.get('/api/connectors', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as { status?: unknown };
        if (query.status !== undefined && !CONNECTOR_STATUSES.includes(query.status as ConnectorStatus)) {
          return error(reply, 400, 'invalid_request', `query.status must be one of ${CONNECTOR_STATUSES.join(', ')}`);
        }
        return {
          connectors: deps.connectorRegistry!
            .list(query.status as ConnectorStatus | undefined)
            .map(redactConnector),
        };
      });

      app.get('/api/connectors/:id', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const record = deps.connectorRegistry!.get(id);
        if (!record) return error(reply, 404, 'not_found', `unknown connector: ${id}`);
        return redactConnector(record);
      });

      // Declare takes the token in — that is the one place it is written, and the
      // response never echoes it.
      app.post('/api/connectors', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = (request.body ?? {}) as {
          id?: unknown; name?: unknown; endpoint?: unknown; permissions?: unknown; token?: unknown;
        };
        if (!isNonEmptyString(body.id)) {
          return error(reply, 400, 'invalid_request', 'body.id is required');
        }
        if (!isNonEmptyString(body.name)) {
          return error(reply, 400, 'invalid_request', 'body.name is required');
        }
        if (!isNonEmptyString(body.endpoint)) {
          return error(reply, 400, 'invalid_request', 'body.endpoint is required');
        }
        if (!(Array.isArray(body.permissions) && body.permissions.every(c => typeof c === 'string'))) {
          return error(reply, 400, 'invalid_request', 'body.permissions must be an array of permission claims');
        }
        if (body.token !== undefined && !isNonEmptyString(body.token)) {
          return error(reply, 400, 'invalid_request', 'body.token must be a string');
        }
        try {
          const record = deps.connectorRegistry!.declare({
            id: body.id,
            name: body.name,
            endpoint: body.endpoint,
            permissions: body.permissions as string[],
            ...(isNonEmptyString(body.token) ? { token: body.token } : {}),
          });
          return reply.code(201).send(redactConnector(record));
        } catch (e) {
          return mapConnectorError(reply, e, 400);
        }
      });

      // Connect runs the MCP handshake. A connector that cannot be reached or
      // negotiated with is a bad gateway — the upstream failed, not the request.
      app.post('/api/connectors/:id/connect', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        try {
          const record = await deps.connectorRegistry!.connect(id);
          return redactConnector(record);
        } catch (e) {
          return mapConnectorError(reply, e, 502);
        }
      });

      app.delete('/api/connectors/:id', { preHandler: requireBearer }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        try {
          return redactConnector(deps.connectorRegistry!.revoke(id));
        } catch (e) {
          return mapConnectorError(reply, e, 400);
        }
      });
    }

    if (deps.decisionStatus) {
      app.get('/api/decision', { preHandler: requireBearer }, async () => deps.decisionStatus);
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

/** Map OrgError to HTTP status: unknown department → 404, duplicate/exists →
 *  409, anything else (bad name/mission/slug) → 400. */
function mapOrgError(reply: FastifyReply, thrown: unknown): FastifyReply {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  if (/unknown department/i.test(detail)) return error(reply, 404, 'not_found', detail);
  if (/already|exists/i.test(detail)) return error(reply, 409, 'conflict', detail);
  return error(reply, 400, 'invalid_request', detail);
}

/** Validate a YYYY-MM-DD date string. */
function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Parse a positive integer query/body value; undefined when not one. */
function parsePositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse a number in [0,1]; undefined when out of range or not finite. */
function parseUnitInterval(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

/** A retraction/forget request must say why and on whose behalf. */
function retractionContext(
  reason: unknown,
  requestedBy: unknown,
): { reason: string; requestedBy: string } | null {
  if (!isNonEmptyString(reason) || !isNonEmptyString(requestedBy)) return null;
  return { reason, requestedBy };
}

/** Optional explicit spec version from a body or query; null when present but
 *  not a usable string (absent means "latest", which the registry resolves). */
function optionalVersion(source: unknown): string | undefined | null {
  const version = (source as { version?: unknown } | null | undefined)?.version;
  if (version === undefined) return undefined;
  return isNonEmptyString(version) ? version : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLessonList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(lesson =>
    isPlainObject(lesson) &&
    isNonEmptyString(lesson.topic) &&
    (lesson.ref === undefined || isNonEmptyString(lesson.ref)));
}

function isCheckList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(check =>
    isPlainObject(check) &&
    isNonEmptyString(check.criterion) &&
    typeof check.passed === 'boolean' &&
    typeof check.score === 'number');
}

/** Map ConnectorRegistry / MCP client throws to HTTP status: unknown id → 404,
 *  duplicate declaration or a revoked connector → 409, out-of-vocabulary
 *  permission claims → 400, anything else → `unreachable` (502 when a handshake
 *  against a real endpoint failed, 400 elsewhere). */
function mapConnectorError(reply: FastifyReply, thrown: unknown, unreachable: 400 | 502): FastifyReply {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  if (thrown instanceof SkillValidationError) return error(reply, 400, 'invalid_request', detail);
  if (/not found/i.test(detail)) return error(reply, 404, 'not_found', detail);
  if (/already declared|is revoked/i.test(detail)) return error(reply, 409, 'conflict', detail);
  return error(reply, unreachable, unreachable === 502 ? 'bad_gateway' : 'invalid_request', detail);
}

/** A connector record carries the bearer token it presents upstream. The driver
 *  face reports that a token exists, never the token. */
function redactConnector(
  record: ConnectorRecord,
): Omit<ConnectorRecord, 'token'> & { hasToken: boolean } {
  const { token, ...rest } = record;
  return { ...rest, hasToken: token !== undefined };
}

/** Map SkillRegistry / MentorshipLedger throws to HTTP status: unknown id → 404,
 *  duplicate or a closed/locked state → 409, anything else (invalid spec,
 *  over-broad hardening, malformed competency check) → 400. */
function mapCatalogueError(reply: FastifyReply, thrown: unknown): FastifyReply {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  if (thrown instanceof SkillNotFoundError || /not found/i.test(detail)) {
    return error(reply, 404, 'not_found', detail);
  }
  if (
    thrown instanceof DuplicateSkillError ||
    /already (exists|registered)|not an active provider|not open|cannot (harden|certify|teach)|is (deprecated|certified|failed|dismissed|uninstalled)/i.test(detail)
  ) {
    return error(reply, 409, 'conflict', detail);
  }
  return error(reply, 400, 'invalid_request', detail);
}

/** Map DiaryError to HTTP status: unsupported/no writable realm → 409,
 *  anything else (boundary, malformed) → 400. */
function mapDiaryError(reply: FastifyReply, thrown: unknown): FastifyReply {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  if (thrown instanceof DiaryUnsupportedError || /no write|not connected|read-only|writable/i.test(detail)) {
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

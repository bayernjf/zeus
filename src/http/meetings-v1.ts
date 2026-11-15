/**
 * Meeting API v1: the write path the console needs so it never touches the
 * meeting store directly. Every rule stays in `src/meeting/protocol.ts`; this
 * module shapes requests, persists through `MeetingStore`, and maps protocol
 * error codes to HTTP.
 *
 * Decision authority is unchanged: `decide` is an operator action behind
 * bearer auth, and the protocol still refuses a decision without a human `by`
 * and a rationale.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  MeetingProtocolError,
  advanceRound,
  createMeeting,
  decide,
  recordUtterance,
} from '../meeting/protocol.js';
import type { MeetingStore } from '../meeting/store.js';
import { exportMarkdown } from '../meeting/export.js';
import { convene, type DraftClaim, type ProposalDraft } from '../meeting/convene.js';
import type { MeetingErrorCode } from '../meeting/protocol.js';
import type { Claim, Meeting, Utterance } from '../meeting/types.js';

const STATUS_FOR_CODE: Record<MeetingErrorCode, number> = {
  'invalid-id': 400,
  'invalid-state': 409,
  'invalid-round': 409,
  'claim-required': 400,
  'evidence-required': 400,
  'rebuttal-required': 400,
  'unknown-claim': 400,
  'duplicate-id': 409,
  'human-decision-required': 400,
  'empty-decision': 400,
};

function sendError(reply: FastifyReply, thrown: unknown): FastifyReply {
  if (thrown instanceof MeetingProtocolError) {
    return reply.code(STATUS_FOR_CODE[thrown.code] ?? 400).send({
      code: thrown.code,
      message: thrown.message,
      retryable: false,
    });
  }
  if (isNotFound(thrown)) {
    return reply.code(404).send({ code: 'MEETING_NOT_FOUND', message: 'meeting not found', retryable: false });
  }
  return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'meeting store failed', retryable: false });
}

function isNotFound(thrown: unknown): boolean {
  return thrown instanceof Error && /ENOENT/.test(thrown.message);
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: 'VALIDATION_FAILED', message, retryable: false });
}

async function loadOr404(store: MeetingStore, id: string, reply: FastifyReply): Promise<Meeting | null> {
  try {
    return await store.load(id);
  } catch (thrown) {
    if (!isNotFound(thrown)) throw thrown;
    void reply.code(404).send({ code: 'MEETING_NOT_FOUND', message: `meeting not found: ${id}`, retryable: false });
    return null;
  }
}

export async function listMeetingsRoute(store: MeetingStore, _request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const meetings = (await store.list()).map(meeting => ({
      id: meeting.id,
      topic: meeting.topic,
      status: meeting.status,
      round: meeting.round,
      maxRounds: meeting.maxRounds,
      utterances: meeting.utterances.length,
      decisions: meeting.decisions.length,
      createdAt: meeting.createdAt,
    }));
    return reply.send({ meetings });
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

export async function openMeetingRoute(store: MeetingStore, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const body = (request.body ?? {}) as { id?: string; topic?: string; maxRounds?: number; now?: string };
    if (typeof body.topic !== 'string' || body.topic.trim().length === 0) return badRequest(reply, 'topic is required');
    const meeting = createMeeting({
      id: body.id ?? `m-${Date.now()}`,
      topic: body.topic,
      createdAt: body.now ?? new Date().toISOString(),
      ...(body.maxRounds !== undefined ? { maxRounds: body.maxRounds } : {}),
    });
    await store.save(meeting);
    return reply.code(201).send(meeting);
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

export async function getMeetingRoute(store: MeetingStore, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const { id } = request.params as { id: string };
    const meeting = await loadOr404(store, id, reply);
    return meeting ? reply.send(meeting) : reply;
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

export async function sayRoute(store: MeetingStore, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      speakerId?: string;
      kind?: 'human' | 'agent';
      stance?: Utterance['stance'];
      claims?: Claim[];
      rebuts?: string[];
      id?: string;
      now?: string;
    };
    if (typeof body.speakerId !== 'string' || body.speakerId.length === 0) return badRequest(reply, 'speakerId is required');
    const meeting = await loadOr404(store, id, reply);
    if (!meeting) return reply;
    // Claims are addressed by id in rebuts, so the API allocates the next
    // `cN` for any claim posted without one; the protocol still rejects an
    // empty or malformed id, so a caller cannot smuggle claim holes in.
    const used = meeting.utterances.flatMap(event => event.claims).reduce((max, claim) => {
      const match = /^c(\d+)$/.exec(claim.id ?? '');
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    const claims: Claim[] = Array.isArray(body.claims)
      ? body.claims.map((claim, index) => ({
        ...claim,
        id: typeof claim.id === 'string' && claim.id.length > 0 ? claim.id : `c${used + index + 1}`,
        evidence: Array.isArray(claim.evidence) ? claim.evidence : [],
      }))
      : [];
    const utterance: Utterance = {
      id: body.id ?? `u-${meeting.utterances.length + 1}`,
      speakerId: body.speakerId,
      kind: body.kind ?? 'agent',
      round: meeting.round,
      stance: body.stance ?? 'propose',
      claims,
      rebuts: Array.isArray(body.rebuts) ? body.rebuts : [],
      at: body.now ?? new Date().toISOString(),
    };
    const next = recordUtterance(meeting, utterance);
    await store.save(next);
    return reply.code(201).send(next);
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

export async function advanceRoute(store: MeetingStore, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const { id } = request.params as { id: string };
    const meeting = await loadOr404(store, id, reply);
    if (!meeting) return reply;
    const next = advanceRound(meeting);
    await store.save(next);
    return reply.send(next);
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

export async function decideRoute(store: MeetingStore, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      by?: string;
      chosenClaimIds?: string[];
      rejectedClaimIds?: string[];
      rationale?: string;
      id?: string;
      now?: string;
    };
    const meeting = await loadOr404(store, id, reply);
    if (!meeting) return reply;
    const next = decide(meeting, {
      id: body.id ?? `d-${meeting.decisions.length + 1}`,
      by: body.by ?? '',
      chosenClaimIds: Array.isArray(body.chosenClaimIds) ? body.chosenClaimIds : [],
      rejectedClaimIds: Array.isArray(body.rejectedClaimIds) ? body.rejectedClaimIds : [],
      rationale: body.rationale ?? '',
      at: body.now ?? new Date().toISOString(),
    });
    await store.save(next);
    return reply.code(201).send(next);
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

/** GET /api/v1/meetings/:id/markdown — the meeting as minutes, for handoff. */
export async function markdownRoute(store: MeetingStore, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const { id } = request.params as { id: string };
    const meeting = await loadOr404(store, id, reply);
    if (!meeting) return reply;
    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${meeting.id}.md"`)
      .send(exportMarkdown(meeting));
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

/**
 * POST /api/v1/meetings/:id/proposals — fill round 1 from a batch of drafts.
 * The console posts operator-written proposals here today; a model-backed
 * source can feed the same shape later without touching the protocol.
 */
export async function conveneRoute(store: MeetingStore, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  try {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { drafts?: unknown };
    if (!Array.isArray(body.drafts) || body.drafts.length === 0) {
      return badRequest(reply, 'drafts must be a non-empty array');
    }
    const drafts: ProposalDraft[] = [];
    for (const raw of body.drafts as Array<Record<string, unknown>>) {
      const speakerId = typeof raw.speakerId === 'string' ? raw.speakerId.trim() : '';
      if (speakerId.length === 0) return badRequest(reply, 'each draft needs a speakerId');
      const claims = Array.isArray(raw.claims) ? (raw.claims as DraftClaim[]) : [];
      drafts.push({
        speakerId,
        claims: claims.map(claim => ({
          text: typeof claim.text === 'string' ? claim.text : '',
          evidence: Array.isArray(claim.evidence) ? claim.evidence : [],
        })),
      });
    }
    const meeting = await loadOr404(store, id, reply);
    if (!meeting) return reply;
    const result = await convene(meeting, async () => ({ drafts }), { kind: 'agent' });
    await store.save(result.meeting);
    return reply.code(201).send(result);
  } catch (thrown) {
    return sendError(reply, thrown);
  }
}

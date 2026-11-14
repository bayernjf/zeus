// Meeting protocol: the state machine plus the guards that keep a debate
// honest. Pure functions returning a new Meeting — nothing is mutated in place,
// so a caller can persist or discard a rejected transition without side effects.

import type {
  Claim,
  ClaimGraph,
  Meeting,
  MeetingDecision,
  Utterance,
} from './types.js';

export type MeetingErrorCode =
  | 'invalid-id'
  | 'invalid-state'
  | 'invalid-round'
  | 'claim-required'
  | 'evidence-required'
  | 'rebuttal-required'
  | 'unknown-claim'
  | 'duplicate-id'
  | 'human-decision-required'
  | 'empty-decision';

export class MeetingProtocolError extends Error {
  readonly code: MeetingErrorCode;

  constructor(code: MeetingErrorCode, message: string) {
    super(message);
    this.name = 'MeetingProtocolError';
    this.code = code;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertId(id: string, what: string): void {
  if (!ID_RE.test(id)) {
    throw new MeetingProtocolError('invalid-id', `${what} must match ${ID_RE.source}: ${id}`);
  }
}

export function createMeeting(input: {
  id: string;
  topic: string;
  createdAt: string;
  maxRounds?: number;
}): Meeting {
  assertId(input.id, 'meeting id');
  const topic = input.topic.trim();
  if (topic.length === 0) {
    throw new MeetingProtocolError('claim-required', 'meeting topic must be non-empty');
  }
  const maxRounds = input.maxRounds ?? 2;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) {
    throw new MeetingProtocolError('invalid-round', `maxRounds must be 1..5, got ${maxRounds}`);
  }
  return {
    id: input.id,
    topic,
    createdAt: input.createdAt,
    status: 'open',
    round: 1,
    maxRounds,
    utterances: [],
    decisions: [],
  };
}

const OPEN_FOR_SPEECH = new Set(['open', 'proposing', 'challenging']);

/** Record one utterance. Round 1 is proposal-only and cannot rebut; round 2+
 *  challenges must name a real claim and carry evidence. */
export function recordUtterance(meeting: Meeting, utterance: Utterance): Meeting {
  if (!OPEN_FOR_SPEECH.has(meeting.status)) {
    throw new MeetingProtocolError('invalid-state', `meeting ${meeting.id} is ${meeting.status}`);
  }
  assertId(utterance.id, 'utterance id');
  if (meeting.utterances.some(existing => existing.id === utterance.id)) {
    throw new MeetingProtocolError('duplicate-id', `utterance id already used: ${utterance.id}`);
  }
  if (utterance.round !== meeting.round) {
    throw new MeetingProtocolError('invalid-round', `expected round ${meeting.round}, got ${utterance.round}`);
  }
  if (utterance.speakerId.trim().length === 0) {
    throw new MeetingProtocolError('invalid-id', 'speakerId must be non-empty');
  }

  const existingClaims = new Map<string, Claim>(
    meeting.utterances.flatMap(event => event.claims).map(claim => [claim.id, claim]),
  );
  for (const claim of utterance.claims) {
    assertId(claim.id, 'claim id');
    if (claim.text.trim().length === 0) {
      throw new MeetingProtocolError('claim-required', `claim ${claim.id} has empty text`);
    }
    if (existingClaims.has(claim.id)) {
      throw new MeetingProtocolError('duplicate-id', `claim id already used: ${claim.id}`);
    }
  }

  if (utterance.stance === 'challenge') {
    if (utterance.round === 1) {
      throw new MeetingProtocolError('invalid-state', 'round 1 is proposal-only; challenges open in round 2');
    }
    if (utterance.rebuts.length === 0) {
      throw new MeetingProtocolError('rebuttal-required', `challenge ${utterance.id} must rebut a claim id`);
    }
    for (const target of utterance.rebuts) {
      if (!existingClaims.has(target)) {
        throw new MeetingProtocolError('unknown-claim', `cannot rebut unknown claim: ${target}`);
      }
      if (utterance.claims.some(claim => claim.id === target)) {
        throw new MeetingProtocolError('duplicate-id', `utterance ${utterance.id} rebuts its own claim ${target}`);
      }
    }
    const unsupported = utterance.claims.filter(claim => claim.evidence.length === 0);
    if (unsupported.length > 0) {
      throw new MeetingProtocolError(
        'evidence-required',
        `challenge claims need evidence: ${unsupported.map(claim => claim.id).join(', ')}`,
      );
    }
  } else {
    if (utterance.rebuts.length > 0) {
      throw new MeetingProtocolError('invalid-state', `stance ${utterance.stance} cannot rebut claims`);
    }
    if (utterance.stance === 'propose' && utterance.claims.length === 0) {
      throw new MeetingProtocolError('claim-required', `proposal ${utterance.id} must carry at least one claim`);
    }
  }

  const status = meeting.status === 'open' ? 'proposing' : meeting.status;
  return { ...meeting, status, utterances: [...meeting.utterances, utterance] };
}

/** Move to the next round. Once the cap is reached the meeting converges and
 *  only a human decision can move it further. */
export function advanceRound(meeting: Meeting): Meeting {
  if (meeting.status !== 'proposing' && meeting.status !== 'challenging') {
    throw new MeetingProtocolError('invalid-state', `cannot advance a ${meeting.status} meeting`);
  }
  const spokeThisRound = meeting.utterances.some(utterance => utterance.round === meeting.round);
  if (!spokeThisRound) {
    throw new MeetingProtocolError('invalid-round', `round ${meeting.round} has no utterance yet`);
  }
  if (meeting.round >= meeting.maxRounds) {
    return { ...meeting, status: 'converging' };
  }
  return { ...meeting, round: meeting.round + 1, status: 'challenging' };
}

/** Record a human decision. Only converging meetings can be decided; the
 *  decision is append-only and must name at least one surviving or rejected claim. */
export function decide(meeting: Meeting, decision: MeetingDecision): Meeting {
  if (meeting.status !== 'converging') {
    throw new MeetingProtocolError('invalid-state', `only converging meetings can be decided, got ${meeting.status}`);
  }
  assertId(decision.id, 'decision id');
  if (meeting.decisions.some(existing => existing.id === decision.id)) {
    throw new MeetingProtocolError('duplicate-id', `decision id already used: ${decision.id}`);
  }
  if (decision.by.trim().length === 0) {
    throw new MeetingProtocolError('human-decision-required', 'decision needs a human owner');
  }
  if (decision.rationale.trim().length === 0) {
    throw new MeetingProtocolError('human-decision-required', 'decision needs a rationale');
  }
  if (decision.chosenClaimIds.length === 0 && decision.rejectedClaimIds.length === 0) {
    throw new MeetingProtocolError('empty-decision', 'decision must choose or reject at least one claim');
  }
  const known = new Set(meeting.utterances.flatMap(event => event.claims).map(claim => claim.id));
  for (const claimId of [...decision.chosenClaimIds, ...decision.rejectedClaimIds]) {
    if (!known.has(claimId)) {
      throw new MeetingProtocolError('unknown-claim', `decision references unknown claim: ${claimId}`);
    }
  }
  const overlap = decision.chosenClaimIds.filter(claimId => decision.rejectedClaimIds.includes(claimId));
  if (overlap.length > 0) {
    throw new MeetingProtocolError('empty-decision', `claim chosen and rejected at once: ${overlap.join(', ')}`);
  }
  return { ...meeting, status: 'decided', decisions: [...meeting.decisions, decision] };
}

export function archive(meeting: Meeting): Meeting {
  if (meeting.status !== 'decided') {
    throw new MeetingProtocolError('invalid-state', `only decided meetings can be archived, got ${meeting.status}`);
  }
  return { ...meeting, status: 'archived' };
}

export function abandon(meeting: Meeting): Meeting {
  if (meeting.status === 'archived' || meeting.status === 'abandoned') {
    throw new MeetingProtocolError('invalid-state', `meeting already ${meeting.status}`);
  }
  return { ...meeting, status: 'abandoned' };
}

/** Replay view: every claim plus who attacked it, and the points still open. */
export function claimGraph(meeting: Meeting): ClaimGraph {
  const nodes = meeting.utterances.flatMap(utterance =>
    utterance.claims.map(claim => ({
      claim,
      speakerId: utterance.speakerId,
      round: utterance.round,
      rebuttedBy: utterance.rebuts,
    })));
  const byTarget = new Map<string, string[]>();
  for (const utterance of meeting.utterances) {
    for (const target of utterance.rebuts) {
      const list = byTarget.get(target) ?? [];
      list.push(utterance.id);
      byTarget.set(target, list);
    }
  }
  const resolved = new Set(
    meeting.decisions.flatMap(decision => [...decision.chosenClaimIds, ...decision.rejectedClaimIds]),
  );
  const undecided = nodes
    .map(node => node.claim.id)
    .filter(id => !resolved.has(id) && (byTarget.get(id)?.length ?? 0) > 0);
  return {
    meetingId: meeting.id,
    nodes: nodes.map(node => ({ ...node, rebuttedBy: byTarget.get(node.claim.id) ?? [] })),
    undecided,
  };
}

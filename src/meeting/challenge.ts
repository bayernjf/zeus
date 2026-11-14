// S3: cross-challenge. Critics never see the whole meeting — only a projection
// (claim id / text / evidence refs / how often it was already rebutted), so a
// critic cannot echo a proposer's reasoning back as its own. Targets are picked
// deterministically: least-rebutted first, decided claims excluded.

import { MeetingProtocolError, recordUtterance } from './protocol.js';
import type { Claim, EvidenceKind, Meeting, Utterance } from './types.js';
import type { DraftClaim, SkippedProposal } from './convene.js';

export type ClaimProjection = {
  id: string;
  text: string;
  /** Evidence is projected down to kind + ref: the note can carry the proposer's
   *  reasoning, which is exactly what a critic should not inherit. */
  evidence: { kind: EvidenceKind; ref: string }[];
  rebutCount: number;
};

export type CriticInput = {
  topic: string;
  round: number;
  targets: string[];
  claims: ClaimProjection[];
};

export type ChallengeDraft = {
  speakerId: string;
  rebuts: string[];
  claims: DraftClaim[];
};

export type ChallengeBatch = { drafts: ChallengeDraft[]; skipped?: SkippedProposal[] };

export type CriticSource = (input: CriticInput) => Promise<ChallengeBatch>;

export type ChallengeResult = {
  meeting: Meeting;
  recorded: { utteranceId: string; speakerId: string; claimIds: string[]; rebuts: string[] }[];
  skipped: SkippedProposal[];
  /** True when this round added no new claim — the debate is repeating itself. */
  stable: boolean;
  targets: string[];
};

/** Deterministic target selection: claims that got the least pushback are the
 *  least tested, so they are the ones worth attacking next. */
export function selectTargets(meeting: Meeting, limit = 2): string[] {
  const claims = allClaims(meeting);
  const decided = resolvedClaimIds(meeting);
  const rebutCount = rebutCounts(meeting);
  return claims
    .filter(claim => !decided.has(claim.id))
    .sort((a, b) => {
      const left = rebutCount.get(a.id) ?? 0;
      const right = rebutCount.get(b.id) ?? 0;
      return left === right ? a.id.localeCompare(b.id) : left - right;
    })
    .slice(0, limit)
    .map(claim => claim.id);
}

export function projectClaims(meeting: Meeting): ClaimProjection[] {
  const rebutCount = rebutCounts(meeting);
  return allClaims(meeting).map(claim => ({
    id: claim.id,
    text: claim.text,
    evidence: claim.evidence.map(evidence => ({ kind: evidence.kind, ref: evidence.ref })),
    rebutCount: rebutCount.get(claim.id) ?? 0,
  }));
}

/** Fill the current challenging round from a critic source. A draft the protocol
 *  rejects becomes a skipped entry — the meeting never takes a half-valid rebuttal. */
export async function challenge(
  meeting: Meeting,
  source: CriticSource,
  options: { limit?: number; targets?: string[] } = {},
): Promise<ChallengeResult> {
  if (meeting.status !== 'challenging') {
    throw new MeetingProtocolError('invalid-state', `challenges need a challenging meeting, got ${meeting.status}`);
  }
  if (meeting.round < 2) {
    throw new MeetingProtocolError('invalid-round', `challenges open in round 2+, meeting is at round ${meeting.round}`);
  }

  const targets = options.targets ?? selectTargets(meeting, options.limit ?? 2);
  const claimsBefore = new Set(allClaims(meeting).map(claim => claim.id));
  const batch = await source({
    topic: meeting.topic,
    round: meeting.round,
    targets,
    claims: projectClaims(meeting),
  });

  let next = meeting;
  const recorded: ChallengeResult['recorded'] = [];
  const skipped: SkippedProposal[] = [...(batch.skipped ?? [])];
  let utteranceSeq = next.utterances.length;
  let claimSeq = allClaims(next).length;
  let addedClaims = 0;

  for (const draft of batch.drafts) {
    const used = new Set(allClaims(next).map(claim => claim.id));
    const claims: Claim[] = [];
    for (const draftClaim of draft.claims) {
      if (draftClaim.text.trim().length === 0) continue;
      let id: string;
      do {
        claimSeq += 1;
        id = `c${claimSeq}`;
      } while (used.has(id));
      used.add(id);
      claims.push({
        id,
        text: draftClaim.text.trim(),
        evidence: draftClaim.evidence ?? [],
      });
    }
    utteranceSeq += 1;
    const utterance: Utterance = {
      id: `u-${utteranceSeq}`,
      speakerId: draft.speakerId,
      kind: 'agent',
      round: meeting.round,
      stance: 'challenge',
      claims,
      rebuts: draft.rebuts,
      at: new Date().toISOString(),
    };
    try {
      next = recordUtterance(next, utterance);
      addedClaims += claims.filter(claim => !claimsBefore.has(claim.id)).length;
      recorded.push({
        utteranceId: utterance.id,
        speakerId: utterance.speakerId,
        claimIds: claims.map(claim => claim.id),
        rebuts: utterance.rebuts,
      });
    } catch (error) {
      if (error instanceof MeetingProtocolError) {
        skipped.push({ speakerId: draft.speakerId, reason: error.message });
        continue;
      }
      throw error;
    }
  }

  return { meeting: next, recorded, skipped, stable: recorded.length > 0 && addedClaims === 0, targets };
}

/** What the owner should do next, derived rather than guessed. */
export function nextStep(meeting: Meeting): 'decide' | 'converge' | 'challenge' | 'propose' {
  if (meeting.status === 'converging' || meeting.status === 'decided') return 'decide';
  if (meeting.status === 'open') return 'propose';
  if (meeting.status === 'proposing') return 'challenge';
  const currentClaims = meeting.utterances.filter(utterance => utterance.round === meeting.round);
  const before = new Set(
    meeting.utterances
      .filter(utterance => utterance.round < meeting.round)
      .flatMap(utterance => utterance.claims.map(claim => claim.id)),
  );
  const added = currentClaims.flatMap(utterance => utterance.claims).filter(claim => !before.has(claim.id));
  if (currentClaims.length > 0 && added.length === 0) return 'converge';
  return 'challenge';
}

function allClaims(meeting: Meeting): Claim[] {
  return meeting.utterances.flatMap(utterance => utterance.claims);
}

function rebutCounts(meeting: Meeting): Map<string, number> {
  const counts = new Map<string, number>();
  for (const utterance of meeting.utterances) {
    for (const target of utterance.rebuts) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

function resolvedClaimIds(meeting: Meeting): Set<string> {
  return new Set(meeting.decisions.flatMap(decision => [...decision.chosenClaimIds, ...decision.rejectedClaimIds]));
}

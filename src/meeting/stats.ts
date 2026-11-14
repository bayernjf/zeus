// Meeting metrics: the numbers that tell you whether a meeting was productive
// (rounds used, how much of the claim set got evidence, how much survived the
// cross-challenge, how much the human actually decided).

import type { Meeting } from './types.js';

export type MeetingStats = {
  id: string;
  status: string;
  roundsUsed: number;
  maxRounds: number;
  utterances: number;
  humanUtterances: number;
  claims: number;
  rebuttals: number;
  claimsWithEvidence: number;
  challengedClaims: number;
  adopted: number;
  rejected: number;
  openClaims: number;
  /** adopted / claims; null until a decision exists — 0 would read as "nothing adopted". */
  adoptionRate: number | null;
  /** Rough prompt-size proxy: 4 characters ≈ 1 token. */
  estimatedTokens: number;
};

export function meetingStats(meeting: Meeting): MeetingStats {
  const claims = meeting.utterances.flatMap(utterance => utterance.claims);
  const decided = new Set<string>();
  const adopted = new Set<string>();
  const rejected = new Set<string>();
  for (const decision of meeting.decisions) {
    for (const id of decision.chosenClaimIds) {
      adopted.add(id);
      decided.add(id);
    }
    for (const id of decision.rejectedClaimIds) {
      rejected.add(id);
      decided.add(id);
    }
  }
  const rebutted = new Set(meeting.utterances.flatMap(utterance => utterance.rebuts));
  const openClaims = claims.filter(claim => rebutted.has(claim.id) && !decided.has(claim.id)).length;
  const text = meeting.topic + meeting.utterances.map(describe).join('');

  return {
    id: meeting.id,
    status: meeting.status,
    roundsUsed: meeting.round,
    maxRounds: meeting.maxRounds,
    utterances: meeting.utterances.length,
    humanUtterances: meeting.utterances.filter(utterance => utterance.kind === 'human').length,
    claims: claims.length,
    rebuttals: meeting.utterances.reduce((sum, utterance) => sum + utterance.rebuts.length, 0),
    claimsWithEvidence: claims.filter(claim => claim.evidence.length > 0).length,
    challengedClaims: rebutted.size,
    adopted: adopted.size,
    rejected: rejected.size,
    openClaims,
    adoptionRate: claims.length === 0 || meeting.decisions.length === 0 ? null : adopted.size / claims.length,
    estimatedTokens: Math.ceil(text.length / 4),
  };
}

function describe(utterance: Meeting['utterances'][number]): string {
  const claims = utterance.claims.map(claim => claim.text + claim.evidence.map(e => e.note).join(''));
  return `${utterance.speakerId}${claims.join('')}${utterance.rebuts.join('')}`;
}

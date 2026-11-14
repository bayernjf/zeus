// Meeting domain (D9-1 meeting feature, step 1): a meeting is a bounded
// state machine, not a chat log. The model exists so that "why did we decide
// this" can be replayed as a claim graph — which claim was challenged by whom,
// in which round, on what evidence — instead of re-reading a transcript.

/** Lifecycle. A meeting can only move forward; nothing is reopened. */
export type MeetingStatus =
  | 'open'
  | 'proposing'
  | 'challenging'
  | 'converging'
  | 'decided'
  | 'archived'
  | 'abandoned';

export type SpeakerKind = 'human' | 'agent';

/** propose = 提案；challenge = 反驳；support = 附议；note = 补充事实。 */
export type Stance = 'propose' | 'challenge' | 'support' | 'note';

/** A rebuttal or a proposal without evidence is an opinion, and opinions do
 *  not close a debate — so evidence is required on challenge. */
export type EvidenceKind = 'fact' | 'observation' | 'reference' | 'counterexample';

export type Evidence = {
  kind: EvidenceKind;
  /** Where it came from: a dataDomain fact id, a file path, a URL, a case id. */
  ref: string;
  note: string;
};

/** One testable assertion. `id` is the handles other speakers rebut against. */
export type Claim = {
  id: string;
  text: string;
  evidence: Evidence[];
};

export type Utterance = {
  id: string;
  speakerId: string;
  kind: SpeakerKind;
  /** 1-based; round 1 is independent proposals, round 2+ is cross-challenge. */
  round: number;
  stance: Stance;
  claims: Claim[];
  /** Claim ids this utterance attacks. Empty in round 1; required in round 2+. */
  rebuts: string[];
  at: string;
};

/** The human's decision. Append-only; a decision is never edited, a new one
 *  supersedes it. `by` must be a human speaker. */
export type MeetingDecision = {
  id: string;
  by: string;
  chosenClaimIds: string[];
  rejectedClaimIds: string[];
  rationale: string;
  at: string;
};

export type Meeting = {
  id: string;
  topic: string;
  createdAt: string;
  status: MeetingStatus;
  /** Last round reached. */
  round: number;
  /** Round cap: beyond it the meeting converges and goes to the human. */
  maxRounds: number;
  utterances: Utterance[];
  decisions: MeetingDecision[];
};

/** Replay view: every claim with the utterances that attacked it. */
export type ClaimNode = {
  claim: Claim;
  speakerId: string;
  round: number;
  rebuttedBy: string[];
};

export type ClaimGraph = {
  meetingId: string;
  nodes: ClaimNode[];
  /** Claim ids with no surviving rebuttal and not rejected by a decision. */
  undecided: string[];
};

// S2: automatic proposals. A meeting round 1 can be filled from any proposal
// source — today a static drafts file or a real orchestrator fan-out — while the
// protocol guards stay the only way utterances enter the meeting. A source that
// fails or returns junk is recorded as skipped, never as a half-valid utterance.

import type { Orchestrator } from '../core/orchestrator/orchestrator.js';
import type { BranchOutcome, FanOutRequest, FanOutResult } from '../core/orchestrator/types.js';
import { MeetingProtocolError, recordUtterance } from './protocol.js';
import type { Claim, Evidence, Meeting, SpeakerKind, Utterance } from './types.js';

export type DraftClaim = { text: string; evidence?: Evidence[] };

export type ProposalDraft = {
  speakerId: string;
  claims: DraftClaim[];
};

export type SkippedProposal = { speakerId: string; reason: string };

export type ProposalBatch = {
  drafts: ProposalDraft[];
  skipped?: SkippedProposal[];
};

export type ProposalSource = (input: {
  topic: string;
  round: number;
  existingClaimIds: readonly string[];
}) => Promise<ProposalBatch>;

export type ConveneResult = {
  meeting: Meeting;
  recorded: { utteranceId: string; speakerId: string; claimIds: string[] }[];
  skipped: SkippedProposal[];
};

/** Fill round 1 from a proposal source. Claim ids are assigned here, so a
 *  source never has to invent ids and a duplicate can never slip through. */
export async function convene(
  meeting: Meeting,
  source: ProposalSource,
  options: { kind?: SpeakerKind } = {},
): Promise<ConveneResult> {
  if (meeting.status !== 'open' && meeting.status !== 'proposing') {
    throw new MeetingProtocolError('invalid-state', `cannot convene a ${meeting.status} meeting`);
  }
  if (meeting.round !== 1) {
    throw new MeetingProtocolError('invalid-round', `convene fills round 1 only, meeting is at round ${meeting.round}`);
  }

  const batch = await source({
    topic: meeting.topic,
    round: meeting.round,
    existingClaimIds: meeting.utterances.flatMap(utterance => utterance.claims.map(claim => claim.id)),
  });

  let next = meeting;
  const recorded: ConveneResult['recorded'] = [];
  const skipped: SkippedProposal[] = [...(batch.skipped ?? [])];
  let utteranceSeq = next.utterances.length;
  let claimSeq = next.utterances.flatMap(utterance => utterance.claims).length;

  for (const draft of batch.drafts) {
    const usable = draft.claims.filter(claim => claim.text.trim().length > 0);
    if (usable.length === 0) {
      skipped.push({ speakerId: draft.speakerId, reason: 'proposal has no claim' });
      continue;
    }
    const used = new Set(next.utterances.flatMap(utterance => utterance.claims).map(claim => claim.id));
    const claims: Claim[] = [];
    for (const draftClaim of usable) {
      let id: string;
      do {
        claimSeq += 1;
        id = `c${claimSeq}`;
      } while (used.has(id));
      used.add(id);
      claims.push({ id, text: draftClaim.text.trim(), evidence: draftClaim.evidence ?? [] });
    }
    utteranceSeq += 1;
    const utterance: Utterance = {
      id: `u-${utteranceSeq}`,
      speakerId: draft.speakerId,
      kind: options.kind ?? 'agent',
      round: 1,
      stance: 'propose',
      claims,
      rebuts: [],
      at: new Date().toISOString(),
    };
    next = recordUtterance(next, utterance);
    recorded.push({
      utteranceId: utterance.id,
      speakerId: utterance.speakerId,
      claimIds: claims.map(claim => claim.id),
    });
  }

  return { meeting: next, recorded, skipped };
}

/** Map one fan-out result onto proposals: a failed/refused branch is a skipped
 *  proposal with its reason, never an empty claim. */
export function proposalBatchFromFanOut(result: FanOutResult): ProposalBatch {
  const drafts: ProposalDraft[] = [];
  const skipped: SkippedProposal[] = [];
  for (const branch of result.branches) {
    if (!branch.ok) {
      skipped.push({
        speakerId: branch.executor,
        reason: branch.reason ?? branch.state ?? 'branch did not settle ok',
      });
      continue;
    }
    const text = branchText(branch);
    if (text.length === 0) {
      skipped.push({ speakerId: branch.executor, reason: 'branch produced no text artifact' });
      continue;
    }
    drafts.push({
      speakerId: branch.executor,
      claims: claimsFromText(text, branch),
    });
  }
  return { drafts, skipped };
}

function branchText(branch: BranchOutcome): string {
  const artifacts = (branch.task?.artifacts ?? []) as unknown[];
  const texts = artifacts
    .map(artifact => {
      if (typeof artifact === 'string') return artifact;
      if (typeof artifact !== 'object' || artifact === null) return '';
      const record = artifact as { text?: unknown; data?: { text?: unknown } };
      if (typeof record.text === 'string') return record.text;
      if (typeof record.data?.text === 'string') return record.data.text;
      return '';
    })
    .filter(text => text.trim().length > 0);
  if (texts.length > 0) return texts.join('\n').trim();
  return branch.reason?.trim() ?? '';
}

/** Prefer a `{"claims":[{"text","evidence"}]}` block when the executor emits
 *  structured output; otherwise treat the whole text as one claim. */
function claimsFromText(text: string, branch: BranchOutcome): DraftClaim[] {
  const parsed = parseClaimsBlock(text);
  if (parsed) return parsed;
  return [{
    text,
    evidence: [{
      kind: 'reference',
      ref: `run:${branch.runId}`,
      note: branch.executor,
    }],
  }];
}

function parseClaimsBlock(text: string): DraftClaim[] | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const rawClaims = (value as { claims?: unknown }).claims;
  if (!Array.isArray(rawClaims)) return undefined;
  const claims: DraftClaim[] = [];
  for (const raw of rawClaims) {
    if (typeof raw !== 'object' || raw === null) continue;
    const claim = raw as { text?: unknown; evidence?: unknown };
    if (typeof claim.text !== 'string' || claim.text.trim().length === 0) continue;
    const evidence: Evidence[] = [];
    if (Array.isArray(claim.evidence)) {
      for (const item of claim.evidence) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as { kind?: unknown; ref?: unknown; note?: unknown };
        if (typeof record.ref !== 'string') continue;
        const kind = record.kind === 'fact' || record.kind === 'observation' || record.kind === 'reference' || record.kind === 'counterexample'
          ? record.kind
          : 'reference';
        evidence.push({ kind, ref: record.ref, note: typeof record.note === 'string' ? record.note : '' });
      }
    }
    claims.push({ text: claim.text, evidence });
  }
  return claims.length > 0 ? claims : undefined;
}

/** A proposal source backed by the real orchestrator: one fan-out, one branch
 *  per executor. Callers keep the request (skill/executors/params) explicit. */
export function orchestratorProposalSource(
  orchestrator: Orchestrator,
  request: Omit<FanOutRequest, 'intentId'> & { intentId?: string },
): ProposalSource {
  return async () => {
    const result = await orchestrator.fanOut({
      ...request,
      intentId: request.intentId ?? `meeting-${Date.now()}`,
    });
    return proposalBatchFromFanOut(result);
  };
}

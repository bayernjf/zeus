import { sha256Hex } from '../util/crypto.js';
import type { FanOutRequest, FanOutResult, Position } from '../orchestrator/types.js';
import { stableStringify } from './consolidate.js';
import type { MemoryEvent } from './types.js';

/**
 * The kernel's only producer of memory events (design-memory-consolidation §8,
 * deferred #27). Before this, nothing outside `src/memory` ever appended an
 * event: the fact source, consolidation, disputes, recall, forgetting and the
 * diary were all built and tested, but a running process fed them nothing, so
 * they read as working features while returning empty results.
 *
 * Boundary rule from §8.1: a memory event is a claim that is true of a realm.
 * Dispatch actions and refusals already live on the audit spine and are not
 * copied here - duplicating them would produce many events and still no facts,
 * and would widen the erasure surface of the right to be forgotten.
 */

/** A stance longer than this is truncated: a claim is a vote, not an archive. */
export const MAX_STANCE_CHARS = 512;

/** The default self-reported confidence. The A2A artifact carries a stance and
 *  no author-side confidence, and `Position.weight` is a voting weight - using
 *  it here would let the aggregation rule masquerade as an epistemic claim. */
const DEFAULT_CONFIDENCE = 0.5;

export type BranchClaimOptions = {
  /** The connected realm the intent operated on; claims are attributed to it. */
  realmId: string;
  occurredAt: string;
};

function textParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * What a fan-out was asked about, in a form two independent intents can agree
 * on. Explicit `params.subject` wins; otherwise the key is derived from the
 * skill plus the question itself - deliberately *not* from the intentId, since
 * a per-intent subject could never collide, and a collision is what turns two
 * answers into a dispute instead of two unrelated facts.
 */
export function claimSubject(request: FanOutRequest): string {
  const explicit = textParam(request.params, 'subject');
  if (explicit) return explicit;
  const { subject: _subject, predicate: _predicate, ...question } = request.params ?? {};
  return `topic:${sha256Hex(`${request.skill}␟${stableStringify(question)}`).slice(0, 16)}`;
}

export function claimPredicate(request: FanOutRequest): string {
  return textParam(request.params, 'predicate') || request.skill;
}

/** Object of the claim: the stance text, truncated with a visible marker. */
function claimObject(stance: string): string {
  if (stance.length <= MAX_STANCE_CHARS) return stance;
  return `${stance.slice(0, MAX_STANCE_CHARS - 1)}…`;
}

/** One claim per distinct (author, stance). Rationale is dropped on purpose:
 *  keeping it would split votes by wording rather than by substance. */
export function branchVerdictClaims(
  result: FanOutResult,
  request: FanOutRequest,
  options: BranchClaimOptions,
): MemoryEvent[] {
  const subject = claimSubject(request);
  const predicate = claimPredicate(request);
  const seen = new Set<string>();
  const events: MemoryEvent[] = [];

  for (const position of result.positions as Position[]) {
    const stance = typeof position.stance === 'string' ? position.stance.trim() : '';
    if (!stance) continue;
    const object = claimObject(stance);
    const eventId = sha256Hex(`${result.runId}␟${position.vassal}␟${object}`);
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    const branch = result.branches.find(entry => entry.vassal === position.vassal);
    events.push({
      eventId,
      realmId: options.realmId,
      runId: result.runId,
      source: {
        agentId: position.vassal,
        ...(branch?.taskId ? { taskId: branch.taskId } : {}),
      },
      kind: 'claim',
      content: { subject, predicate, object },
      refs: [result.intentId, result.runId],
      confidence: DEFAULT_CONFIDENCE,
      occurredAt: options.occurredAt,
    });
  }
  return events;
}

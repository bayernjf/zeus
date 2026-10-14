/**
 * Write-back face of the execution-after loop (design-memory-self-evolution
 * §2.2 / §九). This module is the *mechanical* half: it turns active
 * write-back cards (经验卡) into parameter overrides and back. It never decides
 * what to write back — that is the read-only reflection in
 * `src/reflection/failure-attribution.ts` — it only applies and retracts.
 *
 * Reversibility is structural, not advisory: an active card contributes an
 * override; removing/retracting it makes `selectionWeightsFromWritebacks`
 * return the baseline (no entry) and behaviour reverts with no further action.
 * That is what makes the write-back auditable and rollback-able (design
 * constraint 2), and what the defect-injection tests below guard.
 *
 * Gating: the *real-load* hook-up (consuming these weights at dispatch) waits
 * for deferred #40's trigger — a first real execution agent with a failure
 * sample distribution. The mechanism itself is built here with synthetic
 * samples so it is verifiable before any real load exists.
 */

import type { WritebackRecord } from './types.js';

/** Lowest allowed factor; a target can be deprioritised but never zeroed
 *  (fail-soft: a down-weighted vassal stays reachable when others saturate). */
export const MIN_WRITEWEIGHT_FACTOR = 0.1;

export type RecordWritebackInput = {
  id?: string;
  realmId: string;
  source: WritebackRecord['source'];
  param: WritebackRecord['param'];
  target: string;
  factor: number;
  reason: string;
};

/**
 * Active `selection-weight` overrides keyed by target, the newest card per
 * target wins on conflict. Returns `{}` when no active selection-weight cards
 * exist — that is the baseline, and callers must treat a missing key as weight 1.
 */
export function selectionWeightsFromWritebacks(records: WritebackRecord[]): Record<string, number> {
  const latest: Record<string, WritebackRecord> = {};
  for (const r of records) {
    if (r.status !== 'active' || r.param !== 'selection-weight') continue;
    const cur = latest[r.target];
    if (cur === undefined || r.createdAt > cur.createdAt) latest[r.target] = r;
  }
  const out: Record<string, number> = {};
  for (const [target, r] of Object.entries(latest)) out[target] = r.factor;
  return out;
}

/**
 * Owns the active write-back cards for all realms. Records are append-only in
 * spirit (a retract keeps the row, flips status) so the action is always
 * traceable. Pure with respect to persistence — the store decides where the
 * cards live.
 */
export class WritebackLedger {
  private readonly cards: WritebackRecord[] = [];
  private readonly now: () => Date;
  private readonly idOf: () => string;

  constructor(now: () => Date = () => new Date(), idOf: () => string = () => crypto.randomUUID()) {
    this.now = now;
    this.idOf = idOf;
  }

  record(input: RecordWritebackInput): WritebackRecord {
    if (!(input.factor >= MIN_WRITEWEIGHT_FACTOR) || input.factor > 1) {
      throw new RangeError(
        `writeback factor must be within (${MIN_WRITEWEIGHT_FACTOR}, 1], got ${input.factor}`,
      );
    }
    const card: WritebackRecord = {
      id: input.id ?? this.idOf(),
      realmId: input.realmId,
      createdAt: this.now().toISOString(),
      source: input.source,
      param: input.param,
      target: input.target,
      factor: input.factor,
      reason: input.reason,
      status: 'active',
    };
    this.cards.push(card);
    return card;
  }

  /** Retract a card by id. Returns the retracted card, or null if unknown. */
  retract(id: string): WritebackRecord | null {
    const card = this.cards.find((c) => c.id === id);
    if (card === undefined || card.status === 'retracted') return null;
    card.status = 'retracted';
    card.retractedAt = this.now().toISOString();
    return card;
  }

  list(realmId?: string): WritebackRecord[] {
    return this.cards
      .filter((c) => realmId === undefined || c.realmId === realmId)
      .map((c) => ({ ...c }));
  }

  /** Active `selection-weight` overrides for a realm; baseline `{}` when none. */
  selectionWeights(realmId: string): Record<string, number> {
    return selectionWeightsFromWritebacks(this.list(realmId));
  }
}

import type { Task } from '../../a2a/types.js';
import type { AggregatedDecision, AggregationRule, BranchOutcome, Position } from './types.js';

const STANCE_KEYS = ['stance', 'verdict'] as const;

/**
 * Pull a vassal's stance out of its terminal task's data parts, if it gave one.
 *
 * Trust boundary (deep review 2026-11-02 P1-2): the artifact contract is
 * stance + rationale only. A vassal-reported `weight` is never ingested —
 * `Position.weight` is a voting weight assigned by the platform/caller, not an
 * author-side claim (the memory producer reads no weight for the same reason).
 * A vassal that wants a bigger say must be granted it operator-side; it cannot
 * self-report one.
 */
export function extractStance(task: Task): { stance: string; rationale?: string } | null {
  for (const artifact of task.artifacts) {
    for (const part of artifact.parts) {
      if (part.kind !== 'data') continue;
      const data = part.data as Record<string, unknown>;
      const stance = STANCE_KEYS.map(key => data[key]).find(value => typeof value === 'string' && value.trim() !== '');
      if (typeof stance === 'string') {
        return {
          stance,
          ...(typeof data.rationale === 'string' ? { rationale: data.rationale } : {}),
        };
      }
    }
  }
  return null;
}

/** Collect stances from successful branches; branches without a stance are omitted
 *  (they neither vote nor constitute a conflict). */
export function extractPositions(branches: BranchOutcome[]): Position[] {
  const positions: Position[] = [];
  for (const branch of branches) {
    if (!branch.ok || !branch.task) continue;
    const found = extractStance(branch.task);
    if (found) positions.push({ vassal: branch.vassal, ...found });
  }
  return positions;
}

function groupByStance(positions: Position[]): Map<string, Position[]> {
  const groups = new Map<string, Position[]>();
  for (const position of positions) {
    const list = groups.get(position.stance) ?? [];
    list.push(position);
    groups.set(position.stance, list);
  }
  return groups;
}

/** Deterministic, model-free aggregation. Never invents a conclusion: when the
 *  rule cannot decide, conclusion is null and the caller must escalate. */
export function aggregate(positions: Position[], rule: AggregationRule = { kind: 'majority' }): AggregatedDecision {
  const base = { rule: rule.kind, positions, conclusion: null as string | null };

  if (positions.length === 0) {
    return { ...base, reason: 'no vassal returned a stance; nothing to aggregate' };
  }

  const groups = groupByStance(positions);
  const distinct = [...groups.keys()];

  if (rule.kind === 'unanimous') {
    if (distinct.length === 1) {
      return { ...base, conclusion: distinct[0]!, reason: `unanimous: all ${positions.length} vassal(s) hold "${distinct[0]}"` };
    }
    return { ...base, reason: `not unanimous: ${distinct.length} distinct stances among ${positions.length} vassal(s)` };
  }

  if (rule.kind === 'majority') {
    const tally = distinct.map(stance => ({ stance, count: groups.get(stance)!.length }));
    tally.sort((a, b) => b.count - a.count || a.stance.localeCompare(b.stance));
    // positions.length > 0 is already returned above, so the tally is never empty.
    const top = tally[0]!;
    const tied = tally.filter(item => item.count === top.count);
    const total = positions.length;
    if (tied.length === 1 && top.count > total / 2) {
      return {
        ...base,
        conclusion: top.stance,
        margin: { winner: top.stance, winnerCount: top.count, total },
        reason: `majority: "${top.stance}" ${top.count}/${total}`,
      };
    }
    return { ...base, reason: tied.length > 1 ? `tie at ${top.count}/${total}` : `no strict majority for "${top.stance}" (${top.count}/${total})` };
  }

  // weighted
  const threshold = rule.threshold ?? 0.5;
  // Fail-closed weight gate (deep review 2026-11-02 P1-2): a position whose
  // weight is not finite and >= 0 is isolated — it neither votes nor poisons
  // the total — and the exclusion is recorded in `reason` so the decision
  // stays auditable. No upper clamp: the rule is a ratio, scale carries no
  // meaning, and a sum overflowing to Infinity drives every share to 0/NaN,
  // which fails the threshold and escalates (fail-closed by construction).
  const weightValid = (p: Position): boolean => p.weight === undefined || (Number.isFinite(p.weight) && p.weight >= 0);
  const voters = positions.filter(weightValid);
  const excluded = positions.filter(p => !weightValid(p));
  const exclusion = excluded.length > 0
    ? `excluded ${excluded.length} position(s) with non-finite or negative weight (${excluded.map(p => p.vassal).join(', ')}); `
    : '';
  const voterGroups = groupByStance(voters);
  const voterStances = [...voterGroups.keys()];
  if (voterStances.length === 0) {
    return { ...base, reason: `${exclusion}no position carries a valid weight; nothing to tally` };
  }
  const totalWeight = voters.reduce((sum, p) => sum + (p.weight ?? 1), 0);
  const tally = voterStances.map(stance => ({
    stance,
    weight: voterGroups.get(stance)!.reduce((sum, p) => sum + (p.weight ?? 1), 0),
  }));
  tally.sort((a, b) => b.weight - a.weight || a.stance.localeCompare(b.stance));
  const top = tally[0]!;
  const tied = tally.filter(item => item.weight === top.weight);
  if (tied.length === 1 && totalWeight > 0 && top.weight / totalWeight >= threshold) {
    return {
      ...base,
      conclusion: top.stance,
      // The margin reports voters, not weight, so it reads the same as majority
      // (the weight split stays visible in `reason`).
      margin: { winner: top.stance, winnerCount: voterGroups.get(top.stance)!.length, total: positions.length },
      reason: `${exclusion}weighted: "${top.stance}" ${top.weight}/${totalWeight} >= threshold ${threshold}`,
    };
  }
  return { ...base, reason: `${exclusion}weighted threshold ${threshold} not met or tied for "${top.stance}" (${top.weight}/${totalWeight})` };
}

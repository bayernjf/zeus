import type { Task } from '../a2a/types.js';
import type { AggregatedDecision, AggregationRule, BranchOutcome, Position } from './types.js';

const STANCE_KEYS = ['stance', 'verdict'] as const;

/** Pull a vassal's stance out of its terminal task's data parts, if it gave one. */
export function extractStance(task: Task): { stance: string; rationale?: string; weight?: number } | null {
  for (const artifact of task.artifacts) {
    for (const part of artifact.parts) {
      if (part.kind !== 'data') continue;
      const data = part.data as Record<string, unknown>;
      const stance = STANCE_KEYS.map(key => data[key]).find(value => typeof value === 'string' && value.trim() !== '');
      if (typeof stance === 'string') {
        return {
          stance,
          ...(typeof data.rationale === 'string' ? { rationale: data.rationale } : {}),
          ...(typeof data.weight === 'number' ? { weight: data.weight } : {}),
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
      return { ...base, conclusion: distinct[0], reason: `unanimous: all ${positions.length} vassal(s) hold "${distinct[0]}"` };
    }
    return { ...base, reason: `not unanimous: ${distinct.length} distinct stances among ${positions.length} vassal(s)` };
  }

  if (rule.kind === 'majority') {
    const tally = distinct.map(stance => ({ stance, count: groups.get(stance)!.length }));
    tally.sort((a, b) => b.count - a.count || a.stance.localeCompare(b.stance));
    const top = tally[0];
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
  const totalWeight = positions.reduce((sum, p) => sum + (p.weight ?? 1), 0);
  const tally = distinct.map(stance => ({
    stance,
    weight: groups.get(stance)!.reduce((sum, p) => sum + (p.weight ?? 1), 0),
  }));
  tally.sort((a, b) => b.weight - a.weight || a.stance.localeCompare(b.stance));
  const top = tally[0];
  const tied = tally.filter(item => item.weight === top.weight);
  if (tied.length === 1 && totalWeight > 0 && top.weight / totalWeight >= threshold) {
    return {
      ...base,
      conclusion: top.stance,
      margin: { winner: top.stance, winnerCount: top.weight, total: totalWeight },
      reason: `weighted: "${top.stance}" ${top.weight}/${totalWeight} >= threshold ${threshold}`,
    };
  }
  return { ...base, reason: `weighted threshold ${threshold} not met or tied for "${top.stance}" (${top.weight}/${totalWeight})` };
}

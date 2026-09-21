import type { AggregatedDecision, Conflict, Position } from './types.js';

/**
 * Detect an unresolved split: more than one stance AND the aggregation rule
 * could not produce a conclusion. A rule that already decided (majority /
 * weighted / unanimous) is not a conflict the driver must settle.
 *
 * Returns at most one conflict describing the whole split — the driver decides
 * the intent once, not per pair of vassals.
 */
export function detectConflicts(positions: Position[], decision: AggregatedDecision): Conflict[] {
  if (decision.conclusion !== null) return [];

  const byStance = new Map<string, string[]>();
  for (const position of positions) {
    const vassals = byStance.get(position.stance) ?? [];
    vassals.push(position.vassal);
    byStance.set(position.stance, vassals);
  }
  if (byStance.size < 2) return [];

  const stances = [...byStance.entries()]
    .map(([stance, vassals]) => ({ stance, vassals }))
    .sort((a, b) => a.stance.localeCompare(b.stance));

  return [
    {
      stances,
      reason: `unresolved split across ${stances.length} stances (${decision.rule} could not conclude): ${decision.reason}`,
    },
  ];
}

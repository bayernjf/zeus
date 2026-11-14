import type { AggregatedDecision, Conflict, Position } from './types.js';

/**
 * Detect an unresolved split: more than one stance AND the aggregation rule
 * could not produce a conclusion. A rule that already decided (majority /
 * weighted / unanimous) is not a conflict the operator must settle.
 *
 * Returns at most one conflict describing the whole split — the operator decides
 * the intent once, not per pair of executors.
 */
export function detectConflicts(positions: Position[], decision: AggregatedDecision): Conflict[] {
  if (decision.conclusion !== null) return [];

  const byStance = new Map<string, string[]>();
  for (const position of positions) {
    const executors = byStance.get(position.stance) ?? [];
    executors.push(position.executor);
    byStance.set(position.stance, executors);
  }
  if (byStance.size < 2) return [];

  const stances = [...byStance.entries()]
    .map(([stance, executors]) => ({ stance, executors }))
    .sort((a, b) => a.stance.localeCompare(b.stance));

  return [
    {
      stances,
      reason: `unresolved split across ${stances.length} stances (${decision.rule} could not conclude): ${decision.reason}`,
    },
  ];
}

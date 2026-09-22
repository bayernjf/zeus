import type { BranchOutcome, SourcedEvent } from './types.js';

/**
 * Merge branch event streams into one driver-facing view.
 *
 * Ordering: events keep their in-branch SSE order; branches are concatenated
 * in selection order. We deliberately do NOT sort by event timestamp — vassal
 * clocks are untrusted and timestamps are optional. A presentation layer with a
 * trusted clock may re-order later without losing the source tag.
 */
export function mergeBranches(branches: BranchOutcome[]): SourcedEvent[] {
  const merged: SourcedEvent[] = [];
  for (const branch of branches) {
    for (const event of branch.events) {
      merged.push({
        source: { vassal: branch.vassal, taskId: branch.taskId, runId: branch.runId },
        event,
      });
    }
  }
  return merged;
}

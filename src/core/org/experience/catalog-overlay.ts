/**
 * Catalog overlay (F4.2 review stage).
 *
 * The static catalog stays the single source of executable steps. Promoted
 * candidates are attached as advisories at read time — the catalog itself is
 * never rewritten, so an unpromoted candidate cannot influence anything and a
 * promoted one is visible without inventing a tool step.
 */
import { SOP_CATALOG } from '../sop/catalog.js';
import type { ExperienceCandidate, PositionSopView, SopAdvisory } from './types.js';

export function advisoryOf(candidate: ExperienceCandidate): SopAdvisory | undefined {
  if (candidate.status !== 'promoted' || !candidate.skillId || !candidate.promotedAt) return undefined;
  return {
    id: `adv-${candidate.id}`,
    candidateId: candidate.id,
    skillId: candidate.skillId,
    summary: candidate.title,
    detail: candidate.detail,
    promotedAt: candidate.promotedAt,
  };
}

/**
 * Catalog view with advisories merged in. `candidates` may be the whole store
 * listing; only promoted entries with a skillId are considered.
 */
export function catalogWithAdvisories(
  candidates: readonly ExperienceCandidate[],
  skillId?: string,
): PositionSopView[] {
  const advisories = candidates
    .map(advisoryOf)
    .filter((a): a is SopAdvisory => a !== undefined);

  return SOP_CATALOG.filter(sop => skillId === undefined || sop.skillId === skillId).map(sop => ({
    skillId: sop.skillId,
    workflow: sop.workflow,
    template: sop.template,
    steps: sop.steps,
    advisories: advisories.filter(a => a.skillId === sop.skillId),
  }));
}

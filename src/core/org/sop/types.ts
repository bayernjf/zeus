/**
 * Tier0 M7 (T-M7-03) — structured, code-assertable position SOP / skill catalog.
 *
 * A position declares `requiredSkills`; each canonical skill id maps to an
 * explicit standard operating procedure: the exact channel tool surface the
 * position must be granted, an ordered list of steps (tool, required decision
 * grade, human checkpoint flag, expected outputs/evidence), and the minimum
 * decision scope a bound agent needs to run it autonomously.
 *
 * This is data, not prose: tests assert its invariants (every referenced tool
 * is a known channel tool, checkpoint grades match the workflow's external
 * grading, steps are ordered and acyclic), and the dispatch-time validator
 * rejects tasks whose skill/workflow has no SOP or whose position cannot cover
 * the SOP.
 */
import type { Grade } from '../../types.js';

/** One ordered step of an SOP. */
export interface SopStep {
  /** Stable step id, e.g. `listing.human-publish`. */
  id: string;
  /** 0-based execution order; steps must be strictly increasing (acyclic). */
  order: number;
  /**
   * Channel tool the step invokes. Human-checkpoint steps name the gated
   * channel action the checkpoint covers (e.g. `agent-world:resume-run` after
   * a D3 publish decision) — the checkpoint itself is a `ctx.requestDecision`,
   * not a channel tool.
   */
  tool: string;
  /** Decision grade required to perform this step. */
  requiredGrade: Grade;
  /**
   * True when the step is gated behind a human decision checkpoint: a bound
   * agent may not perform it autonomously; the approved decision record is the
   * coverage that unlocks it on resume.
   */
  humanCheckpoint: boolean;
  /** Expected outputs / evidence the step must leave behind. */
  outputs: string[];
}

/** The standard operating procedure bound to one canonical job-family skill. */
export interface PositionSop {
  /** Canonical skill id (matches `Position.requiredSkills`). */
  skillId: string;
  /** Agent-world workflow this SOP drives (content | listing | after-sales). */
  workflow: string;
  /** Channel template the workflow instantiates. */
  template: string;
  /** Every channel tool the position must be granted to run this SOP. */
  requiredTools: string[];
  /**
   * Highest grade among non-checkpoint steps. `position.decisionScope` must be
   * at least this; checkpoint steps do not raise it — they are covered by the
   * approved decision instead.
   */
  minimumScope: Grade;
  steps: SopStep[];
}

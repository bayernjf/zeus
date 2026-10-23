/**
 * Tier0 M7 (T-M7-03) — grade-scope authority guard.
 *
 * Layered on top of the tool allow-list (tool-guard): a granted tool may still
 * carry a decision grade (SOP catalog / per-call contextual raise). A bound
 * position may perform the call autonomously only when its `decisionScope`
 * reaches the required grade, or the run is covered by an approved decision of
 * at least that grade (the resume after a D2/D3 checkpoint approval). Otherwise
 * this guard fails closed — never silently downgrades or proceeds.
 *
 * Same settlement as ToolDeniedError: the runner maps both to
 * failed/tool_denied, never retried.
 */
import type { Grade } from '../../types.js';
import { gradeAtLeast, maxGrade } from '../sop/catalog.js';
import { ToolDeniedError } from './errors.js';

/**
 * A granted tool call required a higher decision grade than the position's
 * autonomous scope provides, and no approved decision of that grade covers
 * the run. Subclass of ToolDeniedError so the hardened runner settles it as
 * failed/tool_denied (fail-closed, never retried) with no second permission
 * model.
 */
export class GradeDeniedError extends ToolDeniedError {
  readonly requiredGrade: Grade;
  readonly positionScope: Grade;
  readonly approvedCeil: Grade;

  constructor(
    tool: string,
    requiredGrade: Grade,
    positionScope: Grade,
    approvedCeil: Grade,
    grantedTools: readonly string[],
  ) {
    super(tool, grantedTools);
    this.name = 'GradeDeniedError';
    this.requiredGrade = requiredGrade;
    this.positionScope = positionScope;
    this.approvedCeil = approvedCeil;
    this.message =
      `tool "${tool}" requires decision grade ${requiredGrade}; ` +
      `position scope is ${positionScope} and approved-decision coverage is ${approvedCeil} ` +
      `(max scope ${maxGrade(positionScope, approvedCeil)} < ${requiredGrade}); ` +
      `the action must go through a requestDecision checkpoint and be approved`;
  }
}

/**
 * Assert the call's required grade is reachable from the position's scope or
 * this run's approved-decision coverage. Throws GradeDeniedError (fail-closed).
 */
export function assertGradeScope(
  tool: string,
  requiredGrade: Grade,
  positionScope: Grade,
  approvedCeil: Grade,
  grantedTools: readonly string[],
): void {
  if (gradeAtLeast(maxGrade(positionScope, approvedCeil), requiredGrade)) return;
  throw new GradeDeniedError(tool, requiredGrade, positionScope, approvedCeil, grantedTools);
}

/** Highest grade reached by either source (position scope or approved coverage). */
export function coverageCeil(positionScope: Grade, approvedCeil: Grade): Grade {
  return maxGrade(positionScope, approvedCeil);
}

/**
 * Tier0 M7 (T-M7-03) — the SOP/skill catalog data and its lookup helpers.
 *
 * Exactly three SOPs, aligned with the three agent-world workflows
 * (content / listing / after-sales) and the executor's WORKFLOW_CHECKPOINT
 * grading: content is fully automatic (D0), listing publishes externally
 * (D3 human checkpoint), after-sales handles complex tickets (D2 checkpoint).
 *
 * Also owns the tool → required-grade map the grade-guard enforces:
 *   - a tool's static default grade (unknown/granted-but-unmapped tools are
 *     treated as D0 — the position allow-list is the real gate; this map only
 *     encodes channel actions that carry an external decision grade);
 *   - a per-call contextual raise (`args.__requiredGrade`): the executor may
 *     declare a HIGHER grade when the action is contextually more dangerous
 *     (resume-run approving a D3 publish). The effective grade is always the
 *     max — args can only raise, never lower.
 */
import type { Grade } from '../../types.js';
import { AGENT_WORLD_TOOLS } from '../adapters/agent-world/tools.js';
import type { Position } from '../types.js';
import type { PositionSop, SopStep } from './types.js';

/** Canonical job-family skill ids bound by positions. */
export const SKILL_IDS = {
  contentProduction: 'content-production',
  listingPublish: 'listing-publish',
  afterSalesSupport: 'after-sales-support',
} as const;

/** Grade order: D0 < D1 < D2 < D3. */
const GRADE_ORDER: readonly Grade[] = ['D0', 'D1', 'D2', 'D3'];

export function gradeAtLeast(grade: Grade, min: Grade): boolean {
  return GRADE_ORDER.indexOf(grade) >= GRADE_ORDER.indexOf(min);
}

export function maxGrade(a: Grade, b: Grade): Grade {
  return GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b;
}

const AW = AGENT_WORLD_TOOLS;

/** Exactly three SOPs: one per agent-world job family. */
export const SOP_CATALOG: readonly PositionSop[] = [
  {
    skillId: SKILL_IDS.contentProduction,
    workflow: 'content',
    template: 'tpl-xiaohongshu',
    requiredTools: [AW.runGraph, AW.getRun],
    minimumScope: 'D0',
    steps: [
      {
        id: 'content.start-run',
        order: 0,
        tool: AW.runGraph,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['graphId', 'runId', 'replay'],
      },
      {
        id: 'content.poll-run',
        order: 1,
        tool: AW.getRun,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['run timeline'],
      },
      {
        id: 'content.collect-artifacts',
        order: 2,
        tool: AW.getRun,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['artifacts summary'],
      },
    ],
  },
  {
    skillId: SKILL_IDS.listingPublish,
    workflow: 'listing',
    template: 'tpl-review-publish',
    requiredTools: [AW.runGraph, AW.resumeRun, AW.getRun],
    // Non-checkpoint steps are all D0: the external publish is the gated
    // checkpoint itself (D3), covered by an approved D3 decision on resume.
    minimumScope: 'D0',
    steps: [
      {
        id: 'listing.start-run',
        order: 0,
        tool: AW.runGraph,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['graphId', 'runId'],
      },
      {
        id: 'listing.poll-run',
        order: 1,
        tool: AW.getRun,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['run timeline until human halt'],
      },
      {
        id: 'listing.human-publish',
        order: 2,
        tool: AW.resumeRun,
        requiredGrade: 'D3',
        humanCheckpoint: true,
        outputs: ['approved D3 decision record', 'resume acknowledged (publish)'],
      },
      {
        id: 'listing.collect-artifacts',
        order: 3,
        tool: AW.getRun,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['artifacts summary'],
      },
    ],
  },
  {
    skillId: SKILL_IDS.afterSalesSupport,
    workflow: 'after-sales',
    template: 'tpl-customer-service',
    requiredTools: [AW.runGraph, AW.resumeRun, AW.getRun],
    minimumScope: 'D0',
    steps: [
      {
        id: 'after-sales.start-run',
        order: 0,
        tool: AW.runGraph,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['graphId', 'runId'],
      },
      {
        id: 'after-sales.poll-run',
        order: 1,
        tool: AW.getRun,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['run timeline until human halt'],
      },
      {
        id: 'after-sales.human-ticket',
        order: 2,
        tool: AW.resumeRun,
        requiredGrade: 'D2',
        humanCheckpoint: true,
        outputs: ['approved D2 decision record', 'resume acknowledged'],
      },
      {
        id: 'after-sales.collect-artifacts',
        order: 3,
        tool: AW.getRun,
        requiredGrade: 'D0',
        humanCheckpoint: false,
        outputs: ['artifacts summary'],
      },
    ],
  },
];

/**
 * Static default grade per channel tool. resume-run is mutating (org/hard,
 * D2); the contextually dangerous raise (D3 publish) comes per call.
 * Unmapped tools default to D0: the allow-list already gates them, and only
 * catalog-graded channel actions carry an external decision grade.
 */
export const TOOL_DEFAULT_GRADE: Record<string, Grade> = {
  [AW.runGraph]: 'D0',
  [AW.getRun]: 'D0',
  [AW.resumeRun]: 'D2',
};

/** Arg key an executor may set to raise the effective grade of one tool call. */
export const GRADE_RAISE_ARG = '__requiredGrade';

function isGrade(v: unknown): v is Grade {
  return v === 'D0' || v === 'D1' || v === 'D2' || v === 'D3';
}

/**
 * Effective required grade for a tool call: max(static default, contextual
 * raise). The raise can only increase the requirement — never silently
 * downgrade.
 */
export function requiredGradeForTool(tool: string, args: Record<string, unknown>): Grade {
  const base = TOOL_DEFAULT_GRADE[tool] ?? ('D0' as Grade);
  const raise = args[GRADE_RAISE_ARG];
  return isGrade(raise) ? maxGrade(base, raise) : base;
}

/** SOP by canonical skill id; undefined when the skill is not catalogued. */
export function sopBySkill(skillId: string | undefined): PositionSop | undefined {
  if (!skillId) return undefined;
  return SOP_CATALOG.find(s => s.skillId === skillId);
}

/** SOP by agent-world workflow name; undefined when not catalogued. */
export function sopByWorkflow(workflow: string | undefined): PositionSop | undefined {
  if (!workflow) return undefined;
  return SOP_CATALOG.find(s => s.workflow === workflow);
}

/** All channel tools referenced anywhere in the catalog (known-tool invariant). */
export function catalogTools(): string[] {
  const set = new Set<string>();
  for (const sop of SOP_CATALOG) {
    for (const tool of sop.requiredTools) set.add(tool);
    for (const step of sop.steps) set.add(step.tool);
  }
  return [...set].sort();
}

export interface PositionSopFit {
  missingTools: string[];
  /** The SOP's minimumScope when the position scope is below it, else null. */
  scopeGap: Grade | null;
  ok: boolean;
}

/**
 * Pre-dispatch compatibility check: does the position grant every tool the SOP
 * requires, and is its autonomous scope at least the SOP's minimum?
 */
export function fitPositionToSop(position: Pick<Position, 'allowedTools' | 'decisionScope'>, sop: PositionSop): PositionSopFit {
  const missingTools = sop.requiredTools.filter(t => !position.allowedTools.includes(t));
  const scopeGap = gradeAtLeast(position.decisionScope, sop.minimumScope) ? null : sop.minimumScope;
  return { missingTools, scopeGap, ok: missingTools.length === 0 && scopeGap === null };
}

export type { SopStep };

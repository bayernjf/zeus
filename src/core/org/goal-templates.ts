/**
 * F5.3 code-owned goal templates. A goal references one of these by id; the
 * scheduler expands it into one org task per step for the current UTC window.
 *
 * The catalog is deliberately small and versionless for the self-use slice.
 * Validation is data-driven: every step id is unique, and `dependsOn` may only
 * name a step that appears earlier in the ordered list, which keeps the
 * expansion acyclic and lets the scheduler resolve task ids without a
 * graph pass.
 */
import type { Json, OrgGoal, OrgGoalTemplate } from './types.js';

export const GOAL_TEMPLATES: readonly OrgGoalTemplate[] = [
  {
    id: 'weekly-report',
    title: '周报流水线',
    description: '采集数据 → 汇总 → 人工复核',
    steps: [
      {
        id: 'collect',
        title: '采集周报数据',
        payload: { template: 'weekly-report', phase: 'collect' },
      },
      {
        id: 'summarize',
        title: '汇总周报',
        payload: { template: 'weekly-report', phase: 'summarize' },
        dependsOn: ['collect'],
      },
      {
        id: 'human-review',
        title: '人工复核周报',
        payload: { template: 'weekly-report', phase: 'human-review' },
        dependsOn: ['summarize'],
      },
    ],
  },
  {
    id: 'content-review',
    title: '内容生产与人审',
    description: '生成内容草稿 → 人工审核',
    steps: [
      {
        id: 'draft',
        title: '生成内容草稿',
        requiredSkill: 'content-production',
        payload: { template: 'content-review', phase: 'draft' },
      },
      {
        id: 'review',
        title: '人工审核内容',
        payload: { template: 'content-review', phase: 'review' },
        dependsOn: ['draft'],
      },
    ],
  },
];

/** One task-producing step after a goal template (or single-task template) is expanded. */
export interface ExpandedGoalStep {
  /** Template step id; absent for the F5.2 single-task path. */
  stepId?: string;
  title: string;
  payload?: Json;
  requiredSkill?: string;
  positionId?: string;
  /** Earlier template step ids this step waits for. */
  dependsOn: string[];
}

/** Look up a built-in template by its stable id. */
export function goalTemplateById(id: string): OrgGoalTemplate | undefined {
  return GOAL_TEMPLATES.find(template => template.id === id);
}

/** Return the catalog as plain data for the read-only HTTP face. */
export function listGoalTemplates(): OrgGoalTemplate[] {
  return GOAL_TEMPLATES.map(template => structuredClone(template));
}

/**
 * Validate one template definition. The catalog is code, but keeping the
 * invariants executable prevents a future edit from silently producing an
 * expansion that cannot resolve its dependencies.
 */
export function validateGoalTemplate(template: OrgGoalTemplate): string[] {
  const errors: string[] = [];
  if (!template.id.trim()) errors.push('template id is empty');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(template.id)) {
    errors.push(`template id must be lowercase kebab-case: ${template.id}`);
  }
  if (!template.title.trim()) errors.push(`template ${template.id} has an empty title`);
  if (template.steps.length === 0) errors.push(`template ${template.id} has no steps`);

  const seen = new Set<string>();
  for (const [index, step] of template.steps.entries()) {
    if (!step.id.trim()) {
      errors.push(`template ${template.id} step ${index} has an empty id`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(step.id)) {
      errors.push(`template ${template.id} step id must be lowercase kebab-case: ${step.id}`);
    }
    if (seen.has(step.id)) {
      errors.push(`template ${template.id} has duplicate step id: ${step.id}`);
      continue;
    }
    for (const dependency of step.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        errors.push(
          `template ${template.id} step ${step.id} depends on ${dependency}, which is not an earlier step`,
        );
      }
    }
    seen.add(step.id);
  }
  return errors;
}

/**
 * Expand a goal into ordered task-producing steps. The F5.2 single
 * `taskTemplate` keeps its legacy shape and idempotency key (no step suffix);
 * `templateRef` produces one step per built-in template entry.
 */
export function expandGoalSteps(goal: OrgGoal): ExpandedGoalStep[] {
  if (goal.templateRef !== undefined) {
    const template = goalTemplateById(goal.templateRef);
    if (!template) throw new Error(`unknown goal template: ${goal.templateRef}`);
    return template.steps.map(step => ({
      stepId: step.id,
      title: step.title ?? template.title,
      ...(step.payload !== undefined ? { payload: step.payload } : {}),
      ...(step.requiredSkill ? { requiredSkill: step.requiredSkill } : {}),
      ...(step.positionId ? { positionId: step.positionId } : {}),
      dependsOn: [...(step.dependsOn ?? [])],
    }));
  }

  const template = goal.taskTemplate;
  return [
    {
      title: template?.title ?? goal.title,
      ...(template?.payload !== undefined ? { payload: template.payload } : {}),
      ...(template?.requiredSkill ? { requiredSkill: template.requiredSkill } : {}),
      ...(template?.positionId ? { positionId: template.positionId } : {}),
      dependsOn: [],
    },
  ];
}

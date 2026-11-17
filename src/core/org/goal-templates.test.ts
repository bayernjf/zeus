/**
 * F5.3 built-in goal template catalog: executable invariants (unique step ids,
 * dependencies only name earlier steps) and deterministic expansion into
 * ordered task-producing steps. Pure functions, no store.
 */
import { describe, expect, it } from 'vitest';
import {
  GOAL_TEMPLATES,
  expandGoalSteps,
  goalTemplateById,
  listGoalTemplates,
  validateGoalTemplate,
} from './goal-templates.js';
import type { OrgGoal } from './types.js';

function goal(overrides: Partial<OrgGoal>): OrgGoal {
  return {
    format: 'zeus-org-goal',
    version: 1,
    id: 'goal-1',
    organizationId: 'org-1',
    title: '周报',
    period: 'weekly',
    status: 'active',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('goal template catalog (F5.3)', () => {
  it('ships valid, uniquely identifiable templates', () => {
    expect(GOAL_TEMPLATES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const template of GOAL_TEMPLATES) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      expect(validateGoalTemplate(template)).toEqual([]);
    }
    expect(goalTemplateById('weekly-report')?.steps.map(step => step.id)).toEqual([
      'collect',
      'summarize',
      'human-review',
    ]);
    expect(listGoalTemplates()).toEqual(GOAL_TEMPLATES);
  });

  it('rejects duplicate step ids, forward dependencies and empty templates', () => {
    expect(
      validateGoalTemplate({
        id: 'broken',
        title: '坏的',
        steps: [
          { id: 'a' },
          { id: 'b', dependsOn: ['c'] },
          { id: 'a' },
          { id: 'c' },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        'template broken has duplicate step id: a',
        'template broken step b depends on c, which is not an earlier step',
      ]),
    );
    expect(validateGoalTemplate({ id: 'empty', title: '空', steps: [] })).toEqual([
      'template empty has no steps',
    ]);
  });

  it('expands a templateRef goal into ordered steps with field-faithful content', () => {
    const steps = expandGoalSteps(goal({ templateRef: 'weekly-report' }));
    expect(steps).toEqual([
      {
        stepId: 'collect',
        title: '采集周报数据',
        payload: { template: 'weekly-report', phase: 'collect' },
        dependsOn: [],
      },
      {
        stepId: 'summarize',
        title: '汇总周报',
        payload: { template: 'weekly-report', phase: 'summarize' },
        dependsOn: ['collect'],
      },
      {
        stepId: 'human-review',
        title: '人工复核周报',
        payload: { template: 'weekly-report', phase: 'human-review' },
        dependsOn: ['summarize'],
      },
    ]);
    // Finding by id is live data, not a cached expansion.
    expect(goalTemplateById('weekly-report')?.title).toBe('周报流水线');
  });

  it('keeps the F5.2 single-task template as one unsuffixed step', () => {
    const steps = expandGoalSteps(
      goal({
        taskTemplate: {
          title: '巡检',
          payload: { kind: 'inventory-check' },
          requiredSkill: 'ops',
          positionId: 'pos-1',
        },
      }),
    );
    expect(steps).toEqual([
      {
        title: '巡检',
        payload: { kind: 'inventory-check' },
        requiredSkill: 'ops',
        positionId: 'pos-1',
        dependsOn: [],
      },
    ]);
  });

  it('throws on an unknown templateRef instead of silently falling back', () => {
    expect(() => expandGoalSteps(goal({ templateRef: 'missing' }))).toThrow(
      'unknown goal template: missing',
    );
  });
});

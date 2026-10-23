/**
 * T-M7-03: the SOP/skill catalog is asserted as data, not prose.
 *
 * Invariants pinned here: exactly three SOPs (content / listing / after-sales);
 * every tool an SOP references is a known agent-world tool; the human-checkpoint
 * grades match the executor's WORKFLOW_CHECKPOINT (content D0, listing D3,
 * after-sales D2); steps are strictly ordered and acyclic; minimumScope only
 * ever reflects non-checkpoint steps; lookup helpers resolve by skill/workflow.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_WORLD_TOOLS } from '../adapters/agent-world/tools.js';
import {
  GRADE_RAISE_ARG,
  SOP_CATALOG,
  SKILL_IDS,
  TOOL_DEFAULT_GRADE,
  catalogTools,
  fitPositionToSop,
  gradeAtLeast,
  requiredGradeForTool,
  sopBySkill,
  sopByWorkflow,
} from './index.js';

const KNOWN_TOOLS = new Set<string>(Object.values(AGENT_WORLD_TOOLS));

describe('SOP catalog shape', () => {
  it('exposes exactly the three job-family SOPs', () => {
    expect(SOP_CATALOG.map(s => s.skillId).sort()).toEqual([
      SKILL_IDS.afterSalesSupport,
      SKILL_IDS.contentProduction,
      SKILL_IDS.listingPublish,
    ]);
    expect(SOP_CATALOG.map(s => s.workflow).sort()).toEqual(['after-sales', 'content', 'listing']);
  });

  it('maps each workflow to its agent-world template', () => {
    expect(Object.fromEntries(SOP_CATALOG.map(s => [s.workflow, s.template]))).toEqual({
      content: 'tpl-xiaohongshu',
      listing: 'tpl-review-publish',
      'after-sales': 'tpl-customer-service',
    });
  });

  it('every tool referenced by any SOP is a known channel tool', () => {
    for (const tool of catalogTools()) {
      expect(KNOWN_TOOLS.has(tool), `unknown tool in catalog: ${tool}`).toBe(true);
    }
  });

  it('every requiredTool appears among the SOP steps', () => {
    for (const sop of SOP_CATALOG) {
      const stepTools = new Set(sop.steps.map(s => s.tool));
      for (const tool of sop.requiredTools) {
        expect(stepTools.has(tool), `${sop.skillId} requires ${tool} but no step invokes it`).toBe(true);
      }
    }
  });

  it('steps are strictly ordered (acyclic sequence)', () => {
    for (const sop of SOP_CATALOG) {
      const orders = sop.steps.map(s => s.order);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
      expect(new Set(orders).size).toBe(orders.length);
      expect(orders[0]).toBe(0);
    }
  });

  it('checkpoint grades match the workflow grading (content D0 / listing D3 / after-sales D2)', () => {
    const checkpoints = Object.fromEntries(
      SOP_CATALOG.map(s => [s.workflow, s.steps.filter(step => step.humanCheckpoint).map(step => step.requiredGrade)]),
    );
    // content has no human checkpoint (fully automatic); the other two have
    // exactly one, graded D3 (external/irreversible) and D2 (org/hard).
    expect(checkpoints.content).toEqual([]);
    expect(checkpoints.listing).toEqual(['D3']);
    expect(checkpoints['after-sales']).toEqual(['D2']);
  });

  it('minimumScope is the max grade of non-checkpoint steps only', () => {
    for (const sop of SOP_CATALOG) {
      const nonCheck = sop.steps.filter(s => !s.humanCheckpoint).map(s => s.requiredGrade);
      const expected = nonCheck.reduce(
        (acc, g) => (gradeAtLeast(g, acc) ? g : acc),
        'D0' as const,
      );
      expect(sop.minimumScope, sop.skillId).toBe(expected);
    }
    // listing/after-sales: the D3/D2 gated step is a checkpoint, so the SOP
    // stays dispatchable to a D2 position (it halts, the human covers the grade).
    const listing = sopByWorkflow('listing')!;
    expect(listing.minimumScope).toBe('D0');
  });

  it('lookup helpers resolve by skill and by workflow and miss unknown values', () => {
    expect(sopBySkill(SKILL_IDS.listingPublish)?.workflow).toBe('listing');
    expect(sopByWorkflow('content')?.skillId).toBe(SKILL_IDS.contentProduction);
    expect(sopBySkill('no-such-skill')).toBeUndefined();
    expect(sopByWorkflow('no-such-workflow')).toBeUndefined();
    expect(sopBySkill(undefined)).toBeUndefined();
  });
});

describe('tool → required-grade resolution', () => {
  it('static defaults: read/start D0, resume-run D2', () => {
    expect(TOOL_DEFAULT_GRADE[AGENT_WORLD_TOOLS.runGraph]).toBe('D0');
    expect(TOOL_DEFAULT_GRADE[AGENT_WORLD_TOOLS.getRun]).toBe('D0');
    expect(TOOL_DEFAULT_GRADE[AGENT_WORLD_TOOLS.resumeRun]).toBe('D2');
  });

  it('contextual raise can only increase the required grade, never lower it', () => {
    // resume-run defaults D2; a listing publish raises it to D3.
    expect(requiredGradeForTool(AGENT_WORLD_TOOLS.resumeRun, { [GRADE_RAISE_ARG]: 'D3' })).toBe('D3');
    // A bogus/lower raise is ignored — the default still applies.
    expect(requiredGradeForTool(AGENT_WORLD_TOOLS.resumeRun, { [GRADE_RAISE_ARG]: 'D0' })).toBe('D2');
    // Unknown tools default to D0 (allow-list is the real gate).
    expect(requiredGradeForTool('some:granted-tool', {})).toBe('D0');
    expect(requiredGradeForTool('some:granted-tool', { [GRADE_RAISE_ARG]: 'D3' })).toBe('D3');
  });
});

describe('position ↔ SOP fit', () => {
  const listing = sopByWorkflow('listing')!;

  it('accepts a position granted the full tool surface at any scope ≥ minimum', () => {
    const fit = fitPositionToSop(
      { allowedTools: [AGENT_WORLD_TOOLS.runGraph, AGENT_WORLD_TOOLS.resumeRun, AGENT_WORLD_TOOLS.getRun], decisionScope: 'D2' },
      listing,
    );
    expect(fit.ok).toBe(true);
    expect(fit.missingTools).toEqual([]);
    expect(fit.scopeGap).toBeNull();
  });

  it('reports missing grants and scope gaps together (all errors collected)', () => {
    const fit = fitPositionToSop(
      { allowedTools: [AGENT_WORLD_TOOLS.runGraph], decisionScope: 'D0' },
      listing,
    );
    expect(fit.ok).toBe(false);
    expect(fit.missingTools.sort()).toEqual([AGENT_WORLD_TOOLS.getRun, AGENT_WORLD_TOOLS.resumeRun].sort());
    // minimumScope is D0, so a D0 position has no scope gap here.
    expect(fit.scopeGap).toBeNull();
  });
});

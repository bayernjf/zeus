// design-planning (tech map S12) V2: planning wired into the runtime as a
// fan-out. V1 shipped the pure functions (validatePlan / scorePlans /
// selectPlan / replanDelta); V2 closes the loop — recognise planner skills by
// their `planning` tag, fan out to every planner, parse each planner's
// structured DagSpec draft from the A2A data part (never free text), validate /
// score / select deterministically, escalate a close contest or an unplannable
// goal through the oversight desk, and hand the selected plan to the DAG
// runner for execution.
//
// Contract invariants (design-planning §2/§3, carried from V1):
//  - a plan is data, not a command: the selected plan still passes the
//    delegation gate per execute node at execution time;
//  - the planner draft is a *candidate*: parse failure is audited and the
//    candidate is dropped, never guessed into shape;
//  - escalation is reusable, not a new channel: plan-conflict and
//    plan-rejected-unplannable enter the existing intent-conflict desk rows
//    with a reason that names the planning face (design-planning §3.3).

import type { AuditEntry } from '../dispatch/dispatcher.js';
import type { RealmType } from '../a2a/types.js';
import type { Artifact, Part } from '../a2a/types.js';
import type { SkillSpec } from '../skills/types.js';
import type { Conflict } from './types.js';
import type { DagResult, DagRunner } from './dag-runner.js';
import type { DagSpec } from './dag.js';
import type { Escalation } from '../oversight/types.js';
import type { OversightDesk } from '../oversight/oversight.js';
import { scorePlans, selectPlan } from './planning.js';
import type { PlanGoal, PlanRanking, PlanScore } from './planning.js';
import type { Orchestrator } from './orchestrator.js';
import type { SkillRegistry } from '../skills/registry.js';

/** Tag that marks a skill as a planner (design-planning §4 protocol). */
export const PLANNER_TAG = 'planning';

/** Draft protocol (design-planning §4): the planner's structured DagSpec lives
 *  in a data part keyed `plan`; anything else is free text and not a draft. */
const PLAN_DATA_KEY = 'plan';

export type PlanFlowOptions = {
  orchestrator: Orchestrator;
  skillRegistry: SkillRegistry;
  /** When supplied, the selected plan is executed through the DAG runner. */
  dagRunner?: DagRunner;
  /** When supplied, plan-conflict / unplannable goals enter the desk (L1). */
  oversight?: OversightDesk;
  /** Audit spine for planning decisions; defaults to no-op. */
  audit?: (entry: AuditEntry) => void;
  /** Score lead required to select the top candidate over the runner-up
   *  (design-planning §3.3). Defaults to 0.1. */
  tieThreshold?: number;
  now?: () => Date;
  newIntentId?: () => string;
};

export type PlanFlowRequest = {
  goal: PlanGoal;
  realm: RealmType;
  realmId?: string;
  /** Planner skills to fan out to; defaults to every active skill tagged
   *  `planning` (design-planning §3.1). */
  plannerSkills?: string[];
  /** When true, a selected plan is returned instead of executed (the operator
   *  confirms first). Defaults to false — select-and-execute. */
  requireConfirmation?: boolean;
  /** Per-branch timeout for the planner fan-out. */
  branchTimeoutMs?: number;
};

export type PlanFlowResult =
  | { kind: 'selected'; planner: string; plan: DagSpec; scores: PlanScore[]; dag?: DagResult }
  | { kind: 'conflict'; escalated: Escalation; planners: string[]; scores: PlanScore[] }
  | { kind: 'unplannable'; escalated?: Escalation; reasons: string[]; plannerCount: number };

/** Planner fan-out: every planner skill is one intent, so a multi-planner
 *  batch stays idempotent per planner skill and its branches carry the drafts. */
export class PlanFlow {
  private readonly orchestrator: Orchestrator;
  private readonly skillRegistry: SkillRegistry;
  private readonly dagRunner: DagRunner | undefined;
  private readonly oversight: OversightDesk | undefined;
  private readonly audit: (entry: AuditEntry) => void;
  private readonly tieThreshold: number;
  private readonly now: () => Date;
  private readonly newIntentId: () => string;

  constructor(options: PlanFlowOptions) {
    this.orchestrator = options.orchestrator;
    this.skillRegistry = options.skillRegistry;
    this.dagRunner = options.dagRunner;
    this.oversight = options.oversight;
    this.audit = options.audit ?? (() => {});
    this.tieThreshold = options.tieThreshold ?? 0.1;
    this.now = options.now ?? (() => new Date());
    this.newIntentId = options.newIntentId ?? (() => `plan-${crypto.randomUUID()}`);
  }

  /** Run one planning cycle: fan out to the planner skills, score the drafts,
   *  select (or escalate), and execute when a plan wins and execution is not
   *  gated on operator confirmation. */
  async run(request: PlanFlowRequest): Promise<PlanFlowResult> {
    const plannerSkills = request.plannerSkills ?? this.resolvePlannerSkills();
    const intentId = this.newIntentId();

    const drafts: Array<{ planner: string; spec: DagSpec }> = [];
    for (const skill of plannerSkills) {
      const fanOut = await this.orchestrator.fanOut({
        intentId: `${intentId}:${skill}`,
        skill,
        params: {
          goal: request.goal,
          catalogue: this.catalogueSnapshot(),
        },
        realm: request.realm,
        ...(request.realmId ? { realmId: request.realmId } : {}),
        ...(request.branchTimeoutMs !== undefined ? { branchTimeoutMs: request.branchTimeoutMs } : {}),
      });
      for (const branch of fanOut.branches) {
        if (!branch.ok || branch.task === undefined) continue;
        const draft = extractPlanDraft(branch.task.artifacts);
        if (draft === undefined) {
          this.audit({
            ts: this.now().toISOString(),
            vassal: branch.vassal,
            runId: branch.runId,
            skill,
            realm: request.realm,
            decision: 'plan-malformed',
            detail: `planner ${branch.vassal} returned no structured plan draft (data part key '${PLAN_DATA_KEY}' expected)`,
          });
          continue;
        }
        drafts.push({ planner: branch.vassal, spec: draft });
      }
    }

    if (drafts.length === 0) {
      const reason =
        plannerSkills.length === 0
          ? 'no planner skill is active (none tagged `planning`)'
          : 'every planner draft was malformed or missing';
      this.audit({
        ts: this.now().toISOString(),
        vassal: '(planning)',
        runId: intentId,
        skill: plannerSkills.join(',') || '(none)',
        realm: request.realm,
        decision: 'plan-rejected-unplannable',
        detail: reason,
      });
      return {
        kind: 'unplannable',
        ...(this.oversight
          ? { escalated: this.escalateUnplannable(intentId, request, [reason]) }
          : {}),
        reasons: [reason],
        plannerCount: plannerSkills.length,
      };
    }

    const catalogue = this.catalogueSnapshot();
    const ranking = scorePlans(drafts, catalogue, request.goal);
    const verdict = selectPlan(ranking, this.tieThreshold);

    if (verdict.kind === 'unplannable') {
      const reasons = ranking.scores.flatMap((score) => score.rejects);
      this.audit({
        ts: this.now().toISOString(),
        vassal: '(planning)',
        runId: intentId,
        skill: plannerSkills.join(',') || '(none)',
        realm: request.realm,
        decision: 'plan-rejected-unplannable',
        detail: reasons.length > 0 ? reasons.join('; ') : 'no feasible plan candidate',
      });
      return {
        kind: 'unplannable',
        ...(this.oversight
          ? { escalated: this.escalateUnplannable(intentId, request, reasons) }
          : {}),
        reasons: reasons.length > 0 ? reasons : ['no feasible plan candidate'],
        plannerCount: drafts.length,
      };
    }

    if (verdict.kind === 'conflict') {
      this.audit({
        ts: this.now().toISOString(),
        vassal: '(planning)',
        runId: intentId,
        skill: plannerSkills.join(',') || '(none)',
        realm: request.realm,
        decision: 'plan-conflict',
        detail: `feasible plans within tie threshold: ${verdict.planners.join(', ')}`,
      });
      const escalated = this.oversight
        ? this.escalateConflict(intentId, request, verdict.planners, ranking)
        : { id: `esc-plan-${intentId}`, kind: 'intent-conflict' as const, runId: intentId, vassal: '(planning)', skill: request.goal.description.slice(0, 40), realm: request.realm, reason: 'plan-conflict', options: verdict.planners, status: 'pending' as const, createdAt: this.now().toISOString() };
      return { kind: 'conflict', escalated, planners: verdict.planners, scores: ranking.scores };
    }

    const selected = drafts.find((d) => d.planner === verdict.planner)!;
    this.audit({
      ts: this.now().toISOString(),
      vassal: '(planning)',
      runId: intentId,
      skill: plannerSkills.join(',') || '(none)',
      realm: request.realm,
      decision: 'plan-selected',
      detail: `planner ${verdict.planner}: ${selected.spec.nodes.length} nodes, coverage ${scoreOf(ranking, verdict.planner)?.coverage ?? '?'}`,
    });

    if (!request.requireConfirmation && this.dagRunner !== undefined) {
      const dag = await this.dagRunner.run(selected.spec);
      return { kind: 'selected', planner: verdict.planner, plan: selected.spec, scores: ranking.scores, dag };
    }
    return { kind: 'selected', planner: verdict.planner, plan: selected.spec, scores: ranking.scores };
  }

  /** Active planner skills (tagged `planning`), newest version per id. */
  private resolvePlannerSkills(): string[] {
    return this.skillRegistry.findByTag(PLANNER_TAG).map((spec) => spec.id);
  }

  /** Read-only catalogue snapshot handed to the planners and the scorer. */
  private catalogueSnapshot(): SkillSpec[] {
    return this.skillRegistry.list();
  }

  /** L1 escalation of a close plan contest (design-planning §3.3): reuse the
   *  intent-conflict desk row, with a reason naming the planning face. */
  private escalateConflict(
    intentId: string,
    request: PlanFlowRequest,
    planners: string[],
    ranking: PlanRanking,
  ): Escalation {
    const conflict: Conflict = {
      stances: planners.map((planner) => {
        const score = scoreOf(ranking, planner);
        return {
          stance: `plan by ${planner}`,
          ...(score === undefined
            ? {}
            : { summary: `coverage ${score.coverage}, cost ${score.estimatedCost}, critical path ${score.criticalPathLength}` }),
          vassals: [planner],
        };
      }),
      reason: `plan-conflict: feasible plans within tie threshold ${this.tieThreshold} (${planners.join(', ')})`,
    };
    return this.oversight!.ingestConflict({
      intentId,
      runId: intentId,
      skill: request.goal.description.slice(0, 60) || '(planning)',
      realm: request.realm,
      conflict,
    });
  }

  /** L1 escalation of an unplannable goal (design-planning §3.3): the desk row
   *  carries the reject reasons so the operator sees why nothing ran. */
  private escalateUnplannable(
    intentId: string,
    request: PlanFlowRequest,
    reasons: string[],
  ): Escalation {
    const conflict: Conflict = {
      stances: reasons.map((reason) => ({ stance: `rejected: ${reason}`, vassals: ['(planning)'] })),
      reason: `plan-rejected-unplannable: no feasible plan (${reasons.length} rejection(s))`,
    };
    return this.oversight!.ingestConflict({
      intentId,
      runId: intentId,
      skill: request.goal.description.slice(0, 60) || '(planning)',
      realm: request.realm,
      conflict,
    });
  }
}

/** Parse the planner's structured draft out of a task's artifacts: exactly one
 *  data part keyed `plan` whose value is a DagSpec-shaped object. Anything else
 *  (free text, wrong key, malformed shape) yields undefined — the caller audits
 *  and drops it. */
export function extractPlanDraft(artifacts: readonly Artifact[]): DagSpec | undefined {
  for (const artifact of artifacts) {
    for (const part of artifact.parts) {
      const draft = planFromPart(part);
      if (draft !== undefined) return draft;
    }
  }
  return undefined;
}

function planFromPart(part: Part): DagSpec | undefined {
  if (part.kind !== 'data') return undefined;
  const data = part.data as Record<string, unknown>;
  const raw = data[PLAN_DATA_KEY];
  if (raw === undefined || typeof raw !== 'object' || raw === null) return undefined;
  const spec = raw as Record<string, unknown>;
  if (!Array.isArray(spec.nodes)) return undefined;
  if (typeof spec.realm !== 'string') return undefined;
  const nodes = spec.nodes.filter(isDagNodeShape);
  if (nodes.length !== spec.nodes.length) return undefined;
  return {
    nodes,
    realm: spec.realm as RealmType,
    ...(typeof spec.dagId === 'string' ? { dagId: spec.dagId } : {}),
    ...(typeof spec.branchTimeoutMs === 'number' ? { branchTimeoutMs: spec.branchTimeoutMs } : {}),
  };
}

function isDagNodeShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  return typeof node.id === 'string' && typeof node.skill === 'string';
}

function scoreOf(ranking: PlanRanking, planner: string): PlanScore | undefined {
  return ranking.scores.find((score) => score.planner === planner);
}

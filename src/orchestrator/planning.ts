// design-planning (tech map S12): planning as a pure increment over the
// existing DAG kernel — validate, score and select plan candidates, and
// produce re-plan deltas that never touch completed or running nodes. V1 is
// the pure-function layer only (design-planning §5): no fan-out to planners,
// no planner prompt, no execution wiring — every input is caller-supplied.
//
// Contract invariants (design-planning §2/§3):
//  - a plan is data, not a command: it carries no execution authorization
//    (execute nodes still pass the delegation gate at execution time);
//  - re-planning moves only the not-yet-happened part: completed nodes are
//    frozen (kept, never re-run), running nodes are never cancelled by a
//    delta;
//  - validation is deterministic and rejects rather than guesses: an input
//    that cannot be satisfied is marked, never silently assumed.

import type { DagNode, DagNodeState, DagSpec } from './dag.js';
import { criticalPath, validateDag } from './dag.js';
import type { SkillSpec } from '../skills/types.js';

/** A planner's draft (design-planning §3.1): structured DagSpec candidates,
 *  never free text. `malformed` marks a draft that failed structured parsing. */
export type PlanCandidate = { planner: string; spec: DagSpec; malformed?: string };

/** The goal a plan must cover (design-planning §3.1). */
export type PlanGoal = { description: string; acceptanceCriteria?: string[] };

/** Deterministic score of one candidate (design-planning §3.2). */
export type PlanScore = {
  planner: string;
  feasible: boolean;
  /** Validation failure reasons (missing skill / unsatisfiable input / invalid
   *  graph). `feasible: false` iff rejects is non-empty. */
  rejects: string[];
  /** Goal coverage 0..1 — V1 keyword/tag matching over the goal description;
   *  semantic mapping is V4 via the decision backend. */
  coverage: number;
  criticalPathLength: number;
  /** Node count × unit cost — unit cost is 1 until S9 history calibration. */
  estimatedCost: number;
  /** Nodes with no alternate provider (design-planning §3.2 recoverability). */
  singlePoints: number;
};

export type PlanRanking = { scores: PlanScore[] };

/** Validate one candidate and score it (design-planning §3.2). Rejections are
 *  collected; a malformed candidate is infeasible with a parse rejection. */
export function validatePlan(p: PlanCandidate, catalogue: SkillSpec[], goal: PlanGoal): PlanScore {
  const rejects: string[] = [];

  if (p.malformed !== undefined) {
    rejects.push(`malformed draft: ${p.malformed}`);
  } else {
    let nodes: DagNode[] = [];
    try {
      nodes = validateDag(p.spec.nodes);
    } catch (err) {
      rejects.push(`graph invalid: ${(err as Error).message}`);
    }
    if (rejects.length === 0) {
      const byId = new Map(p.spec.nodes.map((n) => [n.id, n]));
      for (const node of nodes) {
        const specs = catalogue.filter((s) => s.id === node.skill);
        if (specs.length === 0) {
          rejects.push(`skill ${node.skill} not in catalogue`);
        } else {
          const spec = specs[0]!;
          const required = Object.keys(spec.inputs ?? {});
          for (const key of required) {
            // An input must be satisfiable from the node's own params or from
            // an upstream node's declared outputs (S1 V2 same rule — never
            // invent a value).
            const providedUpstream = (node.dependsOn ?? [])
              .map((dep) => byId.get(dep))
              .flatMap((dep) => (dep?.params ? Object.keys(dep.params) : []));
            if (node.params === undefined || !(key in node.params)) {
              if (!providedUpstream.includes(key)) {
                rejects.push(`node ${node.id}: input ${key} not satisfiable (not in params, not produced upstream)`);
              }
            }
          }
        }
      }
    }
  }

  const feasible = rejects.length === 0;
  const nodes = p.spec.nodes;
  const coverage = goalCoverage(goal.description, catalogue, nodes);
  const path = feasible ? criticalPath(nodes) : [];
  const criticalPathLength = path.length;
  const estimatedCost = nodes.length;
  const singlePoints = nodes.filter((n) => alternateProviderCount(n.skill, catalogue) === 0).length;

  return { planner: p.planner, feasible, rejects, coverage, criticalPathLength, estimatedCost, singlePoints };
}

/** Score and rank every candidate (design-planning §3.3): feasible first, then
 *  coverage desc, critical path asc, estimated cost asc, single points asc. */
export function scorePlans(candidates: readonly PlanCandidate[], catalogue: SkillSpec[], goal: PlanGoal): PlanRanking {
  const scores = candidates.map((c) => validatePlan(c, catalogue, goal));
  scores.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    if (a.criticalPathLength !== b.criticalPathLength) return a.criticalPathLength - b.criticalPathLength;
    if (a.estimatedCost !== b.estimatedCost) return a.estimatedCost - b.estimatedCost;
    return a.singlePoints - b.singlePoints;
  });
  return { scores };
}

/** Select the winning plan (design-planning §3.3): the top feasible candidate
 *  when its lead over the runner-up exceeds the tie threshold; a plan-conflict
 *  when two feasible candidates are close; unplannable when nothing is
 *  feasible (escalate instead of running a known-impossible plan). */
export function selectPlan(
  ranking: PlanRanking,
  tieThreshold: number,
): { kind: 'selected'; planner: string } | { kind: 'conflict'; planners: string[] } | { kind: 'unplannable' } {
  const feasible = ranking.scores.filter((s) => s.feasible);
  if (feasible.length === 0) return { kind: 'unplannable' };
  if (feasible.length === 1) return { kind: 'selected', planner: feasible[0]!.planner };
  const top = feasible[0]!;
  const runnerUp = feasible[1]!;
  if (top.coverage - runnerUp.coverage > tieThreshold) {
    return { kind: 'selected', planner: top.planner };
  }
  return { kind: 'conflict', planners: [top.planner, runnerUp.planner] };
}

/** The re-plan delta (design-planning §3.4): frozen completed nodes stay put,
 *  new nodes are added, dropped nodes are removed (unless they are completed
 *  or running — those are never touched), and dependency rewiring is reported
 *  for the execution driver to apply on pending nodes. */
export type ReplanDelta = {
  kept: string[];
  added: DagNode[];
  removed: string[];
  rewired: Array<{ id: string; deps: string[] }>;
};

/** Compute the delta between the current DAG execution and a revised spec.
 *  `currentNodes` is the id set of the currently-known graph, `depsOf` reads
 *  the current dependency edges, `statusOf` reads the per-node state. */
export function replanDelta(
  currentNodes: readonly string[],
  depsOf: (id: string) => string[],
  revised: DagSpec,
  statusOf: (id: string) => DagNodeState | undefined,
): ReplanDelta {
  const revisedIds = new Set(revised.nodes.map((n) => n.id));
  const kept: string[] = [];
  const added: DagNode[] = [];
  const removed: string[] = [];
  const rewired: Array<{ id: string; deps: string[] }> = [];

  for (const node of revised.nodes) {
    const state = statusOf(node.id);
    if (state === 'completed') {
      kept.push(node.id);
    } else if (!currentNodes.includes(node.id) && (state === undefined || state === 'pending')) {
      added.push(node);
    }
    if (currentNodes.includes(node.id) && state !== 'completed') {
      const current = depsOf(node.id);
      const revisedDeps = node.dependsOn ?? [];
      if (current.length !== revisedDeps.length || current.some((d, i) => d !== revisedDeps[i])) {
        rewired.push({ id: node.id, deps: revisedDeps });
      }
    }
  }

  for (const id of currentNodes) {
    if (!revisedIds.has(id)) {
      const state = statusOf(id);
      if (state !== 'completed' && state !== 'running') {
        removed.push(id);
      }
    }
  }

  return { kept, added, removed, rewired };
}

/** Goal coverage (V1 heuristic): the fraction of goal tokens matched by the
 *  catalogue entries of the plan's skills (name + tags + description). The
 *  keyword heuristic is deterministic and documented as V1; semantic mapping
 *  is V4 (design-planning §5). */
function goalCoverage(description: string, catalogue: SkillSpec[], nodes: DagNode[]): number {
  const tokens = description
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return nodes.length === 0 ? 0 : 1;
  const corpus = new Set<string>();
  for (const node of nodes) {
    const specs = catalogue.filter((s) => s.id === node.skill);
    if (specs.length === 0) continue;
    for (const spec of specs) {
      const text = `${spec.name} ${spec.tags.join(' ')} ${spec.description}`.toLowerCase();
      for (const t of text.split(/[^a-z0-9]+/)) {
        if (t.length > 2) corpus.add(t);
      }
    }
  }
  const hits = tokens.filter((t) => corpus.has(t)).length;
  return hits / tokens.length;
}

function alternateProviderCount(skillId: string, catalogue: SkillSpec[]): number {
  const specs = catalogue.filter((s) => s.id === skillId);
  if (specs.length === 0) return 0;
  return specs[0]!.providedBy.length;
}

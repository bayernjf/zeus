/**
 * E1.6 offline decision replay (PRD E1.6 "every decision can be replayed:
 * participating agents, inputs, stances, aggregation process").
 *
 * This module is a set of pure, offline, read-only functions: it rebuilds a
 * deterministic, serializable timeline of a fan-out decision from the records
 * already persisted in a FanOutResult / OrchestratorSnapshot. It never
 * dispatches, never performs I/O and never re-derives a conclusion — the
 * recorded decision is presented as-is, so a replay cannot silently disagree
 * with what actually happened.
 *
 * The original dispatch input (params) lives on FanOutRequest, which is not
 * part of FanOutResult; it is therefore included only when the matching
 * request is supplied (e.g. when replaying from a kernel snapshot, which
 * persists both tables).
 */
import type { RealmType, TaskState } from '../a2a/types.js';
import type { OrchestratorSnapshot } from './orchestrator.js';
import type {
  AggregatedDecision,
  AggregationRule,
  BackendArbitration,
  BranchOutcome,
  Conflict,
  DriverResolution,
  FanOutRequest,
  FanOutResult,
  FanOutStatus,
  JudgeReview,
  Position,
  SourcedEvent,
} from './types.js';

export type ReplayStepKind =
  | 'intent-started'
  | 'branch-dispatched'
  | 'branch-event'
  | 'branch-finished'
  | 'positions-extracted'
  | 'aggregated'
  | 'conflict-detected'
  | 'backend-arbitrated'
  | 'judge-reviewed'
  | 'driver-resolved'
  | 'intent-finished';

/** One ordered, serializable step in the replayed decision timeline. */
export type ReplayStep = {
  /** 1-based position in the timeline. */
  index: number;
  kind: ReplayStepKind;
  /** Timestamp when the source record carries one. */
  at?: string;
  /** Set for branch-scoped steps. */
  vassal?: string;
  runId?: string;
  taskId?: string;
  /** Kind-specific, JSON-serializable detail (never a class instance). */
  detail: Record<string, unknown>;
};

/** One participating vassal and how its branch ended. */
export type ReplayParticipant = {
  vassal: string;
  runId: string;
  taskId?: string;
  ok: boolean;
  state?: TaskState;
  timedOut?: boolean;
  reason?: string;
  eventCount: number;
};

/** A fully replayed decision: header, inputs, participants, timeline, outcome. */
export type DecisionReplay = {
  intentId: string;
  runId: string;
  skill: string;
  realm: RealmType;
  realmId?: string;
  status: FanOutStatus;
  createdAt: string;
  /** Original fan-out input; present only when the matching request was supplied. */
  input?: Record<string, unknown>;
  aggregation?: AggregationRule;
  branchTimeoutMs?: number;
  participants: ReplayParticipant[];
  positions: Position[];
  decision: AggregatedDecision;
  conflicts: Conflict[];
  backendArbitration?: BackendArbitration;
  judgeReview?: JudgeReview;
  driverResolution?: DriverResolution;
  /** True when the served result was itself an idempotent replay (not a fresh fan-out). */
  replayed?: boolean;
  timeline: ReplayStep[];
};

/** Error raised when replay inputs are internally inconsistent. */
export class ReplayError extends Error {}

function eventTimestamp(event: SourcedEvent): string | undefined {
  const status = event.event.kind === 'status-update' ? event.event.status : undefined;
  return status?.timestamp;
}

function eventDetail(event: SourcedEvent): Record<string, unknown> {
  if (event.event.kind === 'status-update') {
    const detail: Record<string, unknown> = {
      event: 'status-update',
      state: event.event.status.state,
      final: event.event.final,
    };
    const escalation = event.event['x-zeus-escalation'];
    if (escalation) detail.escalation = escalation;
    return detail;
  }
  const artifact = event.event.artifact;
  return {
    event: 'artifact-update',
    artifactId: artifact.artifactId,
    name: artifact.name,
    partKinds: artifact.parts.map(p => p.kind),
    final: event.event.final === true,
  };
}

function isTerminalEvent(event: SourcedEvent): boolean {
  if (event.event.kind === 'status-update') return event.event.final === true;
  return event.event.final === true;
}

/**
 * Build the branch portion of the timeline by walking the merged stream in its
 * recorded global order, inserting branch-dispatched on first sight of a run
 * and branch-finished at the branch's terminal event. Branches with no stream
 * events (immediate dispatch failure / timeout) are appended afterwards.
 */
function buildBranchSteps(
  result: FanOutResult,
  push: (step: Omit<ReplayStep, 'index'>) => void,
): void {
  const byRun = new Map<string, BranchOutcome>();
  for (const branch of result.branches) byRun.set(branch.runId, branch);

  const dispatched = new Set<string>();
  const finished = new Set<string>();

  for (const sourced of result.stream) {
    const runId = sourced.source.runId;
    const branch = byRun.get(runId);
    // Defensive: a stream event whose run is unknown to the result means the
    // record is corrupt/tampered; replay must fail loud rather than hide it.
    if (!branch) {
      throw new ReplayError(`stream event references unknown branch runId ${runId} on intent ${result.intentId}`);
    }
    if (!dispatched.has(runId)) {
      dispatched.add(runId);
      push({
        kind: 'branch-dispatched',
        at: eventTimestamp(sourced),
        vassal: branch.vassal,
        runId,
        taskId: sourced.source.taskId ?? branch.taskId,
        detail: { skill: result.skill },
      });
    }
    push({
      kind: 'branch-event',
      at: eventTimestamp(sourced),
      vassal: branch.vassal,
      runId,
      taskId: sourced.source.taskId ?? branch.taskId,
      detail: eventDetail(sourced),
    });
    if (isTerminalEvent(sourced) && !finished.has(runId)) {
      finished.add(runId);
      push({
        kind: 'branch-finished',
        at: eventTimestamp(sourced),
        vassal: branch.vassal,
        runId,
        taskId: sourced.source.taskId ?? branch.taskId,
        detail: branchFinishDetail(branch),
      });
    }
  }

  // Branches that never produced a stream event (dispatch refused, timeout).
  for (const branch of result.branches) {
    if (!dispatched.has(branch.runId)) {
      push({
        kind: 'branch-dispatched',
        vassal: branch.vassal,
        runId: branch.runId,
        taskId: branch.taskId,
        detail: { skill: result.skill },
      });
    }
    if (!finished.has(branch.runId)) {
      push({
        kind: 'branch-finished',
        vassal: branch.vassal,
        runId: branch.runId,
        taskId: branch.taskId,
        detail: branchFinishDetail(branch),
      });
    }
  }
}

function branchFinishDetail(branch: BranchOutcome): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    ok: branch.ok,
    ...(branch.state ? { state: branch.state } : {}),
    ...(branch.timedOut ? { timedOut: true } : {}),
    ...(branch.reason ? { reason: branch.reason } : {}),
  };
  return detail;
}

/**
 * Offline replay of one fan-out decision. Pure and read-only: no dispatch, no
 * I/O, no re-aggregation. Pass the matching FanOutRequest (available in a
 * kernel snapshot) to include the original input and aggregation rule.
 */
export function replayDecision(result: FanOutResult, request?: FanOutRequest): DecisionReplay {
  if (request && request.intentId && request.intentId !== result.intentId) {
    throw new ReplayError(`request intent ${request.intentId} does not match result intent ${result.intentId}`);
  }

  const raw: Array<Omit<ReplayStep, 'index'>> = [];
  const push = (step: Omit<ReplayStep, 'index'>) => void raw.push(step);

  push({
    kind: 'intent-started',
    at: result.createdAt,
    detail: {
      skill: result.skill,
      realm: result.realm,
      ...(result.realmId ? { realmId: result.realmId } : {}),
      ...(request ? { input: request.params } : {}),
      ...(request?.aggregation ? { aggregation: request.aggregation } : {}),
      ...(request?.branchTimeoutMs !== undefined ? { branchTimeoutMs: request.branchTimeoutMs } : {}),
    },
  });

  buildBranchSteps(result, push);

  push({
    kind: 'positions-extracted',
    detail: {
      positions: result.positions.map(p => ({
        vassal: p.vassal,
        stance: p.stance,
        ...(p.weight !== undefined ? { weight: p.weight } : {}),
        ...(p.rationale ? { rationale: p.rationale } : {}),
      })),
    },
  });

  push({
    kind: 'aggregated',
    detail: {
      rule: result.decision.rule,
      conclusion: result.decision.conclusion,
      reason: result.decision.reason,
      ...(result.decision.margin ? { margin: result.decision.margin } : {}),
    },
  });

  for (const conflict of result.conflicts) {
    push({
      kind: 'conflict-detected',
      detail: { reason: conflict.reason, stances: conflict.stances },
    });
  }

  if (result.backendArbitration) {
    push({
      kind: 'backend-arbitrated',
      at: result.backendArbitration.decidedAt,
      detail: backendArbitrationDetail(result.backendArbitration),
    });
  }

  if (result.judgeReview) {
    push({
      kind: 'judge-reviewed',
      at: result.judgeReview.decidedAt,
      detail: judgeReviewDetail(result.judgeReview),
    });
  }

  if (result.driverResolution) {
    push({
      kind: 'driver-resolved',
      at: result.driverResolution.decidedAt,
      detail: {
        escalationId: result.driverResolution.escalationId,
        stance: result.driverResolution.stance,
        ...(result.driverResolution.note ? { note: result.driverResolution.note } : {}),
      },
    });
  }

  push({ kind: 'intent-finished', detail: { status: result.status } });

  const timeline = raw.map((step, i) => ({ ...step, index: i + 1 }));

  const eventCountByRun = new Map<string, number>();
  for (const sourced of result.stream) {
    eventCountByRun.set(sourced.source.runId, (eventCountByRun.get(sourced.source.runId) ?? 0) + 1);
  }

  const participants: ReplayParticipant[] = result.branches.map(branch => ({
    vassal: branch.vassal,
    runId: branch.runId,
    ...(branch.taskId ? { taskId: branch.taskId } : {}),
    ok: branch.ok,
    ...(branch.state ? { state: branch.state } : {}),
    ...(branch.timedOut ? { timedOut: true } : {}),
    ...(branch.reason ? { reason: branch.reason } : {}),
    eventCount: eventCountByRun.get(branch.runId) ?? 0,
  }));

  return {
    intentId: result.intentId,
    runId: result.runId,
    skill: result.skill,
    realm: result.realm,
    ...(result.realmId ? { realmId: result.realmId } : {}),
    status: result.status,
    createdAt: result.createdAt,
    ...(request ? { input: request.params } : {}),
    ...(request?.aggregation ? { aggregation: request.aggregation } : {}),
    ...(request?.branchTimeoutMs !== undefined ? { branchTimeoutMs: request.branchTimeoutMs } : {}),
    participants,
    positions: result.positions,
    decision: result.decision,
    conflicts: result.conflicts,
    ...(result.backendArbitration ? { backendArbitration: result.backendArbitration } : {}),
    ...(result.judgeReview ? { judgeReview: result.judgeReview } : {}),
    ...(result.driverResolution ? { driverResolution: result.driverResolution } : {}),
    ...(result.replayed ? { replayed: true } : {}),
    timeline,
  };
}

function backendArbitrationDetail(arbitration: BackendArbitration): Record<string, unknown> {
  const detail: Record<string, unknown> = { concluded: arbitration.concluded };
  if (arbitration.conclusion !== undefined) detail.conclusion = arbitration.conclusion;
  if (arbitration.confidence !== undefined) detail.confidence = arbitration.confidence;
  if (arbitration.calibrated !== undefined) detail.calibrated = arbitration.calibrated;
  if (arbitration.backend) detail.backend = arbitration.backend;
  if (arbitration.model) detail.model = arbitration.model;
  if (arbitration.error) detail.error = arbitration.error;
  return detail;
}

function judgeReviewDetail(review: JudgeReview): Record<string, unknown> {
  const detail: Record<string, unknown> = { judged: review.judged };
  if (review.recommended !== undefined) detail.recommended = review.recommended;
  if (review.agreesWithRule !== undefined) detail.agreesWithRule = review.agreesWithRule;
  if (review.escalated !== undefined) detail.escalated = review.escalated;
  if (review.confidence !== undefined) detail.confidence = review.confidence;
  if (review.calibrated !== undefined) detail.calibrated = review.calibrated;
  if (review.reason) detail.reason = review.reason;
  if (review.backend) detail.backend = review.backend;
  if (review.model) detail.model = review.model;
  if (review.error) detail.error = review.error;
  return detail;
}

/** Replay many results, pairing each with its request when one is available. */
export function replayDecisions(
  results: readonly FanOutResult[],
  requests?: ReadonlyArray<{ intentId: string; request: FanOutRequest }>,
): DecisionReplay[] {
  const byIntent = new Map((requests ?? []).map(entry => [entry.intentId, entry.request]));
  return results.map(result => replayDecision(result, byIntent.get(result.intentId)));
}

/**
 * Replay every intent recorded in an orchestrator snapshot, restoring original
 * inputs from the persisted request table. Intents replay in snapshot order.
 */
export function replaySnapshot(snapshot: OrchestratorSnapshot): DecisionReplay[] {
  return replayDecisions(snapshot.intents, snapshot.requests);
}

/** Deterministic, human-readable rendering of a replayed decision. */
export function renderReplay(replay: DecisionReplay): string {
  const lines: string[] = [];
  lines.push(`Decision replay: intent ${replay.intentId} (run ${replay.runId})`);
  lines.push(
    `  skill=${replay.skill} realm=${replay.realm}${replay.realmId ? ` realmId=${replay.realmId}` : ''} status=${replay.status}`,
  );
  lines.push(`  created=${replay.createdAt}${replay.replayed ? ' [served from idempotent replay]' : ''}`);
  if (replay.input) lines.push(`  input=${safeStringify(replay.input)}`);
  if (replay.aggregation) lines.push(`  aggregation=${safeStringify(replay.aggregation)}`);
  if (replay.branchTimeoutMs !== undefined) lines.push(`  branchTimeoutMs=${replay.branchTimeoutMs}`);

  lines.push(`  participants (${replay.participants.length}):`);
  for (const participant of replay.participants) {
    const tail = [
      participant.state ? `state=${participant.state}` : 'ok=false',
      `${participant.eventCount} event(s)`,
      participant.timedOut ? 'timed-out' : undefined,
      participant.reason ? `reason=${participant.reason}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `    - ${participant.vassal} run=${participant.runId}${participant.taskId ? ` task=${participant.taskId}` : ''}: ${tail}`,
    );
  }

  lines.push('  timeline:');
  for (const step of replay.timeline) {
    const who = step.vassal ? ` [${step.vassal}${step.taskId ? `/${step.taskId}` : ''}]` : '';
    const when = step.at ? ` ${step.at}` : '';
    lines.push(`    ${step.index}. ${step.kind}${who}${when} ${safeStringify(step.detail)}`);
  }

  if (replay.positions.length > 0) {
    lines.push('  positions:');
    for (const position of replay.positions) {
      const weight = position.weight !== undefined ? ` weight=${position.weight}` : '';
      const rationale = position.rationale ? ` — ${position.rationale}` : '';
      lines.push(`    - ${position.vassal}: ${position.stance}${weight}${rationale}`);
    }
  }

  const decision = replay.decision;
  const margin = decision.margin ? ` (${decision.margin.winnerCount}/${decision.margin.total} for "${decision.margin.winner}")` : '';
  lines.push(`  decision: rule=${decision.rule} conclusion=${decision.conclusion === null ? '<split>' : `"${decision.conclusion}"`}${margin}`);
  lines.push(`    reason=${decision.reason}`);

  if (replay.conflicts.length > 0) {
    lines.push(`  conflicts (${replay.conflicts.length}):`);
    for (const conflict of replay.conflicts) {
      const stances = conflict.stances.map(s => `${s.stance}{${s.vassals.join(',')}}`).join(' vs ');
      lines.push(`    - ${stances} — ${conflict.reason}`);
    }
  }
  if (replay.backendArbitration) {
    const arbitration = replay.backendArbitration;
    lines.push(
      `  backend arbitration: concluded=${arbitration.concluded} backend=${arbitration.backend ?? '?'} model=${arbitration.model ?? '?'} confidence=${arbitration.confidence ?? '?'} calibrated=${arbitration.calibrated ?? '?'}`,
    );
  }
  if (replay.judgeReview) {
    const review = replay.judgeReview;
    if (review.judged) {
      lines.push(
        `  judge review: recommended="${review.recommended ?? '?'}" agreesWithRule=${review.agreesWithRule} escalated=${review.escalated === true} backend=${review.backend ?? '?'} model=${review.model ?? '?'} confidence=${review.confidence ?? '?'} calibrated=${review.calibrated ?? '?'}`,
      );
    } else {
      lines.push(`  judge review: not counted (${review.reason ?? 'skipped'}) backend=${review.backend ?? '?'} model=${review.model ?? '?'}`);
    }
  }
  if (replay.driverResolution) {
    const resolution = replay.driverResolution;
    lines.push(`  driver resolution: stance="${resolution.stance}" escalation=${resolution.escalationId} at=${resolution.decidedAt}`);
  }

  return lines.join('\n');
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, null, 0);
}

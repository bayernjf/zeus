import type { TaskState } from '../a2a/types.js';
import { arbitrateConflict } from './arbitration.js';
import { aggregate, extractPositions } from './aggregate.js';
import { detectConflicts } from './conflict.js';
import { judgeDecision } from './judge.js';
import { mergeBranches } from './merge.js';
import { applyConflictResolution, recomputeResult, statusFromBranches } from './resolution.js';
import { ConcurrencyMetrics, type BranchOutcomeKind } from './metrics.js';
import type { DecisionBackend } from '../decision/types.js';
import type { ProgressEvent } from './progress.js';
import type {
  BranchOutcome,
  CancelBranchResult,
  Conflict,
  DispatchPort,
  DriverResolution,
  FanOutRequest,
  FanOutResult,
  FanOutStatus,
  TargetLookup,
} from './types.js';

const TERMINAL_STATES = new Set<TaskState>(['completed', 'failed', 'canceled']);

export type OrchestratorOptions = {
  now?: () => Date;
  newIntentId?: () => string;
  newRunId?: () => string;
  /** Called when a fan-out ends in needs-driver; wire it to OversightDesk at assembly time. */
  onConflict?: (conflicts: Conflict[], result: FanOutResult) => void;
  /** E1.7: collect in-flight / latency / failure metrics when provided. */
  metrics?: ConcurrencyMetrics;
  /** S2: when set, unresolved splits get one backend arbitration before escalating. */
  decisionBackend?: DecisionBackend;
  /** Confidence gate for backend arbitration (default 0.8). */
  arbitrationThreshold?: number;
  /** Permit uncalibrated (LLM) confidence to conclude (default false). */
  allowUncalibratedArbitration?: boolean;
  /** Per-call timeout for the arbitration backend. */
  arbitrationMaxWaitMs?: number;
  /** E1.3: adversarially review a rule-concluded multi-stance decision when true. */
  judgeEnabled?: boolean;
  /** Confidence gate for the judge recommendation to count (default 0.8). */
  judgeThreshold?: number;
  /** Permit uncalibrated (LLM) judge confidence to count (default false). */
  allowUncalibratedJudge?: boolean;
  /** A gated high-confidence judge disagreement escalates to the driver (default true). */
  judgeEscalateOnDisagreement?: boolean;
  /** Per-call timeout for the judge backend. */
  judgeMaxWaitMs?: number;
  /** H3: publish branch lifecycle + intent-finished events to the SSE hub. */
  onProgress?: (event: ProgressEvent) => void;
};

export class UnknownIntentError extends Error {}

/** E5.3 persisted shape of the orchestrator's in-memory state. */
export type OrchestratorSnapshot = {
  intents: FanOutResult[];
  requests: Array<{ intentId: string; request: FanOutRequest }>;
};

/**
 * Fan-out decision kernel (PRD E1): one intent fans out to N vassals in
 * parallel through the existing Dispatcher, then merges streams, aggregates
 * stances, detects conflicts and escalates unresolved splits. Governance
 * (data diode / redaction / revocation / audit) stays in Dispatcher.
 */
export class Orchestrator {
  private intents = new Map<string, FanOutResult>();
  private requests = new Map<string, FanOutRequest>();

  constructor(
    private lookup: TargetLookup,
    private dispatcher: DispatchPort,
    private options: OrchestratorOptions = {}
  ) {}

  async fanOut(request: FanOutRequest): Promise<FanOutResult> {
    // F2 idempotency: a known intent replays its stored result with zero dispatch.
    if (request.intentId) {
      const cached = this.intents.get(request.intentId);
      if (cached) return { ...cached, replayed: true };
    }

    const intentId = request.intentId ?? this.newIntentId();
    const runId = request.runId ?? this.newRunId();
    const names =
      request.vassals && request.vassals.length > 0
        ? [...new Set(request.vassals)]
        : this.lookup.findBySkill(request.skill).map(vassal => vassal.name);

    let result: FanOutResult;
    if (names.length === 0) {
      result = {
        intentId, runId, skill: request.skill, realm: request.realm,
        ...(request.realmId ? { realmId: request.realmId } : {}),
        branches: [], stream: [],
        positions: [], decision: aggregate([], request.aggregation), conflicts: [],
        status: 'failed', createdAt: this.now().toISOString(),
      };
    } else {
      const branches = await Promise.all(names.map(name => this.runTrackedBranch(name, request, runId, intentId)));
      const positions = extractPositions(branches);
      const decision = aggregate(positions, request.aggregation);
      const conflicts = detectConflicts(positions, decision);
      result = {
        intentId, runId, skill: request.skill, realm: request.realm,
        ...(request.realmId ? { realmId: request.realmId } : {}),
        branches,
        stream: mergeBranches(branches), positions, decision, conflicts,
        status: statusFromBranches(branches, conflicts.length > 0),
        createdAt: this.now().toISOString(),
      };
    }

    // S2: give a configured decision backend one gated chance to arbitrate the
    // split; only a still-unresolved result reaches the human driver.
    result = await this.maybeArbitrate(result);
    // E1.3: when enabled, an independent backend adversarially reviews a
    // rule-concluded multi-stance decision; gated disagreement re-escalates.
    result = await this.maybeJudge(result);

    // Store every fan-out under its final intentId (client-supplied idempotency
    // key or server-generated id) so the driver face can read/settle intents it
    // did not name. Replay still triggers only when the client sends a known
    // intentId on the way in (the cache lookup above is gated on request.intentId).
    this.intents.set(intentId, result);
    this.requests.set(intentId, request);
    if (result.status === 'needs-driver') this.options.onConflict?.(result.conflicts, result);
    this.emit({
      type: 'intent-finished', intentId, runId: result.runId, status: result.status,
      ...(result.realmId ? { realmId: result.realmId } : {}),
      at: this.now().toISOString(),
    });
    return result;
  }

  /** Read a stored intent result (assembly / persistence use). */
  getIntent(intentId: string): FanOutResult | undefined {
    const result = this.intents.get(intentId);
    return result ? structuredClone(result) : undefined;
  }

  /** E6.3: find the intent whose branch run matches a task-input escalation.
   *  Branch runIds are `${parentRunId}:${vassal}`, so the escalation's runId
   *  alone is enough to locate the stored intent. */
  findIntentForBranchRun(branchRunId: string, vassal: string): string | undefined {
    for (const [intentId, result] of this.intents) {
      if (result.branches.some(branch => branch.runId === branchRunId && branch.vassal === vassal)) {
        return intentId;
      }
    }
    return undefined;
  }

  /** E5.3: serializable snapshot of idempotent intent results plus the original
   *  requests needed to resume/re-dispatch a branch after restart. */
  exportState(): OrchestratorSnapshot {
    return {
      intents: [...this.intents.values()].map(intent => structuredClone(intent)),
      requests: [...this.requests.entries()].map(([intentId, request]) => ({ intentId, request: structuredClone(request) })),
    };
  }

  /** E5.3: restore intents/requests from a snapshot. */
  importState(snapshot: OrchestratorSnapshot): void {
    this.intents = new Map(snapshot.intents.map(intent => [intent.intentId, structuredClone(intent)]));
    this.requests = new Map(snapshot.requests.map(({ intentId, request }) => [intentId, structuredClone(request)]));
  }

  /** E6.2: write the driver's conflict settlement back into the stored intent. */
  resolveIntent(intentId: string, driver: Omit<DriverResolution, 'decidedAt'>): FanOutResult {
    const current = this.intents.get(intentId);
    if (!current) throw new UnknownIntentError(`unknown intent: ${intentId}`);
    const resolved = applyConflictResolution(current, { ...driver, decidedAt: this.now().toISOString() });
    this.intents.set(intentId, resolved);
    return structuredClone(resolved);
  }

  /**
   * E6.3 minimal re-dispatch: after a vassal task is approved with human-supplied
   * parameters, re-run that single branch and recompute the whole intent. The
   * other branches are untouched; the new branch replaces the old one.
   */
  async resumeBranch(intentId: string, vassal: string, params: Record<string, unknown>): Promise<FanOutResult> {
    const previous = this.intents.get(intentId);
    const original = this.requests.get(intentId);
    if (!previous || !original) throw new UnknownIntentError(`unknown intent: ${intentId}`);
    if (!previous.branches.some(branch => branch.vassal === vassal)) {
      throw new Error(`intent ${intentId} has no branch for vassal ${vassal}`);
    }
    const resumeNo = previous.branches.filter(branch => branch.vassal === vassal).length;
    const resumeRequest: FanOutRequest = { ...original, params: { ...original.params, ...params } };
    const branch = await this.runTrackedBranch(vassal, resumeRequest, previous.runId, intentId, resumeNo);
    const others = previous.branches.filter(existing => existing.vassal !== vassal);
    const branches = [...others, branch];
    const recomputed = recomputeResult(previous, branches, original.aggregation, this.now);
    const arbitrated = await this.maybeArbitrate(recomputed);
    const judged = await this.maybeJudge(arbitrated);
    this.intents.set(intentId, judged);
    if (judged.status === 'needs-driver') this.options.onConflict?.(judged.conflicts, judged);
    this.emit({
      type: 'intent-finished', intentId, runId: judged.runId, status: judged.status,
      ...(judged.realmId ? { realmId: judged.realmId } : {}),
      at: this.now().toISOString(),
    });
    return structuredClone(judged);
  }

  /** F3: cancel every non-terminal branch of an intent; terminal branches are skipped. */
  async cancelIntent(intentId: string): Promise<{ intentId: string; results: CancelBranchResult[] }> {
    const result = this.intents.get(intentId);
    if (!result) throw new UnknownIntentError(`unknown intent: ${intentId}`);

    const cancellable = result.branches.filter(
      branch => branch.ok && branch.taskId && branch.state && !TERMINAL_STATES.has(branch.state)
    );
    const results = await Promise.all(
      cancellable.map(async branch => {
        try {
          await this.dispatcher.cancel(branch.vassal, branch.taskId!);
          return { vassal: branch.vassal, taskId: branch.taskId!, canceled: true } satisfies CancelBranchResult;
        } catch (error) {
          return {
            vassal: branch.vassal,
            taskId: branch.taskId!,
            canceled: false,
            reason: error instanceof Error ? error.message : 'cancel failed',
          } satisfies CancelBranchResult;
        }
      })
    );
    return { intentId, results };
  }

  private branchRunId(parentRunId: string, vassal: string, resumeNo: number): string {
    return resumeNo > 0 ? `${parentRunId}:${vassal}:resume${resumeNo}` : `${parentRunId}:${vassal}`;
  }

  /** runBranch plus E1.7 metric lifecycle bookkeeping. */
  private async runTrackedBranch(
    vassal: string,
    request: FanOutRequest,
    parentRunId: string,
    intentId: string,
    resumeNo = 0
  ): Promise<BranchOutcome> {
    const branchRunId = this.branchRunId(parentRunId, vassal, resumeNo);
    const metrics = this.options.metrics;
    metrics?.enqueue();
    metrics?.branchStarted({ intentId, runId: branchRunId, vassal, skill: request.skill, startedAt: this.now().toISOString() });
    this.emit({ type: 'branch-started', intentId, runId: branchRunId, vassal, skill: request.skill, at: this.now().toISOString() });
    const branch = await this.runBranch(vassal, request, parentRunId, resumeNo);
    metrics?.branchEnded(intentId, branchRunId, vassal, outcomeOf(branch));
    this.emit({
      type: 'branch-ended', intentId, runId: branchRunId, vassal,
      outcome: outcomeOf(branch), ...(branch.ok ? { state: branch.state } : {}),
      at: this.now().toISOString(),
    });
    return branch;
  }

  private async runBranch(vassal: string, request: FanOutRequest, parentRunId: string, resumeNo = 0): Promise<BranchOutcome> {
    const branchRunId = this.branchRunId(parentRunId, vassal, resumeNo);
    const pending = this.dispatcher
      .dispatch({
        vassal,
        skill: request.skill,
        params: request.params,
        realm: request.realm,
        runId: branchRunId,
        ...(request.realmHits ? { realmHits: request.realmHits } : {}),
      })
      .catch(error => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : 'dispatch rejected',
      }));

    try {
      const settled = request.branchTimeoutMs
        ? await Promise.race([
            pending.then(outcome => ({ kind: 'settled' as const, outcome })),
            timeout(request.branchTimeoutMs).then(() => ({ kind: 'timeout' as const })),
          ])
        : await pending.then(outcome => ({ kind: 'settled' as const, outcome }));

      if (settled.kind === 'timeout') {
        return { vassal, runId: branchRunId, ok: false, events: [], timedOut: true, reason: `branch timed out after ${request.branchTimeoutMs}ms` };
      }
      const outcome = settled.outcome;
      if (outcome.ok) {
        return {
          vassal, runId: branchRunId, ok: true, taskId: outcome.task.id,
          state: outcome.task.status.state, task: outcome.task, events: outcome.events,
        };
      }
      return { vassal, runId: branchRunId, ok: false, events: [], reason: outcome.reason };
    } catch (error) {
      return { vassal, runId: branchRunId, ok: false, events: [], reason: error instanceof Error ? error.message : 'branch failed' };
    }
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private emit(event: ProgressEvent): void {
    this.options.onProgress?.(event);
  }

  /** S2: consult the decision backend on a needs-driver split, if configured. */
  private async maybeArbitrate(result: FanOutResult): Promise<FanOutResult> {
    const backend = this.options.decisionBackend;
    if (!backend || result.status !== 'needs-driver' || result.conflicts.length === 0) return result;
    return arbitrateConflict({
      result,
      backend,
      ...(this.options.arbitrationThreshold !== undefined
        ? { threshold: this.options.arbitrationThreshold }
        : {}),
      ...(this.options.allowUncalibratedArbitration !== undefined
        ? { allowUncalibrated: this.options.allowUncalibratedArbitration }
        : {}),
      ...(this.options.arbitrationMaxWaitMs !== undefined
        ? { maxWaitMs: this.options.arbitrationMaxWaitMs }
        : {}),
      now: () => this.now(),
    });
  }

  /** E1.3: adversarially review a rule-concluded multi-stance decision, when enabled. */
  private async maybeJudge(result: FanOutResult): Promise<FanOutResult> {
    const backend = this.options.decisionBackend;
    if (!backend || !this.options.judgeEnabled) return result;
    return judgeDecision({
      result,
      backend,
      ...(this.options.judgeThreshold !== undefined ? { threshold: this.options.judgeThreshold } : {}),
      ...(this.options.allowUncalibratedJudge !== undefined
        ? { allowUncalibrated: this.options.allowUncalibratedJudge }
        : {}),
      ...(this.options.judgeEscalateOnDisagreement !== undefined
        ? { escalateOnDisagreement: this.options.judgeEscalateOnDisagreement }
        : {}),
      ...(this.options.judgeMaxWaitMs !== undefined ? { maxWaitMs: this.options.judgeMaxWaitMs } : {}),
      now: () => this.now(),
    });
  }

  private newIntentId(): string {
    return this.options.newIntentId?.() ?? `intent-${crypto.randomUUID()}`;
  }

  private newRunId(): string {
    return this.options.newRunId?.() ?? `zeus-run-${crypto.randomUUID()}`;
  }
}

function timeout(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Map a branch outcome to an E1.7 metric category. */
function outcomeOf(branch: BranchOutcome): BranchOutcomeKind {
  if (branch.timedOut) return 'timeout';
  if (!branch.ok) return 'failed';
  if (branch.state === 'canceled') return 'canceled';
  return 'completed';
}

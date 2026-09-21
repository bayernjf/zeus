import type { TaskState } from '../a2a/types.js';
import { aggregate, extractPositions } from './aggregate.js';
import { detectConflicts } from './conflict.js';
import { mergeBranches } from './merge.js';
import type {
  BranchOutcome,
  CancelBranchResult,
  Conflict,
  DispatchPort,
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
};

export class UnknownIntentError extends Error {}

/**
 * Fan-out decision kernel (PRD E1): one intent fans out to N vassals in
 * parallel through the existing Dispatcher, then merges streams, aggregates
 * stances, detects conflicts and escalates unresolved splits. Governance
 * (data diode / redaction / revocation / audit) stays in Dispatcher.
 */
export class Orchestrator {
  private intents = new Map<string, FanOutResult>();

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
        intentId, runId, skill: request.skill, realm: request.realm, branches: [], stream: [],
        positions: [], decision: aggregate([], request.aggregation), conflicts: [],
        status: 'failed', createdAt: this.now().toISOString(),
      };
    } else {
      const branches = await Promise.all(names.map(name => this.runBranch(name, request, runId)));
      const positions = extractPositions(branches);
      const decision = aggregate(positions, request.aggregation);
      const conflicts = detectConflicts(positions, decision);
      result = {
        intentId, runId, skill: request.skill, realm: request.realm, branches,
        stream: mergeBranches(branches), positions, decision, conflicts,
        status: deriveStatus(branches, conflicts.length > 0),
        createdAt: this.now().toISOString(),
      };
    }

    if (request.intentId) this.intents.set(request.intentId, result);
    if (result.status === 'needs-driver') this.options.onConflict?.(result.conflicts, result);
    return result;
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

  private async runBranch(vassal: string, request: FanOutRequest, parentRunId: string): Promise<BranchOutcome> {
    const branchRunId = `${parentRunId}:${vassal}`;
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

  private newIntentId(): string {
    return this.options.newIntentId?.() ?? `intent-${crypto.randomUUID()}`;
  }

  private newRunId(): string {
    return this.options.newRunId?.() ?? `zeus-run-${crypto.randomUUID()}`;
  }
}

function deriveStatus(branches: BranchOutcome[], hasUnresolvedConflict: boolean): FanOutStatus {
  const succeeded = branches.filter(branch => branch.ok);
  if (succeeded.length === 0) return 'failed';
  if (hasUnresolvedConflict) return 'needs-driver';
  if (succeeded.length < branches.length) return 'partial';
  return 'completed';
}

function timeout(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

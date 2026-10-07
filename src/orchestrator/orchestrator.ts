import type { TaskState } from '../a2a/types.js';
import type { RosterVerifier } from '../registry/signing.js';
import { verifyAndConsumeExecutionDelegation, type ExecutionDelegationNonceLedger } from '../delegation/execution-delegation.js';
import { arbitrateConflict } from './arbitration.js';
import { aggregate, extractPositions } from './aggregate.js';
import { detectConflicts } from './conflict.js';
import { judgeDecision } from './judge.js';
import { mergeBranches } from './merge.js';
import { applyConflictResolution, recomputeResult, statusFromBranches } from './resolution.js';
import { ConcurrencyMetrics, type BranchOutcomeKind } from './metrics.js';
import { Semaphore, type SlotRelease } from './semaphore.js';
import { selectTargets, formatExhausted, type SelectTargetsResult } from './diversion.js';
import type { DecisionBackend } from '../decision/types.js';
import { DomainError } from '../util/domain-error.js';
import type { ProgressEvent } from './progress.js';
import type { DispatchRequest, DispatchResult } from '../dispatch/dispatcher.js';
import type {
  BranchOutcome,
  CancelBranchResult,
  Conflict,
  DispatchPort,
  DriverResolution,
  FanOutRequest,
  FanOutResult,
  GovernanceRefusal,
  SkillGovernor,
  TargetLookup,
} from './types.js';
import type { IntentArchiveLookup } from '../state/archive.js';

const TERMINAL_STATES = new Set<TaskState>(['completed', 'failed', 'canceled']);

export type OrchestratorOptions = {
  now?: () => Date;
  newIntentId?: () => string;
  newRunId?: () => string;
  /** deferred #42: out-window intents read from the archive when the state
   *  table misses (idempotent replay / findIntentForBranchRun). Optional; the
   *  kernel itself performs no file I/O. */
  archive?: IntentArchiveLookup;
  /** Called when a fan-out ends in needs-driver; wire it to OversightDesk at assembly time. */
  onConflict?: (conflicts: Conflict[], result: FanOutResult) => void;
  /**
   * E6.1: called when a branch settles at input-required, i.e. a vassal stopped
   * and is asking the driver for the parameters it lacks. Wire it to
   * `OversightDesk.ingest` at assembly time — without this the desk only ever
   * sees intent conflicts and memory disputes in a booted process (C-28).
   */
  onTaskInput?: (result: DispatchResult, request: DispatchRequest) => void;
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
  /**
   * E1.5: cap on branches in flight across every intent this orchestrator
   * serves (the long-running assembly has one orchestrator, so this is the
   * process-wide bound). Unset = unbounded, which is the historical behaviour.
   */
  maxConcurrentBranches?: number;
  /** Branches allowed to wait for a slot before one is refused. Default unbounded. */
  branchQueueLimit?: number;
  /**
   * #9 per-vassal saturation cap. Distinct from `maxConcurrentBranches`: a vassal
   * is saturated when its live in-flight count reaches this cap, and a saturated
   * auto-selected target is re-pointed to the best available same-skill provider
   * (see diversion.ts). MUST be set below `maxConcurrentBranches` for diversion to
   * fire — if it equalled the global cap, a saturated agent would imply the global
   * pool was full and no idle alternate could take a slot. Unset = no per-vassal
   * saturation check (current behaviour, global gate unchanged).
   */
  maxConcurrentPerVassal?: number;
  /**
   * E2.2/E2.3/E2.4: when set, auto-selected fan-out targets (by skill) are
   * filtered through the skill catalogue's active providers; a registered skill
   * with no active provider is refused. Driver-named explicit vassals stay
   * ungoverned (a deliberate override). Card-advertised skills without a
   * catalogue record pass through unchanged.
   */
  skillGovernor?: SkillGovernor;
  /** Called when the skill governor refuses an auto-selected fan-out; bridge it
   *  into the audit spine at assembly time. */
  onRefusal?: (entry: { skill: string; realm: FanOutRequest['realm']; reason: GovernanceRefusal['reason']; detail: string; at: string }) => void;
  /** #9: fired when a saturated/eligible-lacking target is re-pointed to an
   *  alternate same-skill provider before dispatch; bridge into the audit spine. */
  onDiverted?: (entry: { skill: string; realm: FanOutRequest['realm']; from: string; to: string; at: string }) => void;
  /**
   * deferred #33: the execute-mode gate. When set, an execute-mode branch is
   * refused (no outbound dispatch) unless the supplied execution delegation
   * verifies, matches this branch's skill/vassal, and is consumed exactly once.
   * When unset, execute mode fails closed with a 'no-trust-anchor' refusal — an
   * execute that cannot be authorized is not an execute.
   */
  executionDelegation?: {
    verifier: RosterVerifier;
    ledger: ExecutionDelegationNonceLedger;
    acceptedKeyIds?: string[];
    now?: () => Date;
  };
  /** deferred #33: fired when the execute gate refuses a branch; bridge into
   *  the audit spine at assembly time (decision `execution-delegation-denied`). */
  onExecutionDelegationRefused?: (entry: { skill: string; realm: FanOutRequest['realm']; vassal: string; reason: string; at: string }) => void;
};

export class UnknownIntentError extends DomainError {
  constructor(message: string) {
    super(message, 'not-found');
  }
}

/** F2: a client-supplied intentId was reused for a materially different request. */
export class IntentRequestConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'conflict');
  }
}

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
  /**
   * A-11: intents whose fan-out is still running, registered before the first
   * branch is dispatched so a cancel arriving mid-flight resolves instead of
   * throwing UnknownIntentError. Held apart from `intents` (settled results) so
   * a replay never reads a half-built result and nothing partial is persisted.
   * Settled branches are published into the placeholder as they come back.
   */
  private inFlight = new Map<string, FanOutResult>();
  /**
   * design-fan-out §7: per-intent AbortControllers for branches whose outbound
   * A2A stream is still live. `cancelIntent` aborts these to hard-stop a running
   * branch that has no task id yet; the controller is dropped once the fan-out
   * settles. Held apart from `inFlight` (whose branches are the serializable
   * FanOutResult shape) so a controller never leaks into a result/replay.
   */
  private branchSignals = new Map<string, Map<string, AbortController>>();
  /**
   * F2 single-flight: fan-outs in flight keyed by their client-supplied intentId.
   * Without this, two concurrent calls carrying the same key both miss the result
   * cache (it is written only when the fan-out settles) and dispatch every branch
   * twice. The stored request lets the second caller be checked against the first
   * before it joins.
   */
  private pending = new Map<string, { request: FanOutRequest; work: Promise<FanOutResult> }>();
  /** E6.3 single-flight: resumes in flight keyed by `intentId::vassal`, so two
   *  approvals of the same escalation cannot re-dispatch the branch twice. */
  private resuming = new Map<string, Promise<FanOutResult>>();
  private readonly slots: Semaphore | null;

  constructor(
    private lookup: TargetLookup,
    private dispatcher: DispatchPort,
    private options: OrchestratorOptions = {}
  ) {
    const cap = options.maxConcurrentBranches;
    this.slots = cap === undefined || !Number.isFinite(cap)
      ? null
      : new Semaphore(cap, options.branchQueueLimit ?? Number.POSITIVE_INFINITY);
  }

  async fanOut(request: FanOutRequest): Promise<FanOutResult> {
    // F2 idempotency: a known intent replays its stored result with zero dispatch.
    // A key already in flight joins that fan-out instead of starting a second one,
    // and either way the incoming request must agree with the one already on
    // record — a reused key naming a different skill/params/realm is a client bug,
    // not a replay, and silently answering it with the old result would hide it.
    if (request.intentId) {
      const cached = this.intents.get(request.intentId);
      if (cached) {
        this.assertSameRequest(request, this.requests.get(request.intentId));
        return { ...structuredClone(cached), replayed: true };
      }
      const inFlight = this.pending.get(request.intentId);
      if (inFlight) {
        this.assertSameRequest(request, inFlight.request);
        return inFlight.work.then(result => ({ ...structuredClone(result), replayed: true }));
      }
      // deferred #42: a settled intent may have left the state table for the
      // archive. Replaying the archived record keeps the F2 promise — an
      // execute intent's external write still happens exactly once.
      if (this.options.archive) {
        const archived = await this.options.archive.find(request.intentId);
        if (archived) {
          this.assertSameRequest(request, archived.request);
          return { ...structuredClone(archived.result), replayed: true };
        }
      }
    }

    const work = this.fanOutNew(request);
    if (request.intentId === undefined) return work;
    this.pending.set(request.intentId, { request, work });
    try {
      return await work;
    } finally {
      this.pending.delete(request.intentId);
    }
  }

  private async fanOutNew(request: FanOutRequest): Promise<FanOutResult> {
    const intentId = request.intentId ?? this.newIntentId();
    const runId = request.runId ?? this.newRunId();
    const explicit = request.vassals && request.vassals.length > 0;
    let names =
      explicit
        ? [...new Set(request.vassals)]
        : this.lookup.findBySkill(request.skill).map(vassal => vassal.name);
    let refused: GovernanceRefusal | undefined;

    // E2.2/E2.3/E2.4 (Active work 47 §E-3): the skill catalogue governs
    // auto-selected targets. Explicit driver-named vassals are a deliberate
    // override and stay ungoverned; a skill with no catalogue record (never
    // registered) is the historical pass-through.
    if (!explicit) {
      const providers = this.options.skillGovernor?.activeProviders(request.skill);
      if (providers !== undefined && providers.length === 0) {
        refused = {
          reason: 'skill-uninstalled',
          detail: `skill '${request.skill}' is registered but has no active provider (uninstalled or deprecated); refusing dispatch`,
        };
        names = [];
      } else if (providers !== undefined) {
        const governed = names.filter(name => providers.includes(name));
        if (governed.length === 0) {
          refused = {
            reason: 'no-active-provider',
            detail: `no vassal of skill '${request.skill}' is an active provider per the skill catalogue (card-advertised providers are not auto-selected)`,
          };
        }
        names = governed;
      }
    }

    // #9 backpressure diversion (design-backpressure.md): with a per-vassal
    // saturation cap configured, re-point saturated auto-selected targets to the
    // best available same-skill provider before dispatch. Explicit driver-named
    // vassals stay hard-pinned (a deliberate override, §4.4). The live per-vassal
    // load is read from ConcurrencyMetrics; the score uses historical reliability
    // and latency from the same collector.
    let diversion: SelectTargetsResult | null = null;
    if (names.length > 0 && this.options.maxConcurrentPerVassal !== undefined) {
      const providers = this.options.skillGovernor?.activeProviders(request.skill);
      diversion = selectTargets({
        skill: request.skill,
        ...(explicit ? { explicitVassals: request.vassals } : {}),
        initialNames: names,
        ...(providers ? { candidatePool: providers } : {}),
        load: {
          inFlightByVassal: v => this.options.metrics?.inFlightByVassalNow(v) ?? 0,
          capOf: () => this.options.maxConcurrentPerVassal!,
        },
        metrics: {
          failureRate: v => this.options.metrics?.failureRateOf(v) ?? 0,
          p50Ms: v => this.options.metrics?.p50MsOf(v) ?? null,
        },
        health: { statusOf: v => this.lookup.statusOf?.(v) ?? 'unknown' },
      });
      names = diversion.plan.map(p => p.target);
    }

    let result: FanOutResult;
    if (names.length === 0) {
      result = {
        intentId, runId, skill: request.skill, realm: request.realm,
        ...(request.realmId ? { realmId: request.realmId } : {}),
        branches: [], stream: [],
        positions: [], decision: aggregate([], request.aggregation), conflicts: [],
        status: 'failed', createdAt: this.now().toISOString(),
        ...(refused ? { refused } : {}),
      };
      if (refused) {
        this.options.onRefusal?.({ skill: request.skill, realm: request.realm, reason: refused.reason, detail: refused.detail, at: this.now().toISOString() });
      }
    } else {
      // A-11: publish the intent before the first branch is dispatched so a
      // cancel arriving during the fan-out finds it. Previously the intent was
      // only stored once every branch had settled, so an in-flight cancel always
      // threw UnknownIntentError and degraded to an after-the-fact compensation.
      // The placeholder's status is never surfaced (replay/persistence read only
      // `intents`); it exists so cancelIntent has branches to act on.
      this.inFlight.set(intentId, {
        intentId, runId, skill: request.skill, realm: request.realm,
        ...(request.realmId ? { realmId: request.realmId } : {}),
        branches: names.map(name => ({
          vassal: name,
          runId: this.branchRunId(runId, name, 0),
          ok: false,
          events: [],
        })),
        stream: [], positions: [], decision: aggregate([], request.aggregation),
        conflicts: [], status: 'failed', createdAt: this.now().toISOString(),
      });
      // design-fan-out §7: one controller per branch, so an in-flight cancel can
      // abort a live stream (no task id yet) instead of waiting for it to end.
      const signals = new Map(names.map(name => [name, new AbortController()]));
      this.branchSignals.set(intentId, signals);

      let branches: BranchOutcome[];
      try {
        branches = await Promise.all(
          names.map((name, i) => {
            const entry = diversion?.plan[i];
            const exhaustedNote =
              entry && diversion?.exhausted ? formatExhausted(diversion.exhausted) : null;
            return this.runTrackedBranch(
              name, request, runId, intentId, 0,
              entry?.divertedFrom ?? null,
              exhaustedNote,
              signals.get(name)?.signal,
            );
          })
        );
      } finally {
        this.inFlight.delete(intentId);
        this.branchSignals.delete(intentId);
      }
      const positions = extractPositions(branches);
      const decision = aggregate(positions, request.aggregation);
      const conflicts = detectConflicts(positions, decision);
      // C-27: settle the classification into the stored record. Every branch gets
      // `outcome`, including the ones that never reached the network and so have
      // no `state` to be read through.
      const settled = branches.map(branch => ({ ...branch, outcome: outcomeOf(branch) }));
      result = {
        intentId, runId, skill: request.skill, realm: request.realm,
        ...(request.realmId ? { realmId: request.realmId } : {}),
        branches: settled,
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
    // C-audit 12: the stored result is also served by getIntent()/snapshot().
    // Returning the stored reference would let the caller mutate shared nested
    // arrays (branches, positions, conflicts) through the fan-out reply and
    // corrupt later replays; the caller gets an independent copy.
    return structuredClone(result);
  }

  /** Read a stored intent result (assembly / persistence use). */
  getIntent(intentId: string): FanOutResult | undefined {
    const result = this.intents.get(intentId);
    return result ? structuredClone(result) : undefined;
  }

  /** E1.6: the original fan-out request, so a replay can show the dispatch input. */
  getRequest(intentId: string): FanOutRequest | undefined {
    const request = this.requests.get(intentId);
    return request ? structuredClone(request) : undefined;
  }

  /**
   * Table sizes for the operator face. exportState() deep-clones every stored
   * intent, which is far too heavy for something a dashboard may poll, so this
   * reports counts only.
   */
  counts(): { intents: number; requests: number } {
    return { intents: this.intents.size, requests: this.requests.size };
  }

  /** E6.3: find the intent whose branch run matches a task-input escalation.
   *  Branch runIds are `${parentRunId}:${vassal}`, so the escalation's runId
   *  alone is enough to locate the stored intent. deferred #42: when the state
   *  table misses, the archive is searched too, so approve-resume keeps working
   *  after a settled intent left the window. */
  async findIntentForBranchRun(branchRunId: string, vassal: string): Promise<string | undefined> {
    for (const [intentId, result] of this.intents) {
      if (result.branches.some(branch => branch.runId === branchRunId && branch.vassal === vassal)) {
        return intentId;
      }
    }
    if (this.options.archive) {
      return this.options.archive.findByBranch(branchRunId, vassal);
    }
    return undefined;
  }

  /** deferred #42: drop settled intents (and their requests) that moved to the
   *  archive. In-flight keys are untouched — they live in `pending`, not here. */
  removeIntents(intentIds: readonly string[]): number {
    let removed = 0;
    for (const intentId of intentIds) {
      if (this.intents.delete(intentId)) removed += 1;
      this.requests.delete(intentId);
    }
    return removed;
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
    const key = `${intentId}::${vassal}`;
    const inFlight = this.resuming.get(key);
    if (inFlight) return inFlight.then(result => structuredClone(result));
    const work = this.resumeBranchNew(intentId, vassal, params);
    this.resuming.set(key, work);
    try {
      return await work;
    } finally {
      this.resuming.delete(key);
    }
  }

  private async resumeBranchNew(intentId: string, vassal: string, params: Record<string, unknown>): Promise<FanOutResult> {
    const previous = this.intents.get(intentId);
    const original = this.requests.get(intentId);
    if (!previous || !original) throw new UnknownIntentError(`unknown intent: ${intentId}`);
    if (!previous.branches.some(branch => branch.vassal === vassal)) {
      throw new Error(`intent ${intentId} has no branch for vassal ${vassal}`);
    }
    const resumeNo = this.nextResumeNo(previous, vassal);
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

  /**
   * F3: cancel every non-terminal branch of an intent; terminal branches are skipped.
   *
   * A-11: an intent is reachable from the moment its first branch is dispatched
   * (see `inFlight`), not only once the whole fan-out settles. Settled branches
   * are cancelled through the dispatcher and the outcome is written back into the
   * branch state and the recomputed aggregate, so a cancelled stance stops
   * counting instead of surviving into the next `resumeBranch` recompute.
   *
   * design-fan-out §7: a branch whose A2A stream is still live exposes no task id,
   * but its AbortController (kept in `branchSignals`) aborts the outbound request
   * at the transport edge — the stream is closed instead of waiting for it to
   * end, and the branch settles as `canceled` the moment the abort lands.
   */
  async cancelIntent(intentId: string): Promise<{ intentId: string; results: CancelBranchResult[] }> {
    const settled = this.intents.get(intentId);
    const source = settled ?? this.inFlight.get(intentId);
    if (!source) throw new UnknownIntentError(`unknown intent: ${intentId}`);

    const liveSignals = this.branchSignals.get(intentId);
    const cancellable = source.branches.filter(
      branch =>
        !isTerminalState(branch.state) &&
        ((branch.ok && branch.taskId) || (liveSignals?.has(branch.vassal) ?? false))
    );
    const results = await Promise.all(cancellable.map(branch => this.cancelBranch(intentId, branch)));
    if (settled) this.writeBackCancellations(intentId, settled, results);
    return { intentId, results };
  }

  /**
   * Cancel one branch: abort its live stream first (§7, no task id needed), then
   * forward tasks/cancel when the branch already carries a task id. A successful
   * cancel (either path) marks the branch cancelled.
   */
  private async cancelBranch(intentId: string, branch: BranchOutcome): Promise<CancelBranchResult> {
    const controller = this.branchSignals.get(intentId)?.get(branch.vassal);
    if (controller) controller.abort();
    // design-fan-out §7: a branch aborted mid-stream has no task id to name; the
    // result records it as cancelled with no task reference, which is the truth
    // for a transport-level abort.
    const taskId = branch.taskId!;
    if (taskId) {
      try {
        await this.dispatcher.cancel(branch.vassal, taskId);
      } catch (error) {
        return {
          vassal: branch.vassal,
          taskId,
          canceled: false,
          reason: error instanceof Error ? error.message : 'cancel failed',
        };
      }
    }
    branch.ok = false;
    branch.state = 'canceled';
    branch.reason = 'canceled by the driver';
    return { vassal: branch.vassal, taskId, canceled: true };
  }

  /**
   * A-11: re-derive the stored result after branches were cancelled, so the
   * cancelled stance leaves the aggregate and the status reflects the change.
   * No-op when nothing was actually cancelled.
   */
  private writeBackCancellations(intentId: string, settled: FanOutResult, results: CancelBranchResult[]): void {
    if (!results.some(result => result.canceled)) return;
    this.intents.set(
      intentId,
      recomputeResult(settled, settled.branches, this.requests.get(intentId)?.aggregation, () => this.now())
    );
  }

  /**
   * A-11: expose a settled branch (with its task id) to `cancelIntent` while its
   * siblings are still running. No-op for a finalized fan-out or a branch that
   * never got a task id.
   */
  private publishBranch(intentId: string, branch: BranchOutcome): void {
    const live = this.inFlight.get(intentId);
    if (!live || !branch.ok || !branch.taskId) return;
    const index = live.branches.findIndex(entry => entry.runId === branch.runId);
    if (index !== -1) live.branches[index] = branch;
  }

  private branchRunId(parentRunId: string, vassal: string, resumeNo: number): string {
    return resumeNo > 0 ? `${parentRunId}:${vassal}:resume${resumeNo}` : `${parentRunId}:${vassal}`;
  }

  /**
   * The next resume ordinal for a branch. The stored branch's runId carries the
   * last one (`…:vassal:resumeN`), so counting replacements is not enough: the
   * replaced branch is the only one kept, which is why the previous count always
   * returned 1 and a second resume reused the first one's run id — overwriting
   * the metric entry, colliding in the replay timeline and mis-targeting cancels.
   */
  private nextResumeNo(previous: FanOutResult, vassal: string): number {
    const base = `${previous.runId}:${vassal}`;
    const prefix = `${base}:resume`;
    let highest = 0;
    for (const branch of previous.branches) {
      if (branch.vassal !== vassal || !branch.runId.startsWith(prefix)) continue;
      const ordinal = Number(branch.runId.slice(prefix.length));
      if (Number.isInteger(ordinal)) highest = Math.max(highest, ordinal);
    }
    return highest + 1;
  }

  /**
   * F2: reject a reused idempotency key that names a different request, instead
   * of answering it with the first request's result. Compared on the fields that
   * select which work runs and where it runs — `skill`, `params`, `realm`,
   * `realmId`, `vassals`. Tuning knobs (`aggregation`, `branchTimeoutMs`,
   * `realmHits`) do not change the dispatched work and a replay may omit them;
   * `runId` and the key itself are transport bookkeeping.
   */
  private assertSameRequest(incoming: FanOutRequest, stored: FanOutRequest | undefined): void {
    if (!stored) return;
    const fields: Array<keyof FanOutRequest> = ['skill', 'params', 'realm', 'realmId', 'vassals'];
    const differing = fields.filter(field => !sameValue(incoming[field], stored[field]));
    if (differing.length > 0) {
      throw new IntentRequestConflictError(
        `intent ${incoming.intentId} is already registered with a different ${differing.join(', ')}; an idempotency key must identify one request`,
      );
    }
  }

  /** runBranch plus E1.7 metric lifecycle bookkeeping. */
  private async runTrackedBranch(
    vassal: string,
    request: FanOutRequest,
    parentRunId: string,
    intentId: string,
    resumeNo = 0,
    divertedFrom: string | null = null,
    exhaustedNote: string | null = null,
    signal?: AbortSignal
  ): Promise<BranchOutcome> {
    const branchRunId = this.branchRunId(parentRunId, vassal, resumeNo);
    const metrics = this.options.metrics;
    metrics?.enqueue();

    // E1.5: with a cap configured the branch waits here, which is what turns
    // queue depth from a permanent 0 into a real signal.
    let release: SlotRelease;
    try {
      release = await this.acquireSlot();
    } catch (error) {
      metrics?.dequeue();
      const reason = error instanceof Error ? error.message : 'branch refused';
      // #9: when the target was kept (saturated, no alternate) and still refused
      // by the global gate, attach the tried-candidates audit (design §4.5).
      return {
        vassal,
        runId: branchRunId,
        ok: false,
        events: [],
        reason: exhaustedNote ? `${reason} (${exhaustedNote})` : reason,
      };
    }

    // A-10: everything after a successful acquire lives inside this try, so a
    // throw from the start-of-branch bookkeeping (metrics, event emit, or the
    // onDiverted hook — boot wires onProgress to SSE broadcast + audit write +
    // memory consolidation) still returns the lease. When release() only guarded
    // runBranch, one such throw stranded the slot for the process lifetime.
    let branch: BranchOutcome;
    try {
      metrics?.branchStarted({ intentId, runId: branchRunId, vassal, skill: request.skill, startedAt: this.now().toISOString() });
      this.emit({ type: 'branch-started', intentId, runId: branchRunId, vassal, skill: request.skill, at: this.now().toISOString() });
      // #9: record a diversion decision alongside the branch start so the operator
      // can trace from→to on the audit/event spine (design §4.5).
      if (divertedFrom) {
        this.emit({ type: 'branch-diverted', intentId, runId: branchRunId, from: divertedFrom, to: vassal, skill: request.skill, at: this.now().toISOString() });
        this.options.onDiverted?.({ skill: request.skill, realm: request.realm, from: divertedFrom, to: vassal, at: this.now().toISOString() });
      }
      branch = await this.runBranch(vassal, request, parentRunId, resumeNo, signal);
    } finally {
      release();
    }
    // A-11: make the settled branch (now carrying its task id) visible to a
    // cancel that arrives before the sibling branches finish.
    this.publishBranch(intentId, branch);
    metrics?.branchEnded(intentId, branchRunId, vassal, outcomeOf(branch));
    this.emit({
      type: 'branch-ended', intentId, runId: branchRunId, vassal,
      outcome: outcomeOf(branch), ...(branch.ok ? { state: branch.state } : {}),
      at: this.now().toISOString(),
    });
    return branch;
  }

  /** Immediately-resolved lease when no cap is configured. */
  private acquireSlot(): Promise<SlotRelease> {
    return this.slots ? this.slots.acquire() : Promise.resolve(() => {});
  }

  private async runBranch(vassal: string, request: FanOutRequest, parentRunId: string, resumeNo = 0, signal?: AbortSignal): Promise<BranchOutcome> {
    const branchRunId = this.branchRunId(parentRunId, vassal, resumeNo);
    // deferred #33: execute-mode gate. An execute is an irreversible external
    // write, so it must carry a verified, unconsumed execution delegation; the
    // check happens before dispatch and any failure here is a refusal that
    // never leaves the kernel. Plan (the default) is unchanged.
    if (request.mode === 'execute') {
      const anchor = this.options.executionDelegation;
      const verdict = anchor
        ? await verifyAndConsumeExecutionDelegation(request.executionDelegation, {
            verifier: anchor.verifier,
            ledger: anchor.ledger,
            vassal,
            skill: request.skill,
            capability: 'execute',
            ...(anchor.acceptedKeyIds ? { acceptedKeyIds: anchor.acceptedKeyIds } : {}),
            ...(anchor.now ? { now: anchor.now } : {}),
          })
        : { ok: false as const, reason: 'no-trust-anchor' };
      if (!verdict.ok) {
        this.options.onExecutionDelegationRefused?.({
          skill: request.skill,
          realm: request.realm,
          vassal,
          reason: verdict.reason,
          at: this.now().toISOString(),
        });
        return { vassal, runId: branchRunId, ok: false, events: [], reason: `execute refused: ${verdict.reason}` };
      }
    }
    // Named once so the E6.1 hook below hands the desk exactly the request the
    // branch was dispatched with (runId/vassal/skill/realm), not a reconstruction.
    const dispatchRequest: DispatchRequest = {
      vassal,
      skill: request.skill,
      params: request.params,
      realm: request.realm,
      runId: branchRunId,
      ...(request.realmHits ? { realmHits: request.realmHits } : {}),
      ...(request.realmHitsOrigin ? { realmHitsOrigin: request.realmHitsOrigin } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    const pending = this.dispatcher
      .dispatch(dispatchRequest)
      .catch(error => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : 'dispatch rejected',
      }));

    const timeoutMs = request.branchTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = timeoutMs
        ? await Promise.race([
            pending.then(outcome => ({ kind: 'settled' as const, outcome })),
            new Promise<{ kind: 'timeout' }>(resolve => {
              timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
            }),
          ])
        : await pending.then(outcome => ({ kind: 'settled' as const, outcome }));

      if (settled.kind === 'timeout') {
        // Giving up on the wait does not cancel the outbound request, and the
        // timed-out branch carries no task id — so nothing the driver can reach
        // would ever cancel the vassal-side task. Settle the late result in the
        // background and best-effort cancel it, instead of leaving an orphan
        // running against a vassal the kernel has already stopped accounting for.
        void pending.then(outcome => {
          if (!outcome.ok) return;
          void this.dispatcher.cancel(vassal, outcome.task.id).catch(() => {});
        });
        return { vassal, runId: branchRunId, ok: false, events: [], timedOut: true, reason: `branch timed out after ${timeoutMs}ms` };
      }
      const outcome = settled.outcome;
      if (outcome.ok) {
        // E6.1: the vassal stopped because it lacks input, which is a question
        // for the driver. Hand the settled dispatch to the oversight desk before
        // the branch is recorded, so the escalation carries the real task id.
        if (outcome.task.status.state === 'input-required') {
          this.options.onTaskInput?.(outcome, dispatchRequest);
        }
        return {
          vassal, runId: branchRunId, ok: true, taskId: outcome.task.id,
          state: outcome.task.status.state, task: outcome.task, events: outcome.events,
        };
      }
      // design-fan-out §7: an aborted stream is the driver cancelling, not the
      // vassal failing — settle the branch as `canceled` so the aggregate and the
      // Web war-room show the truth instead of a generic dispatch failure.
      const aborted = signal?.aborted ?? false;
      return {
        vassal, runId: branchRunId, ok: false, events: [],
        ...(aborted ? { state: 'canceled' as const } : {}),
        reason: aborted ? 'canceled by the driver' : outcome.reason,
      };
    } catch (error) {
      return { vassal, runId: branchRunId, ok: false, events: [], reason: error instanceof Error ? error.message : 'branch failed' };
    } finally {
      // The losing branch of `Promise.race` is not cancelled by the race, so an
      // uncleared timer kept the event loop alive after the intent had settled.
      if (timer !== undefined) clearTimeout(timer);
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

/** Order-insensitive deep equality for JSON-shaped values (idempotency guard). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** A-11: a branch is terminal when it settled on a final state; a branch with no
 *  state yet (or cancelled) is still cancelable, which is why this tolerates
 *  `undefined` instead of demanding a state. */
function isTerminalState(state: BranchOutcome['state']): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

/** Map a branch outcome to an E1.7 metric category. */
function outcomeOf(branch: BranchOutcome): BranchOutcomeKind {
  if (branch.timedOut) return 'timeout';
  if (branch.state === 'canceled') return 'canceled';
  if (!branch.ok) return 'failed';
  return 'completed';
}

import { DomainError } from '../util/domain-error.js';
import type { FanOutResult } from './types.js';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.js';
import type { DispatchPort, TargetLookup } from './types.js';
import { planRecovery, type ChainPlan } from './discovery.js';
import {
  criticalPath,
  firstUnsatisfiedDependency,
  topologicalLayers,
  validateDag,
  type DagNode,
  type DagNodeState,
  type DagSpec,
  type DagState,
} from './dag.js';

/** A dagId that already ran cannot be re-run in place: its node intents are
 *  `${dagId}::${nodeId}`, so a second run would hit the orchestrator's idempotency
 *  table and silently return the first run's node results with zero dispatch. */
export class DagIdInUseError extends DomainError {
  constructor(message: string) {
    super(message, 'conflict');
  }
}

export type DagNodeResult = {
  nodeId: string;
  state: DagNodeState;
  /** Present when the node actually ran; absent when skipped. */
  fanOut?: FanOutResult;
  skippedReason?: string;
  /** The message of an unexpected throw while running the node (its dependents
   *  are skipped and unrelated branches keep going). */
  error?: string;
};

export type DagResult = {
  dagId: string;
  runId: string;
  realm: DagSpec['realm'];
  nodes: DagNodeResult[];
  state: DagState;
  /** Longest dependency chain (node ids), for span/depth observability. */
  criticalPath: string[];
  startedAt: string;
  finishedAt: string;
};

export type DagRunnerOptions = Omit<OrchestratorOptions, 'newIntentId' | 'newRunId'> & {
  newDagId?: () => string;
  newRunId?: () => string;
  /** Build a node's params from already-completed upstream node results. */
  resolveParams?: (node: DagNode, upstream: Map<string, FanOutResult>) => Record<string, unknown>;
  /**
   * S11 V3 slice 2 (design-tool-discovery §5): the chain-recovery layer. When
   * supplied, a node whose fan-out fails (failed / partial / needs-driver) is
   * resolved by the fixed chain — retry (idempotent only) -> switch -> degrade
   * -> escalate — and retry/switch are *executed* as a re-dispatch to the
   * instruction's candidate under a fresh intent id (`::r{N}`), degrade marks
   * the node `degraded` (its dependents still run), escalate keeps the existing
   * failed semantics. Absent = recovery off, zero behaviour change.
   */
  chainRecovery?: ChainRecoveryOptions;
};

/** S11 V3 slice 2: the executable chain-recovery configuration for a DAG run. */
export type ChainRecoveryOptions = {
  /** Build the per-run chain plan (one step per node, node's own candidate
   *  face). The caller wires this to the live registry. */
  buildPlan: (spec: DagSpec) => ChainPlan;
  /** Re-dispatch budget per node (retry + switch combined). Defaults to 1. */
  maxRetries?: number;
  /** Live S4 circuit state; when open, automatic retry/switch are refused
   *  (auto-selected paths only — explicit pins are unaffected). */
  circuitOpen?: () => boolean;
  /** Audit sink for executed recovery actions (chain-retried / chain-switched
   *  / chain-degraded). */
  audit?: (entry: ChainRecoveryAudit) => void;
};

/** One executed recovery action, for the audit spine. */
export type ChainRecoveryAudit = {
  intentId: string;
  nodeId: string;
  skill: string;
  realm: DagSpec['realm'];
  vassal: string;
  action: 'retry' | 'switch' | 'degrade';
  detail: string;
  at: string;
};

/**
 * S3 DAG runner: executes nodes wave by wave (topological layers), nodes within
 * a wave in parallel. Each node is one Orchestrator fan-out, so aggregation,
 * conflict escalation, cancellation and metrics are reused unchanged. A node
 * whose dependency did not complete is skipped; independent branches keep going
 * (partial failure never aborts unrelated work). State is process-memory.
 */
export class DagRunner {
  private orchestrator: Orchestrator;
  private activeDags = new Map<string, string[]>(); // dagId -> node intent ids
  private runningDags = new Map<string, Promise<DagResult>>(); // dagId -> in-flight run (single-flight)
  private dagSpecs = new Map<string, DagSpec>(); // dagId -> last spec (for layer recompute)
  private dagResults = new Map<string, DagResult>(); // dagId -> last result (states)

  constructor(
    lookup: TargetLookup,
    dispatcher: DispatchPort,
    private options: DagRunnerOptions = {},
    /** When supplied, DAG nodes run through this shared orchestrator so their
     *  intents share the kernel's idempotency table and persist with it. When
     *  omitted, the runner owns an isolated orchestrator (used by the library
     *  tests, which only care about graph math, not persistence). */
    orchestratorArg?: Orchestrator
  ) {
    // Full option pass-through (not a four-field subset): the isolated
    // orchestrator must honour the same concurrency caps, governance and
    // decision-backend configuration as the shared one, per DagRunnerOptions.
    this.orchestrator = orchestratorArg ?? new Orchestrator(lookup, dispatcher, options);
  }

  /**
   * Run a DAG. A caller-supplied dagId is single-flight: a concurrent second
   * `run` with the same id joins the first instead of dispatching every node
   * twice, and a dagId whose run has settled is refused rather than silently
   * replaying the first run's node results with zero work.
   */
  async run(spec: DagSpec): Promise<DagResult> {
    const explicitId = spec.dagId;
    if (explicitId !== undefined) {
      const inFlight = this.runningDags.get(explicitId);
      if (inFlight) return inFlight;
      if (this.dagResults.has(explicitId)) {
        throw new DagIdInUseError(
          `dag ${explicitId} has already run; submit a new dag id to run the graph again (its node intents are keyed by dag id)`,
        );
      }
    }
    const work = this.runNew(spec);
    if (explicitId === undefined) return work;
    this.runningDags.set(explicitId, work);
    try {
      return await work;
    } finally {
      this.runningDags.delete(explicitId);
    }
  }

  private async runNew(spec: DagSpec): Promise<DagResult> {
    const ordered = validateDag(spec.nodes);
    const byId = new Map(ordered.map(node => [node.id, node]));
    const layers = topologicalLayers(ordered);
    const dagId = spec.dagId ?? this.options.newDagId?.() ?? `dag-${crypto.randomUUID()}`;
    const runId = this.options.newRunId?.() ?? `run-${crypto.randomUUID()}`;
    const startedAt = (this.options.now ? this.options.now() : new Date()).toISOString();

    const nodeResults = new Map<string, DagNodeResult>();
    const nodeStates = new Map<string, DagNodeState>();
    const upstream = new Map<string, FanOutResult>();
    const intentIds: string[] = [];
    // S11 V3 slice 2: the chain plan is built once per run, then every failed
    // node resolves against its own step (spec order — buildChainPlan maps
    // spec.nodes one-to-one, and step indexes must line up with it).
    const chainPlan = this.options.chainRecovery?.buildPlan(spec);
    // Registered before the first dispatch, not after the last wave: a cancel
    // arriving mid-run must find the node intents, otherwise cancelDag is a
    // silent no-op while the nodes it names are still running.
    this.activeDags.set(dagId, intentIds);

    for (const layer of layers) {
      await Promise.all(
        layer.map(async id => {
          const node = byId.get(id)!;
          const blockedBy = firstUnsatisfiedDependency(node, dep => nodeStates.get(dep));
          if (blockedBy) {
            nodeStates.set(id, 'skipped');
            nodeResults.set(id, { nodeId: id, state: 'skipped', skippedReason: `dependency ${blockedBy} did not complete` });
            return;
          }

          nodeStates.set(id, 'running');
          const stepIndex = spec.nodes.findIndex(n => n.id === id);
          const outcome = await this.runNodeWithRecovery(node, spec, dagId, stepIndex, chainPlan, intentIds, upstream);
          if (outcome.fanOut !== undefined) upstream.set(id, outcome.fanOut);
          nodeStates.set(id, outcome.state);
          nodeResults.set(id, {
            nodeId: id,
            state: outcome.state,
            ...(outcome.fanOut !== undefined ? { fanOut: outcome.fanOut } : {}),
            ...(outcome.skippedReason !== undefined ? { skippedReason: outcome.skippedReason } : {}),
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          });
        })
      );
    }

    const finishedAt = (this.options.now ? this.options.now() : new Date()).toISOString();
    const result: DagResult = {
      dagId,
      runId,
      realm: spec.realm,
      nodes: ordered.map(node => nodeResults.get(node.id)!),
      state: aggregateDagState(nodeStates),
      criticalPath: criticalPath(ordered),
      startedAt,
      finishedAt,
    };
    this.dagSpecs.set(dagId, spec);
    this.dagResults.set(dagId, result);
    return result;
  }

  /** Read back a previously run DAG by id: the spec (for layer recomputation)
   *  and its last result (states / critical path). Undefined if never run. */
  getDag(dagId: string): { spec: DagSpec; result: DagResult } | undefined {
    const spec = this.dagSpecs.get(dagId);
    const result = this.dagResults.get(dagId);
    if (!spec || !result) return undefined;
    return { spec, result };
  }

  /** Cancel every node intent of a running/completed DAG. */
  async cancelDag(dagId: string): Promise<void> {
    const intentIds = this.activeDags.get(dagId) ?? [];
    await Promise.all(intentIds.map(id => this.orchestrator.cancelIntent(id)));
  }

  /**
   * Run one DAG node, applying the S11 V3 slice 2 chain recovery when
   * configured. A node is one fan-out; when it settles non-completed and a
   * recovery layer exists, the fixed chain resolves the failed branch into an
   * instruction and retry/switch are *executed* — a re-dispatch under a fresh
   * intent id (`::r{N}`, so the orchestrator's idempotency table never replays
   * the first attempt) pinned to the instruction's candidate. Every re-dispatch
   * counts against the per-node budget; when the budget is spent, the node
   * settles exactly as before (escalate semantics). `degrade` marks the node
   * `degraded` — a deliberate scope reduction whose dependents still run.
   * An unexpected kernel-side throw is not a branch failure, so it fails the
   * node as before without recovery.
   */
  private async runNodeWithRecovery(
    node: DagNode,
    spec: DagSpec,
    dagId: string,
    stepIndex: number,
    plan: ChainPlan | undefined,
    intentIds: string[],
    upstream: Map<string, FanOutResult>,
  ): Promise<{ state: DagNodeState; fanOut?: FanOutResult; error?: string; skippedReason?: string }> {
    const recovery = this.options.chainRecovery;
    const maxRetries = recovery?.maxRetries ?? 1;
    const tried = new Set<string>();
    let attempts = 0;
    let vassals: string[] | undefined = node.vassals;

    for (;;) {
      const intentId = `${dagId}::${node.id}${attempts === 0 ? '' : `:r${attempts}`}`;
      intentIds.push(intentId);
      let fanOut: FanOutResult;
      try {
        const params = this.options.resolveParams ? this.options.resolveParams(node, new Map(upstream)) : node.params ?? {};
        fanOut = await this.orchestrator.fanOut({
          intentId,
          skill: node.skill,
          ...(vassals !== undefined ? { vassals } : {}),
          params,
          realm: spec.realm,
          ...(node.aggregation ? { aggregation: node.aggregation } : {}),
          ...(spec.branchTimeoutMs !== undefined ? { branchTimeoutMs: spec.branchTimeoutMs } : {}),
        });
      } catch (thrown) {
        return { state: 'failed', error: errorMessage(thrown) };
      }

      const state = mapFanOutState(fanOut.status);
      if (state === 'completed') return { state, fanOut };
      if (recovery === undefined || plan === undefined || attempts >= maxRetries) return { state, fanOut };

      const failedVassal = fanOut.branches.find(branch => !branch.ok)?.vassal;
      if (failedVassal === undefined) return { state, fanOut };

      const instruction = planRecovery(
        plan,
        stepIndex,
        failedVassal,
        {
          step: node.skill,
          idempotent: node.idempotent ?? false,
          retriesLeft: maxRetries - attempts,
          highStakes: node.highStakes ?? false,
          circuitOpen: recovery.circuitOpen ? recovery.circuitOpen() : false,
          hasAlternateProvider: false,
          requiredStep: node.required ?? true,
        },
        [...tried],
      );

      if (instruction.action === 'escalate') return { state, fanOut };

      if (instruction.action === 'degrade') {
        recovery.audit?.({
          intentId,
          nodeId: node.id,
          skill: node.skill,
          realm: spec.realm,
          vassal: failedVassal,
          action: 'degrade',
          detail: `node '${node.id}' degraded (optional step failed on '${failedVassal}')`,
          at: this.nowIso(),
        });
        return { state: 'degraded', skippedReason: `degraded by recovery chain (optional step failed on '${failedVassal}')` };
      }

      // retry / switch: re-dispatch to the instruction's candidate, counting
      // against the per-node budget. The failed provider joins `tried` so a
      // later switch never returns to it.
      tried.add(failedVassal);
      attempts++;
      vassals = [instruction.candidate.provider];
      recovery.audit?.({
        intentId,
        nodeId: node.id,
        skill: node.skill,
        realm: spec.realm,
        vassal: instruction.candidate.provider,
        action: instruction.action,
        detail:
          instruction.action === 'retry'
            ? `node '${node.id}' retried on '${instruction.candidate.provider}' (attempt ${attempts}/${maxRetries})`
            : `node '${node.id}' switched from '${failedVassal}' to '${instruction.candidate.provider}' (attempt ${attempts}/${maxRetries})`,
        at: this.nowIso(),
      });
    }
  }

  private nowIso(): string {
    return (this.options.now ? this.options.now() : new Date()).toISOString();
  }
}

function mapFanOutState(status: FanOutResult['status']): DagNodeState {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'needs-driver':
      return 'needs-driver';
    // partial/failed both leave downstream dependencies unsatisfied.
    case 'partial':
    case 'failed':
    default:
      return 'failed';
  }
}

function aggregateDagState(states: Map<string, DagNodeState>): DagState {
  const list = [...states.values()];
  if (list.some(state => state === 'needs-driver')) return 'needs-driver';
  if (list.some(state => state === 'completed')) {
    // Every node completed on original scope -> completed. Any other settled
    // state (a failed node, a skipped dependent, or a degraded node — S11 V3
    // slice 2's deliberate scope reduction) makes the run partial, never
    // silently completed.
    if (list.every(state => state === 'completed')) return 'completed';
    return 'partial';
  }
  if (list.some(state => state === 'degraded')) return 'partial';
  return 'failed';
}

function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

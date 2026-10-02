import { DomainError } from '../util/domain-error.js';
import type { FanOutResult } from './types.js';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.js';
import type { DispatchPort, TargetLookup } from './types.js';
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
          try {
            const params = this.options.resolveParams ? this.options.resolveParams(node, new Map(upstream)) : node.params ?? {};
            const intentId = `${dagId}::${id}`;
            intentIds.push(intentId);
            const fanOut = await this.orchestrator.fanOut({
              intentId,
              skill: node.skill,
              ...(node.vassals ? { vassals: node.vassals } : {}),
              params,
              realm: spec.realm,
              ...(node.aggregation ? { aggregation: node.aggregation } : {}),
              ...(spec.branchTimeoutMs !== undefined ? { branchTimeoutMs: spec.branchTimeoutMs } : {}),
            });
            upstream.set(id, fanOut);
            const state = mapFanOutState(fanOut.status);
            nodeStates.set(id, state);
            nodeResults.set(id, { nodeId: id, state, fanOut });
          } catch (thrown) {
            // One node's unexpected throw fails that node; its dependents are
            // skipped and unrelated branches keep going, instead of rejecting
            // the whole wave and discarding every sibling's result.
            nodeStates.set(id, 'failed');
            nodeResults.set(id, { nodeId: id, state: 'failed', error: errorMessage(thrown) });
          }
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
  if (list.every(state => state === 'completed')) return 'completed';
  if (list.some(state => state === 'completed')) return 'partial';
  return 'failed';
}

function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

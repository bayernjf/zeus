import type { FanOutResult } from './types.js';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.js';
import type { DispatchPort, TargetLookup } from './types.js';
import type { ConcurrencyMetrics } from './metrics.js';
import {
  criticalPath,
  topologicalLayers,
  validateDag,
  type DagNode,
  type DagNodeState,
  type DagSpec,
  type DagState,
} from './dag.js';

export type DagNodeResult = {
  nodeId: string;
  state: DagNodeState;
  /** Present when the node actually ran; absent when skipped. */
  fanOut?: FanOutResult;
  skippedReason?: string;
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

  constructor(
    private lookup: TargetLookup,
    private dispatcher: DispatchPort,
    private options: DagRunnerOptions = {}
  ) {
    this.orchestrator = new Orchestrator(lookup, dispatcher, {
      now: options.now,
      newRunId: options.newRunId,
      onConflict: options.onConflict,
      metrics: options.metrics as ConcurrencyMetrics | undefined,
    });
  }

  async run(spec: DagSpec): Promise<DagResult> {
    const ordered = validateDag(spec.nodes);
    const byId = new Map(ordered.map(node => [node.id, node]));
    const layers = topologicalLayers(ordered);
    const dagId = spec.dagId ?? this.options.newDagId?.() ?? `dag-${Math.random().toString(36).slice(2, 10)}`;
    const runId = this.options.newRunId?.() ?? `run-${Math.random().toString(36).slice(2, 10)}`;
    const startedAt = (this.options.now ? this.options.now() : new Date()).toISOString();

    const nodeResults = new Map<string, DagNodeResult>();
    const nodeStates = new Map<string, DagNodeState>();
    const upstream = new Map<string, FanOutResult>();
    const intentIds: string[] = [];

    for (const layer of layers) {
      await Promise.all(
        layer.map(async id => {
          const node = byId.get(id)!;
          const blockedBy = (node.dependsOn ?? []).find(dep => nodeStates.get(dep) !== 'completed');
          if (blockedBy) {
            nodeStates.set(id, 'skipped');
            nodeResults.set(id, { nodeId: id, state: 'skipped', skippedReason: `dependency ${blockedBy} did not complete` });
            return;
          }

          nodeStates.set(id, 'running');
          const params = this.options.resolveParams ? this.options.resolveParams(node, new Map(upstream)) : node.params ?? {};
          const intentId = `${dagId}::${id}`;
          intentIds.push(intentId);
          const fanOut = await this.orchestrator.fanOut({
            intentId,
            skill: node.skill,
            vassals: node.vassals,
            params,
            realm: spec.realm,
            aggregation: node.aggregation,
            branchTimeoutMs: spec.branchTimeoutMs,
          });
          upstream.set(id, fanOut);
          const state = mapFanOutState(fanOut.status);
          nodeStates.set(id, state);
          nodeResults.set(id, { nodeId: id, state, fanOut });
        })
      );
    }

    this.activeDags.set(dagId, intentIds);
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
    return result;
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

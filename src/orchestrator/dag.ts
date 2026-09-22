import type { RealmType } from '../a2a/types.js';
import type { AggregationRule } from './types.js';

/**
 * S3 DAG dependency orchestration (pure spec + graph functions).
 *
 * A DAG node is one fan-out: a skill dispatched (possibly to several vassals),
 * aggregated with the existing pure rules. Nodes declare dependencies on earlier
 * node ids; the runner starts a node only after every dependency completed.
 * Graph math (validation / topological layers / critical path) lives here as
 * pure functions and is unit-tested independently of dispatch.
 */

export type DagNode = {
  id: string;
  skill: string;
  /** Explicit vassals; defaults to skill providers via lookup. */
  vassals?: string[];
  params?: Record<string, unknown>;
  /** Node ids that must complete before this node starts. */
  dependsOn?: string[];
  aggregation?: AggregationRule;
};

export type DagSpec = {
  dagId?: string;
  realm: RealmType;
  nodes: DagNode[];
  branchTimeoutMs?: number;
};

export class DagValidationError extends Error {}

/** Validate uniqueness, dependency existence and acyclicity; return the nodes
 *  in a stable topological order. Throws DagValidationError otherwise. */
export function validateDag(nodes: DagNode[]): DagNode[] {
  if (nodes.length === 0) throw new DagValidationError('DAG has no nodes');
  const byId = new Map<string, DagNode>();
  for (const node of nodes) {
    if (!node.id) throw new DagValidationError('a DAG node is missing id');
    if (byId.has(node.id)) throw new DagValidationError(`duplicate DAG node id: ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!byId.has(dep)) throw new DagValidationError(`node ${node.id} depends on unknown node ${dep}`);
    }
  }
  const order = topologicalOrder(nodes);
  if (order.length !== nodes.length) {
    const cyclic = nodes.map(n => n.id).filter(id => !order.includes(id));
    throw new DagValidationError(`DAG contains a cycle involving: ${cyclic.join(', ')}`);
  }
  return order.map(id => byId.get(id)!);
}

/** Kahn's algorithm; returns node ids in topological order (subset; short on a cycle). */
export function topologicalOrder(nodes: DagNode[]): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, (indegree.get(node.id) ?? 0) + (node.dependsOn?.length ?? 0));
    for (const dep of node.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  // Deterministic: process ids lexicographically within a wave.
  let ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      indegree.set(dependent, (indegree.get(dependent) ?? 1) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  return order;
}

/** Group nodes into waves: every node in layer N depends only on layers < N;
 *  nodes in the same layer have no edges between them and run in parallel. */
export function topologicalLayers(nodes: DagNode[]): string[][] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const layerOf = new Map<string, number>();
  for (const id of topologicalOrder(nodes)) {
    const node = byId.get(id)!;
    const deps = node.dependsOn ?? [];
    layerOf.set(id, deps.length === 0 ? 0 : 1 + Math.max(...deps.map(dep => layerOf.get(dep) ?? 0)));
  }
  const layers: string[][] = [];
  for (const [id, layer] of layerOf) {
    (layers[layer] ??= []).push(id);
  }
  return layers.map(layer => layer.sort());
}

/** Longest dependency chain (by node count); returns the node id sequence.
 *  This is the scheduling critical path for uniform-cost nodes. */
export function criticalPath(nodes: DagNode[]): string[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const length = new Map<string, number>();
  const predecessor = new Map<string, string | null>();
  for (const id of topologicalOrder(nodes)) {
    const node = byId.get(id)!;
    let bestPred: string | null = null;
    let bestLen = 0;
    for (const dep of node.dependsOn ?? []) {
      const depLen = length.get(dep) ?? 0;
      if (depLen > bestLen) {
        bestLen = depLen;
        bestPred = dep;
      }
    }
    length.set(id, bestLen + 1);
    predecessor.set(id, bestPred);
  }
  let end: string | null = null;
  let best = 0;
  for (const [id, len] of length) {
    if (len > best) {
      best = len;
      end = id;
    }
  }
  const path: string[] = [];
  while (end) {
    path.unshift(end);
    end = predecessor.get(end) ?? null;
  }
  return path;
}

/** Node ids whose dependencies are all satisfied (or already known-failed). The
 *  runner uses this when executing layer by layer. */
export function dependenciesSatisfied(node: DagNode, statusOf: (id: string) => DagNodeState | undefined): boolean {
  return (node.dependsOn ?? []).every(dep => statusOf(dep) === 'completed');
}

export type DagNodeState = 'pending' | 'running' | 'completed' | 'failed' | 'needs-driver' | 'skipped';
export type DagState = 'completed' | 'partial' | 'failed' | 'needs-driver';

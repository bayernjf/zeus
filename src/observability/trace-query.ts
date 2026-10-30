/**
 * TracePort v1 §5 (D-5): cross-intent trace query over the exported trees.
 *
 * Storage is the JsonlTraceExporter's JSONL (0600, keyed append by traceId);
 * its insertion-ordered in-memory map is the index at single-operator scale,
 * so the query projects filters (traceId / agent / time window / cost band /
 * limit) over those trees and returns the matched span trees plus the
 * aggregate summary (total latency / total cost / error count). Payload rules
 * follow D-4: every free-text field on a served tree goes through redactText
 * and the 2048-byte bound — defense-in-depth on top of the redaction already
 * applied at the audit and ledger write points.
 */
import { redactText } from '../util/logger.js';
import type { TraceSpan, TraceTree } from './trace.js';

/** D-4 payload bound, shared with the decision ledger. */
const MAX_FIELD_BYTES = 2048;

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;

function clip(value: string): string {
  const redacted = redactText(value);
  if (redacted.length <= MAX_FIELD_BYTES) return redacted;
  return `${redacted.slice(0, MAX_FIELD_BYTES)}…(truncated, ${redacted.length} bytes; full context via replay by runId)`;
}

/** Aggregate decision-call facts of one tree (§5: 总耗时/总成本/错误数). */
export type TraceSummary = {
  /** Sum of the measured model-call latencies in the tree. */
  totalLatencyMs: number;
  /** Sum of model-call costs in micros; calls without a known price add 0. */
  totalCostMicros: number;
  /** Model calls that ended in an error. */
  errorCount: number;
};

export function summarizeTree(tree: TraceTree): TraceSummary {
  const summary: TraceSummary = { totalLatencyMs: 0, totalCostMicros: 0, errorCount: 0 };
  for (const span of tree.spans) {
    const call = span.call;
    if (call === undefined) continue;
    summary.totalLatencyMs += call.latencyMs ?? 0;
    if (call.costMicros !== null && call.costMicros !== undefined) summary.totalCostMicros += call.costMicros;
    if (call.error !== undefined) summary.errorCount += 1;
  }
  return summary;
}

export type TraceQueryFilter = {
  agent?: string;
  from?: string;
  to?: string;
  minCostMicros?: number;
  maxCostMicros?: number;
  traceId?: string;
  limit?: number;
};

export type TraceQueryResult = {
  traces: TraceTree[];
  /** Aggregate over the returned trees (§5: 总耗时/总成本/错误数). */
  summary: TraceSummary & { count: number };
};

/** Agents seen anywhere in the tree (branch/dag-node/model spans carry vassal). */
function agentsOf(tree: TraceTree): Set<string> {
  const agents = new Set<string>();
  for (const span of tree.spans) {
    if (span.vassal !== undefined) agents.add(span.vassal);
  }
  return agents;
}

function matches(tree: TraceTree, filter: TraceQueryFilter, agents: Set<string>, startedMs: number): boolean {
  if (filter.traceId !== undefined && tree.traceId !== filter.traceId) return false;
  if (filter.agent !== undefined && !agents.has(filter.agent)) return false;
  if (filter.from !== undefined || filter.to !== undefined) {
    // A tree without an observable start time is outside any window.
    if (Number.isNaN(startedMs)) return false;
    if (filter.from !== undefined && startedMs < Date.parse(filter.from)) return false;
    if (filter.to !== undefined && startedMs > Date.parse(filter.to)) return false;
  }
  if (filter.minCostMicros !== undefined || filter.maxCostMicros !== undefined) {
    const { totalCostMicros } = summarizeTree(tree);
    if (filter.minCostMicros !== undefined && totalCostMicros < filter.minCostMicros) return false;
    if (filter.maxCostMicros !== undefined && totalCostMicros > filter.maxCostMicros) return false;
  }
  return true;
}

/** Serve-safe span copy: D-4 redaction + bound on every free-text field. */
function sanitizeSpan(span: TraceSpan): TraceSpan {
  return {
    ...span,
    ...(span.summary !== undefined ? { summary: clip(span.summary) } : {}),
    ...(span.call !== undefined
      ? { call: { ...span.call, ...(span.call.error !== undefined ? { error: clip(span.call.error) } : {}) } }
      : {}),
    ...(span.step !== undefined
      ? { step: { ...span.step, ...(span.step.conclusion !== undefined ? { conclusion: clip(span.step.conclusion) } : {}) } }
      : {}),
    events: span.events.map(e => ({ kind: e.kind, at: e.at, ...(e.detail !== undefined ? { detail: clip(e.detail) } : {}) })),
  };
}

function sanitizeTree(tree: TraceTree): TraceTree {
  return { traceId: tree.traceId, root: sanitizeSpan(tree.root), spans: tree.spans.map(sanitizeSpan) };
}

/**
 * Project the filter over the exported trees (oldest first, stable insertion
 * order) and return at most `limit` (default 50, capped 200) sanitized trees
 * with the aggregate summary over the returned set.
 */
export function queryTraceTrees(trees: readonly TraceTree[], filter: TraceQueryFilter): TraceQueryResult {
  const limit = Math.min(filter.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const traces: TraceTree[] = [];
  const summary: TraceSummary & { count: number } = { totalLatencyMs: 0, totalCostMicros: 0, errorCount: 0, count: 0 };
  for (const tree of trees) {
    if (traces.length >= limit) break;
    const startedMs = tree.root.startedAt === '' ? Number.NaN : Date.parse(tree.root.startedAt);
    if (!matches(tree, filter, agentsOf(tree), startedMs)) continue;
    traces.push(sanitizeTree(tree));
    const s = summarizeTree(tree);
    summary.totalLatencyMs += s.totalLatencyMs;
    summary.totalCostMicros += s.totalCostMicros;
    summary.errorCount += s.errorCount;
    summary.count += 1;
  }
  return { traces, summary };
}

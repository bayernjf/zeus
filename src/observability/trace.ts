// design-observability (tech map S6): the distributed trace tree assembled
// deterministically from existing facts — the audit spine and the progress
// events (or one replay's result). V1 is the pure projection only
// (design-observability §5): no exporter is attached, no protocol field is
// changed — every span fact comes from an event that already exists.
//
// Principles (design-observability §2/§3):
//  - trace is a read-only projection: it produces no authorization and affects
//    no scheduling;
//  - clocks are kernel clocks: span start/end come from event `at` fields;
//    external timestamps are never introduced in V1;
//  - missing events mean "did not happen": nothing is guessed or fabricated;
//  - output is deterministic: the same input assembles the same tree.

import type { AuditEntry } from '../dispatch/dispatcher.js';
import type { ProgressEvent } from '../orchestrator/progress.js';

export type TraceSpanKind = 'intent' | 'branch' | 'dag-node' | 'decide';

export type TraceSpanEventKind = 'target-switch' | 'resume' | 'interrupt' | 'context-budget' | 'external-link';

export type TraceSpan = {
  traceId: string;
  /** Branch runId; the intent root uses the intent id. */
  spanId: string;
  parentSpanId?: string;
  kind: TraceSpanKind;
  vassal?: string;
  skill?: string;
  realm?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  events: Array<{ kind: TraceSpanEventKind; at: string; detail?: string }>;
};

export type TraceTree = { traceId: string; root: TraceSpan; spans: TraceSpan[] };

/** Whether an intent id belongs to a DAG node intent (`${dagId}::${nodeId}`,
 *  dag-runner idempotency shape). */
function isDagNodeIntent(intentId: string): boolean {
  return intentId.includes('::');
}

function dagIdOf(nodeIntentId: string): string {
  return nodeIntentId.split('::')[0]!;
}

/** Build the trace tree from audit entries + progress events. Events are
 *  matched by runId; spans are emitted in a stable order (root first, then by
 *  spanId) so the output is order-insensitive and byte-deterministic. */
export function buildTraceTree(input: {
  audit: readonly AuditEntry[];
  progress: readonly ProgressEvent[];
  /** Explicit trace id; defaults to the fan-out root runId. */
  traceId?: string;
}): TraceTree {
  const progress = [...input.progress];
  const audit = [...input.audit];

  const firstIntentEvent =
    progress.find((e) => e.type === 'intent-finished' || e.type === 'branch-started') ??
    progress[0];
  const intentId = firstIntentEvent?.intentId;
  const isDagOnly = intentId !== undefined && isDagNodeIntent(intentId);
  const rootSpanId = intentId ?? 'trace-root';

  const finished = progress.find((e) => e.type === 'intent-finished' && !isDagNodeIntent(e.intentId));
  const rootRunId = finished?.runId ?? progress.find((e) => e.type === 'branch-started')?.runId;
  const traceId = input.traceId ?? rootRunId ?? rootSpanId;

  const spans: TraceSpan[] = [];
  const root: TraceSpan = {
    traceId,
    spanId: isDagOnly ? dagIdOf(intentId!) : rootSpanId,
    kind: 'intent',
    startedAt: firstIntentEvent?.at ?? '',
    events: [],
  };

  const byRunId = new Map<string, { index: number; intentId: string }>();
  const mark = (spanId: string, intentId: string): number => {
    const existing = byRunId.get(spanId);
    if (existing !== undefined) return existing.index;
    const index = spans.length;
    spans.push({
      traceId,
      spanId,
      parentSpanId: root.spanId,
      kind: isDagNodeIntent(intentId) ? 'dag-node' : 'branch',
      startedAt: '',
      events: [],
    });
    byRunId.set(spanId, { index, intentId });
    return index;
  };

  // Branch lifecycle: start/end fill the span frame.
  for (const e of progress) {
    if (e.type === 'branch-started') {
      const i = mark(e.runId, e.intentId);
      const s = spans[i]!;
      if (s.vassal === undefined) s.vassal = e.vassal;
      if (s.skill === undefined) s.skill = e.skill;
      if (!s.startedAt) s.startedAt = e.at;
    } else if (e.type === 'branch-ended') {
      const i = mark(e.runId, e.intentId);
      const s = spans[i]!;
      if (s.vassal === undefined) s.vassal = e.vassal;
      s.endedAt = e.at;
      s.outcome = e.outcome;
    }
  }

  // Events: re-pointing (progress carries no runId, so it lands on the root as
  // the intent-level fact; audit chain-switched lands on its branch), resume
  // (audit chain-retried with a `:resumeN` runId), interruption and context
  // budget (audit, by runId).
  for (const e of progress) {
    if (e.type === 'branch-diverted') {
      root.events.push({ kind: 'target-switch', at: e.at, detail: `${e.from} -> ${e.to}` });
    }
  }

  for (const a of audit) {
    if (a.runId === undefined) continue;
    switch (a.decision) {
      case 'chain-switched':
      case 'tool-selected': {
        const i = mark(a.runId, a.skill ?? root.spanId);
        spans[i]!.events.push({ kind: 'target-switch', at: a.ts, ...(a.detail === undefined ? {} : { detail: a.detail }) });
        break;
      }
      case 'chain-retried': {
        // Resume: a `:resumeN` runId is its own span pointing back at the
        // parent branch runId.
        const resumeNo = a.runId.match(/:resume(\d+)$/);
        const parentRunId = resumeNo ? a.runId.slice(0, a.runId.length - resumeNo[0]!.length) : a.runId;
        const parent = byRunId.get(parentRunId);
        const i = mark(a.runId, a.skill ?? root.spanId);
        const s = spans[i]!;
        s.kind = 'branch';
        s.parentSpanId = parent !== undefined ? parentRunId : root.spanId;
        if (!s.startedAt) s.startedAt = a.ts;
        s.events.push({ kind: 'resume', at: a.ts, ...(a.detail === undefined ? {} : { detail: a.detail }) });
        if (parent !== undefined) {
          spans[parent.index]!.events.push({ kind: 'resume', at: a.ts });
        }
        break;
      }
      case 'interrupt-level-0':
      case 'interrupt-level-1':
      case 'interrupt-level-2': {
        const i = mark(a.runId, a.skill ?? root.spanId);
        spans[i]!.events.push({ kind: 'interrupt', at: a.ts, detail: a.decision });
        break;
      }
      case 'context-trimmed':
      case 'context-budget-exceeded': {
        const i = mark(a.runId, a.skill ?? root.spanId);
        spans[i]!.events.push({ kind: 'context-budget', at: a.ts, ...(a.detail === undefined ? {} : { detail: a.detail }) });
        break;
      }
      case 'driver-grant-issued': {
        // The operator wrote back a decision — the closest observable
        // arbitration fact; a decide span hangs under the intent root.
        const spanId = `decide:${a.runId}`;
        spans.push({
          traceId,
          spanId,
          parentSpanId: root.spanId,
          kind: 'decide',
          vassal: a.vassal,
          ...(a.skill === undefined ? {} : { skill: a.skill }),
          startedAt: a.ts,
          events: [],
        });
        break;
      }
      case 'inbound-task-accepted': {
        // S6 V2: an inbound A2A call that carried trace context is the parent
        // linkage of this intent to a caller-side trace. The server records it
        // in the audit detail (`traceparent=...`); the tree surfaces it as an
        // external-link event on the root span. Recorded, never validated:
        // it is observation metadata, not an authorization input.
        if (a.detail !== undefined && a.detail.startsWith('traceparent=')) {
          root.events.push({ kind: 'external-link', at: a.ts, detail: a.detail });
        }
        break;
      }
      default:
        break;
    }
  }

  // Stable order: root first, then spans by spanId.
  spans.sort((x, y) => (x.spanId < y.spanId ? -1 : x.spanId > y.spanId ? 1 : 0));
  return { traceId, root, spans };
}

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
import type { BackendArbitration, JudgeReview } from '../core/orchestrator/types.js';
import type { DecisionTrace } from '../decision/types.js';
import type { ProgressEvent } from '../orchestrator/progress.js';

export type TraceSpanKind = 'intent' | 'branch' | 'dag-node' | 'decide' | 'tool' | 'model' | 'decision-step';

export type TraceSpanEventKind = 'target-switch' | 'resume' | 'interrupt' | 'context-budget' | 'external-link';

/** Model-call facts carried by a model span (TracePort v1 §2). */
export type TraceModelCall = {
  backend: string;
  model: string;
  /** Decision primitive that drove the call (noul/choice/score). */
  kind?: string;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  tokensEstimated?: boolean;
  /** Family-wide cost unit (TracePort v1 §2); cents are converted here. */
  costMicros?: number | null;
  latencyMs?: number;
  error?: string;
};

/** Decision-step facts carried by a decision-step span (TracePort v1 §2). */
export type TraceDecisionStep = {
  name: 'fanout' | 'aggregate' | 'arbitration' | 'judge';
  vassals?: string[];
  conclusion?: string;
  latencyMs?: number;
};

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
  /** One-line summary of the call fact (already-redacted audit detail). */
  summary?: string;
  call?: TraceModelCall;
  step?: TraceDecisionStep;
  events: Array<{ kind: TraceSpanEventKind; at: string; detail?: string }>;
};

export type TraceTree = { traceId: string; root: TraceSpan; spans: TraceSpan[] };

export type DecisionTraceBuffer = {
  add(trace: DecisionTrace): void;
  forRuns(runIds: Iterable<string>): DecisionTrace[];
};

/**
 * In-process runId → DecisionTrace registry for trace assembly (TracePort v1
 * §2). DecisionTrace flows arrive one call at a time through the backend
 * onTrace hook; the tree needs them grouped by the runId that drove the call.
 * Bounded: once the cap is hit the oldest run's traces are dropped — this is a
 * live assembly aid, not a ledger (the JSONL decision ledger is the durable
 * record, and the trace exporter persists assembled trees).
 */
export function createDecisionTraceBuffer(maxRuns = 512): DecisionTraceBuffer {
  const byRun = new Map<string, DecisionTrace[]>();
  return {
    add(trace: DecisionTrace): void {
      const existing = byRun.get(trace.runId);
      if (existing !== undefined) {
        existing.push(trace);
        return;
      }
      if (byRun.size >= maxRuns) {
        const oldest = byRun.keys().next().value;
        if (oldest !== undefined) byRun.delete(oldest);
      }
      byRun.set(trace.runId, [trace]);
    },
    forRuns(runIds: Iterable<string>): DecisionTrace[] {
      const collected: DecisionTrace[] = [];
      for (const runId of runIds) {
        const traces = byRun.get(runId);
        if (traces !== undefined) collected.push(...traces);
      }
      return collected;
    },
  };
}

/**
 * S6 V3 (design-observability §5): exporter narrow port. Export happens after
 * assembly; the default build attaches no exporter, so a kernel without one
 * behaves exactly as V1/V2 did. Implementations are responsible for their own
 * retention and data-sovereignty boundaries (a JSONL local-file exporter lives
 * in exporter.ts; OTLP/network exporters are intentionally not shipped).
 */
export interface TraceExporter {
  export(tree: TraceTree): void | Promise<void>;
}

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
 *  spanId) so the output is order-insensitive and byte-deterministic.
 *
 *  TracePort v1 §2 extensions (all optional — a tree built without them is
 *  byte-identical to the V1 projection):
 *  - `traces`: DecisionTrace records for the intent's runIds; each becomes a
 *    model span under the branch span owning that runId (or the intent root
 *    for arbitration/judge-level calls);
 *  - `steps`: decision-layer facts (arbitration / judge records with their
 *    measured latencyMs, plus the aggregation conclusion) that assemble the
 *    fanout/aggregate/arbitration/judge decision-step spans. */
export function buildTraceTree(input: {
  audit: readonly AuditEntry[];
  progress: readonly ProgressEvent[];
  /** Explicit trace id; defaults to the fan-out root runId. */
  traceId?: string;
  traces?: readonly DecisionTrace[];
  steps?: {
    arbitration?: BackendArbitration;
    judge?: JudgeReview;
    conclusion?: string;
  };
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
  // Kernel-level tool audit lines (no runId); assembled into tool spans below.
  const toolFacts: AuditEntry[] = [];
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
    // Kernel-level tool lines carry no runId; they are the only facts that
    // assemble spans without one (tool spans below). Everything else keys on
    // the branch runId.
    if (a.runId === undefined) {
      if (a.decision === 'tool-selected' || a.decision === 'tool-failed') toolFacts.push(a);
      continue;
    }
    switch (a.decision) {
      case 'chain-switched': {
        const i = mark(a.runId, a.skill ?? root.spanId);
        spans[i]!.events.push({ kind: 'target-switch', at: a.ts, ...(a.detail === undefined ? {} : { detail: a.detail }) });
        break;
      }
      case 'tool-selected':
      case 'tool-failed': {
        // TracePort v1 §2: a runId-bearing tool line stays a branch event (the
        // branch that caused it); kernel-level lines are collected above.
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

  // TracePort v1 §2: decision-step spans (fanout/aggregate/arbitration/judge),
  // assembled from progress frames and the decision-layer facts. A step span
  // exists only when both of its frame ends are observable — missing events
  // mean "did not happen".
  const step = (spanId: string, s: Omit<TraceSpan, 'traceId' | 'spanId' | 'events'>): void => {
    spans.push({ traceId, spanId, parentSpanId: root.spanId, events: [], ...s });
  };
  const branchStarts = progress.filter((e): e is Extract<ProgressEvent, { type: 'branch-started' }> => e.type === 'branch-started');
  const branchEnds = progress.filter((e): e is Extract<ProgressEvent, { type: 'branch-ended' }> => e.type === 'branch-ended');
  const intentFinished = progress.find((e): e is Extract<ProgressEvent, { type: 'intent-finished' }> => e.type === 'intent-finished' && !isDagNodeIntent(e.intentId));
  if (root.startedAt !== '' && branchStarts.length > 0) {
    const lastStart = branchStarts.reduce((latest, e) => (e.at > latest ? e.at : latest), branchStarts[0]!.at);
    step('step:fanout', {
      kind: 'decision-step',
      startedAt: root.startedAt,
      endedAt: lastStart,
      step: {
        name: 'fanout',
        vassals: [...new Set(branchStarts.map(e => e.vassal))].sort(),
      },
    });
  }
  if (branchEnds.length > 0 && intentFinished !== undefined) {
    const lastEnd = branchEnds.reduce((latest, e) => (e.at > latest ? e.at : latest), branchEnds[0]!.at);
    step('step:aggregate', {
      kind: 'decision-step',
      startedAt: lastEnd,
      endedAt: intentFinished.at,
      step: {
        name: 'aggregate',
        vassals: [...new Set(branchEnds.map(e => e.vassal))].sort(),
        ...(input.steps?.conclusion !== undefined ? { conclusion: input.steps.conclusion } : {}),
      },
    });
  }
  const arbitration = input.steps?.arbitration;
  if (arbitration !== undefined) {
    const started =
      arbitration.latencyMs !== undefined
        ? new Date(Date.parse(arbitration.decidedAt) - arbitration.latencyMs).toISOString()
        : arbitration.decidedAt;
    step('step:arbitration', {
      kind: 'decision-step',
      startedAt: started,
      endedAt: arbitration.decidedAt,
      step: {
        name: 'arbitration',
        ...(arbitration.conclusion !== undefined ? { conclusion: arbitration.conclusion } : {}),
        ...(arbitration.latencyMs !== undefined ? { latencyMs: arbitration.latencyMs } : {}),
      },
      ...(arbitration.backend !== undefined ? { outcome: arbitration.concluded ? 'concluded' : 'unresolved' } : {}),
      ...(arbitration.error !== undefined ? { summary: `${arbitration.error.code}: ${arbitration.error.message}` } : {}),
    });
  }
  const judge = input.steps?.judge;
  if (judge !== undefined) {
    const started =
      judge.latencyMs !== undefined
        ? new Date(Date.parse(judge.decidedAt) - judge.latencyMs).toISOString()
        : judge.decidedAt;
    const judgeConclusion = judge.judged ? judge.recommended : judge.reason;
    step('step:judge', {
      kind: 'decision-step',
      startedAt: started,
      endedAt: judge.decidedAt,
      step: {
        name: 'judge',
        ...(judgeConclusion !== undefined ? { conclusion: judgeConclusion } : {}),
        ...(judge.latencyMs !== undefined ? { latencyMs: judge.latencyMs } : {}),
      },
      ...(judge.backend !== undefined ? { outcome: judge.judged ? 'judged' : `skipped:${judge.reason ?? 'unknown'}` } : {}),
      ...(judge.error !== undefined ? { summary: `${judge.error.code}: ${judge.error.message}` } : {}),
    });
  }

  // Tool spans from the kernel-level audit facts, deterministically numbered
  // by (ts, decision, detail) order.
  toolFacts
    .sort((x, y) =>
      x.ts.localeCompare(y.ts) ||
      x.decision.localeCompare(y.decision) ||
      (x.detail ?? '').localeCompare(y.detail ?? ''),
    )
    .forEach((a, index) => {
      step(`tool:${index}`, {
        kind: 'tool',
        vassal: a.vassal,
        ...(a.skill !== undefined ? { skill: a.skill } : {}),
        ...(a.realm !== undefined ? { realm: a.realm } : {}),
        startedAt: a.ts,
        outcome: a.decision,
        ...(a.detail !== undefined ? { summary: a.detail } : {}),
      });
    });

  // Model spans from the intent's DecisionTrace records, deterministically
  // numbered by decidedAt order. A trace whose runId matches a branch span
  // hangs under that branch; arbitration/judge-level calls (the fan-out
  // runId) hang under the intent root.
  input.traces
    ?.filter(t => t.error !== undefined || t.result !== undefined || t.cost !== undefined || t.usage !== undefined)
    .map(traceRecord => ({
      traceRecord,
      key: `${traceRecord.decidedAt}:${traceRecord.backend}:${traceRecord.model}`,
    }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .forEach(({ traceRecord }, index) => {
      const parent = byRunId.get(traceRecord.runId);
      const parentSpan = parent !== undefined ? spans[parent.index] : undefined;
      const started =
        traceRecord.latencyMs !== undefined && Number.isFinite(traceRecord.latencyMs)
          ? new Date(Date.parse(traceRecord.decidedAt) - traceRecord.latencyMs).toISOString()
          : traceRecord.decidedAt;
      const span: TraceSpan = {
        traceId,
        spanId: `model:${index}`,
        parentSpanId: parentSpan?.spanId ?? root.spanId,
        kind: 'model',
        ...(parentSpan?.vassal !== undefined ? { vassal: parentSpan.vassal } : {}),
        startedAt: started,
        endedAt: traceRecord.decidedAt,
        call: {
          backend: traceRecord.backend,
          model: traceRecord.model,
          kind: traceRecord.request.kind,
          ...(traceRecord.usage !== undefined || traceRecord.cost !== undefined
            ? {
                ...(traceRecord.usage?.inputTokens !== undefined
                  ? { tokensIn: traceRecord.usage.inputTokens }
                  : traceRecord.cost?.inputTokens !== undefined
                    ? { tokensIn: traceRecord.cost.inputTokens }
                    : {}),
                ...(traceRecord.usage?.outputTokens !== undefined
                  ? { tokensOut: traceRecord.usage.outputTokens }
                  : traceRecord.cost?.outputTokens !== undefined
                    ? { tokensOut: traceRecord.cost.outputTokens }
                    : {}),
                ...(traceRecord.usage?.reasoningTokens !== undefined ? { reasoningTokens: traceRecord.usage.reasoningTokens } : {}),
                ...(traceRecord.usage?.cacheReadTokens !== undefined ? { cacheReadTokens: traceRecord.usage.cacheReadTokens } : {}),
                ...(traceRecord.usage?.tokensEstimated ? { tokensEstimated: true } : {}),
              }
            : {}),
          costMicros: traceRecord.cost ? Math.round(traceRecord.cost.cents * 10_000) : null,
          latencyMs: traceRecord.latencyMs,
          ...(traceRecord.error !== undefined ? { error: `${traceRecord.error.code}: ${traceRecord.error.message}` } : {}),
        },
        events: [],
      };
      spans.push(span);
    });

  // Stable order: root first, then spans by spanId.
  spans.sort((x, y) => (x.spanId < y.spanId ? -1 : x.spanId > y.spanId ? 1 : 0));
  return { traceId, root, spans };
}

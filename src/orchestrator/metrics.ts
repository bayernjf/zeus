/**
 * E1.7 in-process concurrency metrics (library surface only; no HTTP endpoint —
 * that arrives with the long-running H2 transport). The Orchestrator reports
 * branch lifecycle events; this collector turns them into a queryable snapshot:
 * in-flight count, observed concurrency peak, per-vassal latency and failure
 * rate, and queue depth.
 *
 * Queue depth counts branches submitted but not yet started. With no concurrency
 * cap configured the kernel still dispatches every branch at once, so depth stays
 * 0; once `maxConcurrentBranches` is set it reports the real wait line.
 */

export type BranchOutcomeKind = 'completed' | 'failed' | 'timeout' | 'canceled';

export type BranchMetricEvent = {
  intentId: string;
  runId: string;
  vassal: string;
  skill: string;
  startedAt: string;
};

type BranchRecord = BranchMetricEvent & {
  endedAt?: string;
  latencyMs?: number;
  outcome?: BranchOutcomeKind;
};

export type LatencyStats = {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
};

export type VassalMetric = {
  calls: number;
  completed: number;
  failed: number;
  timedOut: number;
  /** failed + timedOut over finished calls. */
  failureRate: number;
  latency: LatencyStats | null;
};

export type MetricsSnapshot = {
  /** Branches currently in flight (started, not ended). */
  inFlight: number;
  /** Highest concurrently in-flight observed. */
  maxInFlight: number;
  /** Submitted but not started; 0 under the current unbounded dispatch. */
  queueDepth: number;
  finished: number;
  completed: number;
  failed: number;
  timedOut: number;
  perVassal: Record<string, VassalMetric>;
  capturedAt: string;
};

export type MetricsOptions = {
  now?: () => Date;
  /** Monotonic millisecond clock for latency; defaults to Date.now. */
  elapsed?: () => number;
};

export class ConcurrencyMetrics {
  private active = new Map<string, { event: BranchMetricEvent; startedMs: number }>();
  private records: BranchRecord[] = [];
  private maxInFlight = 0;
  private queueDepth = 0;

  constructor(private options: MetricsOptions = {}) {}

  private clock(): () => number {
    return this.options.elapsed ?? (() => Date.now());
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private static key(intentId: string, runId: string, vassal: string): string {
    return `${intentId}:${runId}:${vassal}`;
  }

  /** A branch is queued for dispatch but has not started yet. */
  enqueue(): void {
    this.queueDepth += 1;
  }

  /** A queued branch left the line without starting (refused, or gave up). */
  dequeue(): void {
    this.queueDepth = Math.max(0, this.queueDepth - 1);
  }

  branchStarted(event: BranchMetricEvent): void {
    this.dequeue();
    const key = ConcurrencyMetrics.key(event.intentId, event.runId, event.vassal);
    this.active.set(key, { event, startedMs: this.clock()() });
    if (this.active.size > this.maxInFlight) this.maxInFlight = this.active.size;
  }

  branchEnded(intentId: string, runId: string, vassal: string, outcome: BranchOutcomeKind): void {
    const key = ConcurrencyMetrics.key(intentId, runId, vassal);
    const active = this.active.get(key);
    if (!active) return;
    this.active.delete(key);
    this.records.push({
      ...active.event,
      endedAt: this.now().toISOString(),
      latencyMs: this.clock()() - active.startedMs,
      outcome,
    });
  }

  /** Current in-flight branches (defensive copy). */
  inFlightBranches(): BranchMetricEvent[] {
    return [...this.active.values()].map(({ event }) => ({ ...event }));
  }

  snapshot(): MetricsSnapshot {
    const finished = this.records.filter(record => record.outcome !== undefined);
    const byVassal = new Map<string, BranchRecord[]>();
    for (const record of finished) {
      const list = byVassal.get(record.vassal) ?? [];
      list.push(record);
      byVassal.set(record.vassal, list);
    }
    const perVassal: Record<string, VassalMetric> = {};
    for (const [vassal, list] of byVassal) {
      perVassal[vassal] = this.vassalStats(list);
    }
    const completed = finished.filter(r => r.outcome === 'completed').length;
    const failed = finished.filter(r => r.outcome === 'failed').length;
    const timedOut = finished.filter(r => r.outcome === 'timeout').length;
    return {
      inFlight: this.active.size,
      maxInFlight: this.maxInFlight,
      queueDepth: this.queueDepth,
      finished: finished.length,
      completed,
      failed,
      timedOut,
      perVassal,
      capturedAt: this.now().toISOString(),
    };
  }

  private vassalStats(list: BranchRecord[]): VassalMetric {
    const failures = list.filter(r => r.outcome === 'failed').length;
    const timeouts = list.filter(r => r.outcome === 'timeout').length;
    const completed = list.filter(r => r.outcome === 'completed').length;
    const latencies = list.map(r => r.latencyMs).filter((n): n is number => typeof n === 'number').sort((a, b) => a - b);
    return {
      calls: list.length,
      completed,
      failed: failures,
      timedOut: timeouts,
      failureRate: list.length ? (failures + timeouts) / list.length : 0,
      latency: latencies.length ? latencyStats(latencies) : null,
    };
  }
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const index = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, index))];
}

function latencyStats(sortedAsc: number[]): LatencyStats {
  const sum = sortedAsc.reduce((a, b) => a + b, 0);
  return {
    count: sortedAsc.length,
    minMs: sortedAsc[0],
    maxMs: sortedAsc[sortedAsc.length - 1],
    avgMs: sum / sortedAsc.length,
    p50Ms: percentile(sortedAsc, 50),
    p95Ms: percentile(sortedAsc, 95),
  };
}

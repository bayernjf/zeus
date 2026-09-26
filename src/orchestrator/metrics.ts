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
  /** Submitted but not started; 0 unless a concurrency cap is configured. */
  queueDepth: number;
  finished: number;
  completed: number;
  failed: number;
  timedOut: number;
  perVassal: Record<string, VassalMetric>;
  /** Real-time in-flight count per vassal (defensive copy). Enables per-vassal
   *  saturation checks (#9 backpressure diversion) without a full snapshot. */
  inFlightByVassal: Record<string, number>;
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
  /** Real-time in-flight count per vassal (#9 per-vassal saturation primitive). */
  private inFlightByVassal = new Map<string, number>();
  /** Finished records grouped by vassal, maintained incrementally so per-vassal
   *  history accessors do not rebuild from the flat `records` list on every call. */
  private byVassal = new Map<string, BranchRecord[]>();
  /** Latest VassalMetric per vassal, refreshed on branchEnded. */
  private perVassalCache = new Map<string, VassalMetric>();

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

  /**
   * Current queue depth without building a snapshot. Safe to poll from a
   * sampler: snapshot() reallocates per-vassal stats and re-filters records,
   * which is heavy enough to perturb the very run being measured.
   */
  queueDepthNow(): number {
    return this.queueDepth;
  }

  branchStarted(event: BranchMetricEvent): void {
    this.dequeue();
    const key = ConcurrencyMetrics.key(event.intentId, event.runId, event.vassal);
    this.active.set(key, { event, startedMs: this.clock()() });
    this.bumpInFlight(event.vassal, 1);
    if (this.active.size > this.maxInFlight) this.maxInFlight = this.active.size;
  }

  branchEnded(intentId: string, runId: string, vassal: string, outcome: BranchOutcomeKind): void {
    const key = ConcurrencyMetrics.key(intentId, runId, vassal);
    const active = this.active.get(key);
    if (!active) return;
    this.active.delete(key);
    const record: BranchRecord = {
      ...active.event,
      endedAt: this.now().toISOString(),
      latencyMs: this.clock()() - active.startedMs,
      outcome,
    };
    this.records.push(record);
    this.pushByVassal(record);
    this.bumpInFlight(vassal, -1);
  }

  /** Real-time in-flight branches for a single vassal (#9 saturation check). */
  inFlightByVassalNow(vassal: string): number {
    return this.inFlightByVassal.get(vassal) ?? 0;
  }

  /** Historical failure rate for a vassal; 0 when no finished call is recorded. */
  failureRateOf(vassal: string): number {
    return this.perVassalCache.get(vassal)?.failureRate ?? 0;
  }

  /** Historical p50 latency (ms) for a vassal; null when no finished call is recorded. */
  p50MsOf(vassal: string): number | null {
    return this.perVassalCache.get(vassal)?.latency?.p50Ms ?? null;
  }

  private bumpInFlight(vassal: string, delta: number): void {
    const next = (this.inFlightByVassal.get(vassal) ?? 0) + delta;
    if (next <= 0) this.inFlightByVassal.delete(vassal);
    else this.inFlightByVassal.set(vassal, next);
  }

  private pushByVassal(record: BranchRecord): void {
    const list = this.byVassal.get(record.vassal) ?? [];
    list.push(record);
    this.byVassal.set(record.vassal, list);
    this.perVassalCache.set(record.vassal, this.vassalStats(list));
  }

  /** Current in-flight branches (defensive copy). */
  inFlightBranches(): BranchMetricEvent[] {
    return [...this.active.values()].map(({ event }) => ({ ...event }));
  }

  snapshot(): MetricsSnapshot {
    const finished = this.records.filter(record => record.outcome !== undefined);
    const perVassal: Record<string, VassalMetric> = {};
    for (const [vassal, list] of this.byVassal) {
      perVassal[vassal] = this.vassalStats(list);
    }
    const completed = finished.filter(r => r.outcome === 'completed').length;
    const failed = finished.filter(r => r.outcome === 'failed').length;
    const timedOut = finished.filter(r => r.outcome === 'timeout').length;
    const inFlightByVassal: Record<string, number> = {};
    for (const [vassal, count] of this.inFlightByVassal) inFlightByVassal[vassal] = count;
    return {
      inFlight: this.active.size,
      maxInFlight: this.maxInFlight,
      queueDepth: this.queueDepth,
      finished: finished.length,
      completed,
      failed,
      timedOut,
      perVassal,
      inFlightByVassal,
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

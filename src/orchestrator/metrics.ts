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
  /** Canceled by the driver; neither a success nor a failure of the vassal. */
  canceled: number;
  /** failed + timedOut over finished calls that produced a verdict; canceled
   *  calls are excluded from both the numerator and the denominator, so a
   *  driver's cancel never dilutes (or inflates) a vassal's reliability. */
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
  /** Canceled branches. Present so `finished` equals the four outcome buckets. */
  canceled: number;
  perVassal: Record<string, VassalMetric>;
  /** Real-time in-flight count per vassal (defensive copy). Enables per-vassal
   *  saturation checks (#9 backpressure diversion) without a full snapshot. */
  inFlightByVassal: Record<string, number>;
  /** Percentile basis and bound. Counts and failure rates are all-time; only
   *  latency percentiles read the window, and `trimmedBranches` reports what the
   *  window has dropped rather than hiding it. */
  historyWindow: { branchesPerVassal: number; trimmedBranches: number };
  capturedAt: string;
};

export type MetricsOptions = {
  now?: () => Date;
  /** Monotonic millisecond clock for latency; defaults to Date.now. */
  elapsed?: () => number;
  /** How many finished branches per vassal feed the latency percentiles. Counts
   *  and failure rate stay all-time; only percentiles read the window. */
  historyWindowBranches?: number;
};

/** Default percentile window per vassal. Bounded by design: percentiles over the
 *  whole history both report on behaviour from the distant past and were the
 *  reason branch accounting cost more with every finished branch (audit B-44). */
export const DEFAULT_METRICS_HISTORY_WINDOW = 1_000;

/** Per-vassal accounting. Counts are all-time running totals updated in O(1);
 *  latencies are kept only for the percentile window, and the computed stats are
 *  cached and rebuilt on read - never on the write path. */
type VassalTally = {
  calls: number;
  completed: number;
  failed: number;
  timedOut: number;
  canceled: number;
  latencies: number[];
  cached: LatencyStats | null;
  stale: boolean;
};

export class ConcurrencyMetrics {
  private active = new Map<string, { event: BranchMetricEvent; startedMs: number }>();
  private tallies = new Map<string, VassalTally>();
  /** All-time outcome totals, so snapshot() never scans history. */
  private totals = { finished: 0, completed: 0, failed: 0, timedOut: 0, canceled: 0 };
  /** Records dropped from a percentile window - a bound that reports itself. */
  private trimmedBranches = 0;
  private maxInFlight = 0;
  private queueDepth = 0;
  /** Real-time in-flight count per vassal (#9 per-vassal saturation primitive). */
  private inFlightByVassal = new Map<string, number>();
  private readonly historyWindow: number;

  constructor(private options: MetricsOptions = {}) {
    this.historyWindow = options.historyWindowBranches ?? DEFAULT_METRICS_HISTORY_WINDOW;
  }

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
    const alreadyActive = this.active.has(key);
    this.active.set(key, { event, startedMs: this.clock()() });
    // A repeated start for a key that never ended (two branches sharing
    // intentId+runId, e.g. a recycled resume runId) would otherwise leave the
    // vassal permanently in flight: the counter is bumped twice but the single
    // `branchEnded` decrements once, and #9 diversion then reads the vassal as
    // saturated forever. Counting the key once keeps `inFlightByVassal` equal to
    // the live entries in `active`.
    if (!alreadyActive) this.bumpInFlight(event.vassal, 1);
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
    this.tallyBranch(record);
    this.bumpInFlight(vassal, -1);
  }

  /** Real-time in-flight branches for a single vassal (#9 saturation check). */
  inFlightByVassalNow(vassal: string): number {
    return this.inFlightByVassal.get(vassal) ?? 0;
  }

  /** Historical failure rate for a vassal; 0 when no finished call is recorded. */
  failureRateOf(vassal: string): number {
    return this.vassalMetric(vassal)?.failureRate ?? 0;
  }

  /** Historical p50 latency (ms) for a vassal; null when no finished call is recorded. */
  p50MsOf(vassal: string): number | null {
    return this.vassalMetric(vassal)?.latency?.p50Ms ?? null;
  }

  private bumpInFlight(vassal: string, delta: number): void {
    const next = (this.inFlightByVassal.get(vassal) ?? 0) + delta;
    if (next <= 0) this.inFlightByVassal.delete(vassal);
    else this.inFlightByVassal.set(vassal, next);
  }

  /**
   * O(1) per finished branch: counters move, the new latency enters the
   * percentile window, and cached stats are only marked stale. Recomputing
   * percentiles here is what used to make dispatch cost grow with history.
   */
  private tallyBranch(record: BranchRecord): void {
    let tally = this.tallies.get(record.vassal);
    if (!tally) {
      tally = { calls: 0, completed: 0, failed: 0, timedOut: 0, canceled: 0, latencies: [], cached: null, stale: true };
      this.tallies.set(record.vassal, tally);
    }
    tally.calls += 1;
    this.totals.finished += 1;
    if (record.outcome === 'completed') { tally.completed += 1; this.totals.completed += 1; }
    else if (record.outcome === 'failed') { tally.failed += 1; this.totals.failed += 1; }
    else if (record.outcome === 'timeout') { tally.timedOut += 1; this.totals.timedOut += 1; }
    else if (record.outcome === 'canceled') { tally.canceled += 1; this.totals.canceled += 1; }
    if (typeof record.latencyMs === 'number') {
      tally.latencies.push(record.latencyMs);
      tally.cached = null;
      tally.stale = true;
      // Trim in one slice once the window has doubled: the bound then costs
      // amortised O(1) per record instead of a shift() on every one.
      if (tally.latencies.length > this.historyWindow * 2) {
        const dropped = tally.latencies.length - this.historyWindow;
        tally.latencies.splice(0, dropped);
        this.trimmedBranches += dropped;
      }
    }
  }

  /** Current in-flight branches (defensive copy). */
  inFlightBranches(): BranchMetricEvent[] {
    return [...this.active.values()].map(({ event }) => ({ ...event }));
  }

  snapshot(): MetricsSnapshot {
    const perVassal: Record<string, VassalMetric> = {};
    for (const [vassal, tally] of this.tallies) perVassal[vassal] = this.toMetric(tally);
    const inFlightByVassal: Record<string, number> = {};
    for (const [vassal, count] of this.inFlightByVassal) inFlightByVassal[vassal] = count;
    return {
      inFlight: this.active.size,
      maxInFlight: this.maxInFlight,
      queueDepth: this.queueDepth,
      finished: this.totals.finished,
      completed: this.totals.completed,
      failed: this.totals.failed,
      timedOut: this.totals.timedOut,
      canceled: this.totals.canceled,
      perVassal,
      inFlightByVassal,
      historyWindow: { branchesPerVassal: this.historyWindow, trimmedBranches: this.trimmedBranches },
      capturedAt: this.now().toISOString(),
    };
  }

  private vassalMetric(vassal: string): VassalMetric | undefined {
    const tally = this.tallies.get(vassal);
    return tally ? this.toMetric(tally) : undefined;
  }

  private toMetric(tally: VassalTally): VassalMetric {
    if (tally.stale || tally.cached === null) {
      const sorted = [...tally.latencies].sort((a, b) => a - b);
      tally.cached = sorted.length ? latencyStats(sorted) : null;
      tally.stale = false;
    }
    // Canceled calls are excluded from the rate: the driver's decision to cancel
    // is not evidence about the vassal, and #9 diversion scores on this value.
    const verdicts = tally.failed + tally.timedOut + tally.completed;
    return {
      calls: tally.calls,
      completed: tally.completed,
      failed: tally.failed,
      timedOut: tally.timedOut,
      canceled: tally.canceled,
      failureRate: verdicts ? (tally.failed + tally.timedOut) / verdicts : 0,
      latency: tally.cached,
    };
  }
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const index = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, index))]!;
}

function latencyStats(sortedAsc: number[]): LatencyStats {
  // Callers guard non-empty before invoking (latency: latencies.length ? ... : null).
  const sum = sortedAsc.reduce((a, b) => a + b, 0);
  return {
    count: sortedAsc.length,
    minMs: sortedAsc[0]!,
    maxMs: sortedAsc[sortedAsc.length - 1]!,
    avgMs: sum / sortedAsc.length,
    p50Ms: percentile(sortedAsc, 50),
    p95Ms: percentile(sortedAsc, 95),
  };
}

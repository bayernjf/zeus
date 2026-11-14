/**
 * E1.7 in-process concurrency metrics (library surface only; no HTTP endpoint —
 * that arrives with the long-running H2 transport). The Orchestrator reports
 * branch lifecycle events; this collector turns them into a queryable snapshot:
 * in-flight count, observed concurrency peak, per-executor latency and failure
 * rate, and queue depth.
 *
 * Queue depth counts branches submitted but not yet started. With no concurrency
 * cap configured the runtime still dispatches every branch at once, so depth stays
 * 0; once `maxConcurrentBranches` is set it reports the real wait line.
 */

export type BranchOutcomeKind = 'completed' | 'failed' | 'timeout' | 'canceled';

export type BranchMetricEvent = {
  intentId: string;
  runId: string;
  executor: string;
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

export type ExecutorMetric = {
  calls: number;
  completed: number;
  failed: number;
  timedOut: number;
  /** Canceled by the operator; neither a success nor a failure of the executor. */
  canceled: number;
  /** failed + timedOut over finished calls that produced a verdict; canceled
   *  calls are excluded from both the numerator and the denominator, so a
   *  operator's cancel never dilutes (or inflates) a executor's reliability. */
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
  /** Highest submitted-but-not-started backlog observed. This includes
   *  branches that acquire a slot immediately, so it tracks burst size rather
   *  than wait-line length; use `refused` and `queueWait` for the cap's effect. */
  queuedPeak: number;
  /** Branches refused because the queue limit was reached. They never start,
   *  so they are not part of `finished`; a nonzero value means backpressure
   *  started rejecting work rather than merely delaying it. */
  refused: number;
  /** Branches auto-diverted from a saturated executor (#9). */
  diverted: number;
  finished: number;
  completed: number;
  failed: number;
  timedOut: number;
  /** Canceled branches. Present so `finished` equals the four outcome buckets. */
  canceled: number;
  perExecutor: Record<string, ExecutorMetric>;
  /** Real-time in-flight count per executor (defensive copy). Enables per-executor
   *  saturation checks (#9 backpressure diversion) without a full snapshot. */
  inFlightByExecutor: Record<string, number>;
  /** Time a branch spent waiting for a slot, over the same percentile window.
   *  Null until a queued branch has started. Separates queue delay from
   *  dispatch latency when calibrating a cap: growing wait means the cap binds. */
  queueWait: LatencyStats | null;
  /** Percentile basis and bound. Counts and failure rates are all-time; only
   *  latency percentiles read the window, and `trimmedBranches` reports what the
   *  window has dropped rather than hiding it. */
  historyWindow: { branchesPerExecutor: number; trimmedBranches: number; trimmedQueueWaits: number };
  capturedAt: string;
};

export type MetricsOptions = {
  now?: () => Date;
  /** Monotonic millisecond clock for latency; defaults to Date.now. */
  elapsed?: () => number;
  /** How many finished branches per executor feed the latency percentiles. Counts
   *  and failure rate stay all-time; only percentiles read the window. */
  historyWindowBranches?: number;
};

/** Default percentile window per executor. Bounded by design: percentiles over the
 *  whole history both report on behaviour from the distant past and were the
 *  reason branch accounting cost more with every finished branch (audit B-44). */
export const DEFAULT_METRICS_HISTORY_WINDOW = 1_000;

/** Per-executor accounting. Counts are all-time running totals updated in O(1);
 *  latencies are kept only for the percentile window, and the computed stats are
 *  cached and rebuilt on read - never on the write path. */
type ExecutorTally = {
  calls: number;
  completed: number;
  failed: number;
  timedOut: number;
  canceled: number;
  latencies: number[];
  cached: LatencyStats | null;
  stale: boolean;
};

export type BranchKeyEvent = Pick<BranchMetricEvent, 'intentId' | 'runId' | 'executor'>;

export class ConcurrencyMetrics {
  private active = new Map<string, { event: BranchMetricEvent; startedMs: number }>();
  private tallies = new Map<string, ExecutorTally>();
  /** All-time outcome totals, so snapshot() never scans history. */
  private totals = { finished: 0, completed: 0, failed: 0, timedOut: 0, canceled: 0 };
  /** Records dropped from a percentile window - a bound that reports itself. */
  private trimmedBranches = 0;
  private maxInFlight = 0;
  private queueDepth = 0;
  private queuedPeak = 0;
  private refused = 0;
  private diverted = 0;
  /** Monotonic enqueue time per branch key, for queue-wait measurement. */
  private queuedAt = new Map<string, number>();
  /** Queue waits over the percentile window (bounded like per-executor latency). */
  private queueWaits: number[] = [];
  private queueWaitStats: LatencyStats | null = null;
  private queueWaitStale = true;
  private trimmedQueueWaits = 0;
  /** Real-time in-flight count per executor (#9 per-executor saturation primitive). */
  private inFlightByExecutor = new Map<string, number>();
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

  private static key(intentId: string, runId: string, executor: string): string {
    return `${intentId}:${runId}:${executor}`;
  }

  /** A branch is queued for dispatch but has not started yet. Passing the
   *  branch key starts the queue-wait clock, so `branchStarted` can report how
   *  long the cap actually delayed it. */
  enqueue(event?: BranchKeyEvent): void {
    this.queueDepth += 1;
    if (this.queueDepth > this.queuedPeak) this.queuedPeak = this.queueDepth;
    if (event) this.queuedAt.set(ConcurrencyMetrics.key(event.intentId, event.runId, event.executor), this.clock()());
  }

  /** A queued branch left the line without starting (gave up or was refused). */
  dequeue(event?: BranchKeyEvent): void {
    this.queueDepth = Math.max(0, this.queueDepth - 1);
    if (event) this.queuedAt.delete(ConcurrencyMetrics.key(event.intentId, event.runId, event.executor));
  }

  /** A branch left the line because the queue limit was reached; it never
   *  starts, so it is counted separately from finished outcomes. */
  refuse(event?: BranchKeyEvent): void {
    this.dequeue(event);
    this.refused += 1;
  }

  /** A branch was auto-diverted from a saturated executor (#9). */
  recordDiversion(): void {
    this.diverted += 1;
  }

  /**
   * Current queue depth without building a snapshot. Safe to poll from a
   * sampler: snapshot() reallocates per-executor stats and re-filters records,
   * which is heavy enough to perturb the very run being measured.
   */
  queueDepthNow(): number {
    return this.queueDepth;
  }

  branchStarted(event: BranchMetricEvent): void {
    const key = ConcurrencyMetrics.key(event.intentId, event.runId, event.executor);
    const at = this.clock()();
    const queuedMs = this.queuedAt.get(key);
    if (queuedMs !== undefined) {
      this.queuedAt.delete(key);
      this.recordQueueWait(at - queuedMs);
    }
    this.dequeue();
    const alreadyActive = this.active.has(key);
    this.active.set(key, { event, startedMs: at });
    // A repeated start for a key that never ended (two branches sharing
    // intentId+runId, e.g. a recycled resume runId) would otherwise leave the
    // executor permanently in flight: the counter is bumped twice but the single
    // `branchEnded` decrements once, and #9 diversion then reads the executor as
    // saturated forever. Counting the key once keeps `inFlightByExecutor` equal to
    // the live entries in `active`.
    if (!alreadyActive) this.bumpInFlight(event.executor, 1);
    if (this.active.size > this.maxInFlight) this.maxInFlight = this.active.size;
  }

  branchEnded(intentId: string, runId: string, executor: string, outcome: BranchOutcomeKind): void {
    const key = ConcurrencyMetrics.key(intentId, runId, executor);
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
    this.bumpInFlight(executor, -1);
  }

  /** Real-time in-flight branches for a single executor (#9 saturation check). */
  inFlightByExecutorNow(executor: string): number {
    return this.inFlightByExecutor.get(executor) ?? 0;
  }

  /** Historical failure rate for a executor; 0 when no finished call is recorded. */
  failureRateOf(executor: string): number {
    return this.executorMetric(executor)?.failureRate ?? 0;
  }

  /** Historical p50 latency (ms) for a executor; null when no finished call is recorded. */
  p50MsOf(executor: string): number | null {
    return this.executorMetric(executor)?.latency?.p50Ms ?? null;
  }

  private bumpInFlight(executor: string, delta: number): void {
    const next = (this.inFlightByExecutor.get(executor) ?? 0) + delta;
    if (next <= 0) this.inFlightByExecutor.delete(executor);
    else this.inFlightByExecutor.set(executor, next);
  }

  private recordQueueWait(waitMs: number): void {
    this.queueWaits.push(waitMs);
    this.queueWaitStats = null;
    this.queueWaitStale = true;
    // Same amortised bound as per-executor latency: slice once the window has
    // doubled, so the write path stays O(1).
    if (this.queueWaits.length > this.historyWindow * 2) {
      const dropped = this.queueWaits.length - this.historyWindow;
      this.queueWaits.splice(0, dropped);
      this.trimmedQueueWaits += dropped;
    }
  }

  /**
   * O(1) per finished branch: counters move, the new latency enters the
   * percentile window, and cached stats are only marked stale. Recomputing
   * percentiles here is what used to make dispatch cost grow with history.
   */
  private tallyBranch(record: BranchRecord): void {
    let tally = this.tallies.get(record.executor);
    if (!tally) {
      tally = { calls: 0, completed: 0, failed: 0, timedOut: 0, canceled: 0, latencies: [], cached: null, stale: true };
      this.tallies.set(record.executor, tally);
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
    const perExecutor: Record<string, ExecutorMetric> = {};
    for (const [executor, tally] of this.tallies) perExecutor[executor] = this.toMetric(tally);
    const inFlightByExecutor: Record<string, number> = {};
    for (const [executor, count] of this.inFlightByExecutor) inFlightByExecutor[executor] = count;
    return {
      inFlight: this.active.size,
      maxInFlight: this.maxInFlight,
      queueDepth: this.queueDepth,
      queuedPeak: this.queuedPeak,
      refused: this.refused,
      diverted: this.diverted,
      finished: this.totals.finished,
      completed: this.totals.completed,
      failed: this.totals.failed,
      timedOut: this.totals.timedOut,
      canceled: this.totals.canceled,
      perExecutor,
      inFlightByExecutor,
      queueWait: this.queueWaitSnapshot(),
      historyWindow: {
        branchesPerExecutor: this.historyWindow,
        trimmedBranches: this.trimmedBranches,
        trimmedQueueWaits: this.trimmedQueueWaits,
      },
      capturedAt: this.now().toISOString(),
    };
  }

  private queueWaitSnapshot(): LatencyStats | null {
    if (this.queueWaits.length === 0) return null;
    if (this.queueWaitStale || this.queueWaitStats === null) {
      this.queueWaitStats = latencyStats([...this.queueWaits].sort((a, b) => a - b));
      this.queueWaitStale = false;
    }
    return this.queueWaitStats;
  }

  private executorMetric(executor: string): ExecutorMetric | undefined {
    const tally = this.tallies.get(executor);
    return tally ? this.toMetric(tally) : undefined;
  }

  private toMetric(tally: ExecutorTally): ExecutorMetric {
    if (tally.stale || tally.cached === null) {
      const sorted = [...tally.latencies].sort((a, b) => a - b);
      tally.cached = sorted.length ? latencyStats(sorted) : null;
      tally.stale = false;
    }
    // Canceled calls are excluded from the rate: the operator's decision to cancel
    // is not evidence about the executor, and #9 diversion scores on this value.
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

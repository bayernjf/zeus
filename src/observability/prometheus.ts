import type { LatencyStats, MetricsSnapshot } from '../core/orchestrator/metrics.js';

/**
 * Prometheus text exposition (format 0.0.4) for a ConcurrencyMetrics snapshot.
 *
 * The bearer JSON face (/api/metrics) answers an operator; this one answers a
 * scraper. It is a pure projection of the same snapshot - no second accounting
 * path, no new events - so the two faces can never disagree about a number.
 *
 * Every family carries the `zeus_` prefix: the Tier0 collector scrapes several
 * services into one Prometheus, and an unprefixed `calls_total` would collide
 * with a sibling's series rather than sit beside it.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Percentile basis is a bounded window, not all time; the sample count travels
 *  with the percentiles so a reader can tell a p95 over 3 branches from one over
 *  1000. `stat` keeps the five window statistics in one family instead of five
 *  near-identical names. */
const LATENCY_STATS = ['min', 'max', 'avg', 'p50', 'p95'] as const;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

/** One exposition block: HELP, TYPE, then every sample of the family. A family
 *  with no samples is omitted entirely - an empty HELP/TYPE pair is legal but
 *  tells a reader a metric exists when this runtime has nothing to say about it. */
class Family {
  private readonly samples: string[] = [];

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly type: 'gauge' | 'counter',
  ) {}

  add(value: number, pairs: ReadonlyArray<readonly [string, string]> = []): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(`${this.name}${labels(pairs)} ${value}`);
  }

  render(): string {
    if (this.samples.length === 0) return '';
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n${this.samples.join('\n')}\n`;
  }
}

function latencyInto(family: Family, stats: LatencyStats | null, pairs: ReadonlyArray<readonly [string, string]>): void {
  if (!stats) return;
  const values: Record<(typeof LATENCY_STATS)[number], number> = {
    min: stats.minMs,
    max: stats.maxMs,
    avg: stats.avgMs,
    p50: stats.p50Ms,
    p95: stats.p95Ms,
  };
  for (const stat of LATENCY_STATS) family.add(values[stat], [...pairs, ['stat', stat]]);
}

export function renderPrometheusMetrics(snapshot: MetricsSnapshot, options: { version?: string } = {}): string {
  const blocks: string[] = [];
  const push = (family: Family): void => {
    const text = family.render();
    if (text) blocks.push(text);
  };

  // In-band liveness, mirroring atlas_up: the collector's own `up` series says
  // the scrape worked, this says the runtime answered with a snapshot.
  const up = new Family('zeus_up', 'Always 1 while the runtime serves a metrics snapshot.', 'gauge');
  up.add(1);
  push(up);

  if (options.version !== undefined) {
    const build = new Family('zeus_build_info', 'Runtime version, as a constant 1 series labelled by version.', 'gauge');
    build.add(1, [['version', options.version]]);
    push(build);
  }

  const capturedAtSeconds = Date.parse(snapshot.capturedAt) / 1000;
  const captured = new Family(
    'zeus_metrics_snapshot_timestamp_seconds',
    'Unix time the snapshot was captured; a stale value means the window stopped advancing.',
    'gauge',
  );
  captured.add(capturedAtSeconds);
  push(captured);

  const inFlight = new Family('zeus_branches_in_flight', 'Branches started but not ended.', 'gauge');
  inFlight.add(snapshot.inFlight);
  push(inFlight);

  const inFlightMax = new Family('zeus_branches_in_flight_max', 'Highest concurrently in-flight branches observed.', 'gauge');
  inFlightMax.add(snapshot.maxInFlight);
  push(inFlightMax);

  const queueDepth = new Family('zeus_branches_queue_depth', 'Branches submitted but not started; 0 without a concurrency cap.', 'gauge');
  queueDepth.add(snapshot.queueDepth);
  push(queueDepth);

  const queuedPeak = new Family(
    'zeus_branches_queue_depth_peak',
    'Highest submitted-but-not-started backlog observed; tracks burst size, not wait-line length.',
    'gauge',
  );
  queuedPeak.add(snapshot.queuedPeak);
  push(queuedPeak);

  const totals: Array<[string, number, string]> = [
    ['zeus_branches_refused_total', snapshot.refused, 'Branches refused because the queue limit was reached; they never started.'],
    ['zeus_branches_diverted_total', snapshot.diverted, 'Branches auto-diverted away from a saturated executor.'],
    ['zeus_branches_finished_total', snapshot.finished, 'Branches that reached an outcome; equals the four outcome buckets.'],
    ['zeus_branches_completed_total', snapshot.completed, 'Branches that completed successfully.'],
    ['zeus_branches_failed_total', snapshot.failed, 'Branches that failed.'],
    ['zeus_branches_timed_out_total', snapshot.timedOut, 'Branches that timed out.'],
    ['zeus_branches_canceled_total', snapshot.canceled, 'Branches canceled by an operator; neither a success nor a failure.'],
  ];
  for (const [name, value, help] of totals) {
    const family = new Family(name, help, 'counter');
    family.add(value);
    push(family);
  }

  // Union of both maps: an executor can be in flight before it appears in the
  // finished-call tally, and dropping it would hide the saturation it causes.
  const executors = [...new Set([...Object.keys(snapshot.perExecutor), ...Object.keys(snapshot.inFlightByExecutor)])].sort();

  const calls = new Family('zeus_executor_calls_total', 'Branches dispatched to the executor, all time.', 'counter');
  const completed = new Family('zeus_executor_completed_total', 'Branches the executor completed, all time.', 'counter');
  const failed = new Family('zeus_executor_failed_total', 'Branches the executor failed, all time.', 'counter');
  const timedOut = new Family('zeus_executor_timed_out_total', 'Branches the executor timed out on, all time.', 'counter');
  const canceled = new Family('zeus_executor_canceled_total', 'Branches canceled before the executor produced a verdict, all time.', 'counter');
  const failureRate = new Family(
    'zeus_executor_failure_rate',
    'failed + timedOut over finished calls that produced a verdict; canceled calls are excluded from both terms.',
    'gauge',
  );
  const executorInFlight = new Family('zeus_executor_in_flight', 'Branches currently in flight on the executor.', 'gauge');
  const latency = new Family(
    'zeus_executor_latency_ms',
    'Dispatch latency over the bounded percentile window, in milliseconds, by statistic.',
    'gauge',
  );
  const samples = new Family('zeus_executor_latency_samples', 'Finished branches feeding the executor latency percentiles.', 'gauge');

  for (const executor of executors) {
    const pairs = [['executor', executor]] as const;
    const metric = snapshot.perExecutor[executor];
    if (metric) {
      calls.add(metric.calls, pairs);
      completed.add(metric.completed, pairs);
      failed.add(metric.failed, pairs);
      timedOut.add(metric.timedOut, pairs);
      canceled.add(metric.canceled, pairs);
      failureRate.add(metric.failureRate, pairs);
      latencyInto(latency, metric.latency, pairs);
      if (metric.latency) samples.add(metric.latency.count, pairs);
    }
    executorInFlight.add(snapshot.inFlightByExecutor[executor] ?? 0, pairs);
  }
  for (const family of [calls, completed, failed, timedOut, canceled, failureRate, executorInFlight, latency, samples]) push(family);

  const queueWait = new Family(
    'zeus_queue_wait_ms',
    'Time a branch waited for a concurrency slot, over the percentile window, in milliseconds, by statistic.',
    'gauge',
  );
  latencyInto(queueWait, snapshot.queueWait, []);
  push(queueWait);

  const window = new Family(
    'zeus_metrics_window_branches_per_executor',
    'Percentile window bound: finished branches kept per executor.',
    'gauge',
  );
  window.add(snapshot.historyWindow.branchesPerExecutor);
  push(window);

  const trimmedBranches = new Family('zeus_metrics_trimmed_branches_total', 'Branch latencies dropped from the percentile window.', 'counter');
  trimmedBranches.add(snapshot.historyWindow.trimmedBranches);
  push(trimmedBranches);

  const trimmedQueueWaits = new Family('zeus_metrics_trimmed_queue_waits_total', 'Queue waits dropped from the percentile window.', 'counter');
  trimmedQueueWaits.add(snapshot.historyWindow.trimmedQueueWaits);
  push(trimmedQueueWaits);

  return blocks.join('\n');
}
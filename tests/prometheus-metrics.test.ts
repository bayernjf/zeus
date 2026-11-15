import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { ConcurrencyMetrics } from '../src/core/orchestrator/metrics.js';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheusMetrics } from '../src/observability/prometheus.js';
import type { MetricsSnapshot } from '../src/core/orchestrator/metrics.js';

const OPERATOR_TOKEN = 'operator-secret';
const SCRAPE_TOKEN = 'scraper-secret';

/**
 * A strict reader for the exposition format, not a substring search: the point
 * of the scraper face is that Prometheus can parse it, so the tests parse it the
 * same way and reject anything a real scraper would. Every family must declare
 * HELP and TYPE before its samples, names must be a legal metric name, and a
 * sample line must be `name{labels} value` with a finite value.
 */
type Sample = { name: string; labels: Record<string, string>; value: number };

function parseExposition(text: string): { samples: Sample[]; families: Map<string, string> } {
  const samples: Sample[] = [];
  const families = new Map<string, string>();
  const declared = new Map<string, { help: boolean; type: string }>();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    // Families are separated by a blank line for readability; expfmt (what the
    // OTel collector's prometheus receiver uses) skips empty lines.
    if (line === '') continue;
    if (line.startsWith('# HELP ')) {
      const name = line.slice(7).split(' ')[0]!;
      expect(declared.has(name), `HELP twice for ${name}`).toBe(false);
      declared.set(name, { help: true, type: '' });
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const [name, type] = line.slice(7).split(' ');
      const entry = declared.get(name!);
      expect(entry, `TYPE without HELP for ${name}`).toBeTruthy();
      expect(entry!.help, `TYPE before HELP for ${name}`).toBe(true);
      entry!.type = type!;
      expect(['gauge', 'counter', 'summary', 'histogram', 'untyped']).toContain(type);
      continue;
    }
    expect(line.startsWith('#'), `unexpected comment: ${line}`).toBe(false);
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?[0-9.eE+]+|NaN|\+Inf|-Inf)$/.exec(line);
    expect(match, `not a legal sample line: ${line}`).not.toBeNull();
    const name = match![1]!;
    const entry = declared.get(name);
    expect(entry, `sample for undeclared family ${name}`).toBeTruthy();
    expect(entry!.type, `family ${name} has no TYPE`).not.toBe('');
    const labels: Record<string, string> = {};
    if (match![2]) {
      const inner = match![2]!.slice(1, -1);
      // Label values may contain escaped quotes, so split on commas that are
      // not inside a quoted value rather than on every comma.
      const pairs = inner.match(/[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"(?:,|$)/g) ?? [];
      expect(pairs.length, `label block is not a comma list of quoted pairs: ${inner}`).toBeGreaterThan(0);
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        const key = pair.slice(0, eq);
        const raw = pair.slice(eq + 1).replace(/,$/, '');
        expect(raw.startsWith('"') && raw.endsWith('"'), `unquoted label value: ${pair}`).toBe(true);
        labels[key] = raw.slice(1, -1).replace(/\\(.)/g, (_all, char: string) => (char === 'n' ? '\n' : char));
      }
      expect(inner.endsWith(','), `trailing comma in labels: ${inner}`).toBe(false);
    }
    const value = Number(match![3]);
    expect(Number.isFinite(value), `non-finite sample value: ${line}`).toBe(true);
    samples.push({ name, labels, value });
    families.set(name, entry!.type);
  }
  for (const [name, entry] of declared) {
    expect(samples.some(s => s.name === name), `family ${name} declared but never sampled`).toBe(true);
    expect(entry.type, `family ${name} never got a TYPE`).not.toBe('');
  }
  return { samples, families };
}

function valueOf(samples: Sample[], name: string, labels: Record<string, string> = {}): number | undefined {
  return samples.find(s => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;
}

/** A snapshot produced by the real collector, not a hand-written literal: the
 *  window/trim fields and the failure-rate denominator are computed there, and
 *  a literal would only prove the renderer echoes what I typed. */
function realSnapshot(): { metrics: ConcurrencyMetrics; snapshot: MetricsSnapshot } {
  const metrics = new ConcurrencyMetrics({ now: () => new Date('2026-11-15T00:00:00.000Z') });
  const event = (executor: string, runId: string) => ({
    intentId: 'intent-1',
    runId,
    executor,
    skill: 'research',
    startedAt: '2026-11-15T00:00:00.000Z',
  });
  metrics.branchStarted(event('loom', 'r1'));
  metrics.branchEnded('intent-1', 'r1', 'loom', 'completed');
  metrics.branchStarted(event('atlas', 'r2'));
  metrics.branchEnded('intent-1', 'r2', 'atlas', 'failed');
  metrics.branchStarted(event('atlas', 'r3'));
  metrics.branchEnded('intent-1', 'r3', 'atlas', 'timeout');
  metrics.branchStarted(event('choice', 'r4'));
  metrics.branchEnded('intent-1', 'r4', 'choice', 'canceled');
  metrics.refuse();
  metrics.recordDiversion();
  // Still in flight, and never finished: exercises the in-flight-only executor
  // path and the "no latency samples yet" branch.
  metrics.branchStarted(event('inflight-only', 'r5'));
  return { metrics, snapshot: metrics.snapshot() };
}

describe('Prometheus exposition — projection of the metrics snapshot', () => {
  it('parses a known-good exposition and rejects a malformed one (positive control)', () => {
    const good = parseExposition('# HELP x_up Always 1.\n# TYPE x_up gauge\nx_up 1\n');
    expect(good.samples).toEqual([{ name: 'x_up', labels: {}, value: 1 }]);
    expect(() => parseExposition('# HELP x_up Always 1.\nx_up 1\n')).toThrow();
    expect(() => parseExposition('# TYPE x_up gauge\nx_up 1\n')).toThrow();
    expect(() => parseExposition('# HELP x_up Always 1.\n# TYPE x_up gauge\nx_up not-a-number\n')).toThrow();
    expect(() => parseExposition('# HELP x_up Always 1.\n# TYPE x_up gauge\nx_up{a=unquoted} 1\n')).toThrow();
  });

  it('renders a legal, fully declared exposition from a real collector snapshot', () => {
    const { snapshot } = realSnapshot();
    const text = renderPrometheusMetrics(snapshot, { version: '9.9.9' });
    const { samples, families } = parseExposition(text);
    expect(samples.length).toBeGreaterThan(30);
    for (const name of families.keys()) expect(name.startsWith('zeus_'), `unprefixed family ${name}`).toBe(true);
    expect(valueOf(samples, 'zeus_up')).toBe(1);
    expect(valueOf(samples, 'zeus_build_info', { version: '9.9.9' })).toBe(1);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('is deterministic: the same snapshot renders byte-identical text twice', () => {
    const { snapshot } = realSnapshot();
    expect(renderPrometheusMetrics(snapshot)).toBe(renderPrometheusMetrics(snapshot));
  });

  it('carries the same numbers as the JSON face, including the failure-rate denominator', () => {
    const { snapshot } = realSnapshot();
    const { samples } = parseExposition(renderPrometheusMetrics(snapshot));
    expect(valueOf(samples, 'zeus_branches_finished_total')).toBe(snapshot.finished);
    expect(valueOf(samples, 'zeus_branches_completed_total')).toBe(snapshot.completed);
    expect(valueOf(samples, 'zeus_branches_failed_total')).toBe(snapshot.failed);
    expect(valueOf(samples, 'zeus_branches_timed_out_total')).toBe(snapshot.timedOut);
    expect(valueOf(samples, 'zeus_branches_canceled_total')).toBe(snapshot.canceled);
    expect(valueOf(samples, 'zeus_branches_refused_total')).toBe(snapshot.refused);
    expect(valueOf(samples, 'zeus_branches_diverted_total')).toBe(snapshot.diverted);
    expect(valueOf(samples, 'zeus_branches_in_flight')).toBe(snapshot.inFlight);
    // atlas: one failed + one timeout over two verdicts; the canceled choice
    // branch must not dilute it.
    expect(valueOf(samples, 'zeus_executor_failure_rate', { executor: 'atlas' })).toBe(1);
    expect(valueOf(samples, 'zeus_executor_failure_rate', { executor: 'choice' })).toBe(0);
    expect(valueOf(samples, 'zeus_executor_calls_total', { executor: 'loom' })).toBe(1);
    expect(valueOf(samples, 'zeus_metrics_snapshot_timestamp_seconds')).toBe(Date.parse(snapshot.capturedAt) / 1000);
  });

  it('reports an executor that is in flight but has never finished a branch', () => {
    const { snapshot } = realSnapshot();
    const { samples } = parseExposition(renderPrometheusMetrics(snapshot));
    expect(valueOf(samples, 'zeus_executor_in_flight', { executor: 'inflight-only' })).toBe(1);
    // No finished call means no percentile basis: inventing a 0ms p95 would
    // read as "instant" rather than "unknown".
    expect(samples.some(s => s.name === 'zeus_executor_latency_ms' && s.labels.executor === 'inflight-only')).toBe(false);
    expect(samples.some(s => s.name === 'zeus_executor_latency_samples' && s.labels.executor === 'inflight-only')).toBe(false);
  });

  it('escapes executor names so a quote or newline cannot forge a sample line', () => {
    const metrics = new ConcurrencyMetrics();
    const nasty = 'we"ird\\name\n# HELP injected 1';
    metrics.branchStarted({ intentId: 'i', runId: 'r', executor: nasty, skill: 's', startedAt: '2026-11-15T00:00:00.000Z' });
    metrics.branchEnded('i', 'r', nasty, 'completed');
    const text = renderPrometheusMetrics(metrics.snapshot());
    // The hostile text may legitimately appear *inside* a quoted label value;
    // what must never happen is it starting a line, where a scraper would read
    // it as a new metric family.
    const lines = text.split('\n');
    expect(lines.some(line => line.startsWith('# HELP injected'))).toBe(false);
    for (const line of lines.filter(l => l.includes('injected'))) {
      expect(line.startsWith('zeus_executor_'), `hostile text escaped its label: ${line}`).toBe(true);
    }
    const { samples } = parseExposition(text);
    expect(valueOf(samples, 'zeus_executor_calls_total', { executor: nasty })).toBe(1);
  });

  it('omits the build-info family when no version is known, rather than labelling it empty', () => {
    const { snapshot } = realSnapshot();
    const { samples } = parseExposition(renderPrometheusMetrics(snapshot));
    expect(samples.some(s => s.name === 'zeus_build_info')).toBe(false);
  });

  it('omits the snapshot timestamp when capturedAt is unparseable instead of emitting NaN', () => {
    const { snapshot } = realSnapshot();
    const { samples } = parseExposition(renderPrometheusMetrics({ ...snapshot, capturedAt: 'not-a-date' }));
    expect(samples.some(s => s.name === 'zeus_metrics_snapshot_timestamp_seconds')).toBe(false);
    expect(valueOf(samples, 'zeus_up')).toBe(1);
  });

  it('sorts executors so series order does not depend on registration order', () => {
    const metrics = new ConcurrencyMetrics();
    for (const executor of ['zeta', 'alpha', 'mid']) {
      metrics.branchStarted({ intentId: 'i', runId: executor, executor, skill: 's', startedAt: '2026-11-15T00:00:00.000Z' });
      metrics.branchEnded('i', executor, executor, 'completed');
    }
    const text = renderPrometheusMetrics(metrics.snapshot());
    const order = [...text.matchAll(/zeus_executor_calls_total\{executor="([^"]+)"\}/g)].map(m => m[1]);
    expect(order).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('GET /metrics — scraper face', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const base = () => ({
    registry: new ExecutorRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    metrics: new ConcurrencyMetrics(),
  });

  it('is mounted without an operator token, unlike the bearer JSON face', async () => {
    app = await createHttpServer(base());
    const scrape = await app.inject({ method: 'GET', url: '/metrics' });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    parseExposition(scrape.body);
    // The operator face stays shut: the scraper credential is not the operator one.
    expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(404);
  });

  it('is not mounted when the runtime has no metrics collector', async () => {
    app = await createHttpServer({ registry: new ExecutorRegistry(), signer: new Ed25519MemorySigner('k') });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
  });

  it('is open when no scrape token is configured', async () => {
    app = await createHttpServer(base());
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('challenges a missing token and rejects a wrong one, without leaking which', async () => {
    app = await createHttpServer({ ...base(), metricsToken: SCRAPE_TOKEN });
    const missing = await app.inject({ method: 'GET', url: '/metrics' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    const wrong = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(wrong.body).not.toContain(SCRAPE_TOKEN);
  });

  it('does not accept the operator token as a scrape credential', async () => {
    app = await createHttpServer({ ...base(), internalToken: OPERATOR_TOKEN, metricsToken: SCRAPE_TOKEN });
    const operator = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(operator.statusCode).toBe(401);
    const scrape = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${SCRAPE_TOKEN}` } });
    expect(scrape.statusCode).toBe(200);
  });

  it('serves the same snapshot the JSON face serves, after real branch accounting', async () => {
    const { metrics } = realSnapshot();
    app = await createHttpServer({ ...base(), metrics, internalToken: OPERATOR_TOKEN });
    const scrape = await app.inject({ method: 'GET', url: '/metrics' });
    const json = await app.inject({ method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(scrape.statusCode).toBe(200);
    expect(json.statusCode).toBe(200);
    const snapshot = json.json() as MetricsSnapshot;
    const { samples } = parseExposition(scrape.body);
    // Both faces read one snapshot; a second accounting path would show up here
    // as a number that disagrees with the JSON the operator already trusts.
    expect(valueOf(samples, 'zeus_branches_finished_total')).toBe(snapshot.finished);
    expect(valueOf(samples, 'zeus_branches_in_flight')).toBe(snapshot.inFlight);
    for (const [executor, metric] of Object.entries(snapshot.perExecutor)) {
      expect(valueOf(samples, 'zeus_executor_calls_total', { executor })).toBe(metric.calls);
      expect(valueOf(samples, 'zeus_executor_failure_rate', { executor })).toBe(metric.failureRate);
    }
  });
});
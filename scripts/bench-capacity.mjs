#!/usr/bin/env node
/**
 * E10.4 local capacity baseline harness (PRD E10.4).
 *
 * Drives the *real* kernel stack — Orchestrator -> Dispatcher -> global fetch
 * (undici) -> loopback HTTP — against a farm of mock A2A vassals served by one
 * node:http server. Every vassal answers tasks/sendSubscribe with an SSE stream
 * and a fixed, configurable think delay, so fan-out width, concurrent intents
 * and latency percentiles are measured end to end without any external deploy.
 *
 * Honest scope: these are mock-vassal loopback numbers. They bound the kernel's
 * fan-out/merge/aggregation overhead and Node's client concurrency, not real
 * vassal capacity (LLM latency, network RTT, auth). Scenario E measures the
 * E1.5 concurrency gate itself; which vassal an overflow branch should be
 * re-routed to remains deferred (#9, gated on >=3 real vassals).
 *
 * Usage:
 *   npm run build && node scripts/bench-capacity.mjs           # human table
 *   node scripts/bench-capacity.mjs --json                     # machine JSON
 *   node scripts/bench-capacity.mjs --delay-ms 50 --reps 7
 *   node scripts/bench-capacity.mjs --cap 16                   # one gate level only
 */
import http from 'node:http';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { VassalRegistry } from '../dist/registry/registry.js';
import { Dispatcher } from '../dist/dispatch/dispatcher.js';
import { Orchestrator } from '../dist/orchestrator/orchestrator.js';
import { ConcurrencyMetrics } from '../dist/orchestrator/metrics.js';
import { createHttpServer } from '../dist/http/server.js';
import { Ed25519MemorySigner } from '../dist/registry/signing.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const argNumber = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? Number(args[idx + 1]) : fallback;
};
const delayMs = argNumber('--delay-ms', 50);
const reps = argNumber('--reps', 7);
const FARM_SIZE = argNumber('--farm', 64);
const widths = [1, 2, 4, 8, 16, 32, 64].filter(w => w <= FARM_SIZE);
const concurrencyLevels = [1, 4, 8, 16, 32];
const cancelLevels = [4, 8, 16, 32];
// Scenario E measures the E1.5 concurrency gate. It is opt-in with --cap
// because it adds 4 x 128 branches of load inside the same process as the mock
// farm, and that farm shares one event loop with the kernel: at default reps it
// pushes tail branches past the 20x think-delay timeout. Run `--cap` (or
// `--cap 16`) when you specifically want the gate numbers.
const capRequested = args.includes('--cap');
const capArg = capRequested ? args[args.indexOf('--cap') + 1] : undefined;
const capLevels = ['0', 'off', 'unlimited', 'inf', 'infinity'].includes(capArg)
  ? [Number.POSITIVE_INFINITY]
  : capArg && Number(capArg) > 0
    ? [Number(capArg)]
    : [Number.POSITIVE_INFINITY, 32, 16, 8];
const PER_INTENT = 4;
const FACE_TOKEN = 'bench-token';
/**
 * Stall guard, not an SLO: a branch that never settles would hang the harness
 * forever, so each one is abandoned after this long. It must stay far above any
 * latency the table reports, otherwise the watchdog becomes the measurement -
 * at 20x a 50ms think delay it tripped on a contiguous tail of branches while
 * the mock farm and the kernel shared one process under load. Reported wall
 * clock and percentiles come from the samples, never from this number.
 */
const BRANCH_WATCHDOG_MS = delayMs * 40;

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  // nearest-rank
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
  return {
    min: round(sorted[0]),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1]),
    avg: round(avg),
  };
}

/**
 * One node:http server impersonates the whole vassal farm under /vN/tasks.
 * options.terminalState:
 *   - 'completed' (default): sendSubscribe ends in a completed task with a verdict.
 *   - 'input-required':      the task settles into a non-terminal suspended state,
 *                            which is what F3 cancelIntent is designed to cancel.
 * The same endpoint also serves JSON-RPC tasks/cancel with a plain JSON response.
 */
function startMockFarm(count, thinkDelayMs, options = {}) {
  const terminalState = options.terminalState ?? 'completed';
  let cancelRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const match = /^\/v(\d+)\/tasks$/.exec(req.url ?? '');
    if (!match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      let rpc;
      try {
        rpc = JSON.parse(raw || '{}');
      } catch {
        res.statusCode = 400;
        res.end();
        return;
      }

      // tasks/cancel: same endpoint, plain JSON-RPC response returning a canceled task.
      if (rpc.method === 'tasks/cancel') {
        cancelRequests += 1;
        const taskId = rpc.params?.id ?? 'unknown';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id ?? 3,
            result: {
              kind: 'task',
              id: taskId,
              contextId: 'ctx',
              status: { state: 'canceled', timestamp: new Date().toISOString() },
            },
          })
        );
        return;
      }

      // tasks/sendSubscribe: an SSE stream with a working frame then a final task.
      const taskId = `task-${match[1]}-${Math.random().toString(36).slice(2, 10)}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false },
        })}\n\n`
      );
      setTimeout(() => {
        const finalTask =
          terminalState === 'completed'
            ? {
                kind: 'task',
                id: taskId,
                contextId: 'ctx',
                status: { state: 'completed', timestamp: new Date().toISOString() },
                artifacts: [
                  { artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'go' } }] },
                ],
              }
            : {
                kind: 'task',
                id: taskId,
                contextId: 'ctx',
                // a suspended task carries no verdict yet; artifacts is an empty list
                artifacts: [],
                status: { state: terminalState, timestamp: new Date().toISOString() },
              };
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: finalTask })}\n\n`);
      }, thinkDelayMs);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, getCancelCount: () => cancelRequests })
    );
  });
}

function farmEntries(port, count) {
  const fealty = {
    version: '1',
    swornTo: 'zeus',
    domain: 'bench',
    dataRealms: ['personal'],
    dataPolicy: 'none',
    reportBack: true,
    escalationPolicy: 'auto',
  };
  return Array.from({ length: count }, (_, i) => {
    const name = `vassal-${i}`;
    const cardUrl = `http://127.0.0.1:${port}/v${i}/card`;
    const taskUrl = `http://127.0.0.1:${port}/v${i}/tasks`;
    return {
      cardUrl,
      taskUrl,
      registeredAt: new Date().toISOString(),
      revoked: false,
      card: {
        name,
        url: cardUrl,
        skills: [{ id: 'bench', name: 'Bench', description: '', tags: [] }],
        'x-zeus-fealty': fealty,
      },
      fealty,
    };
  });
}

function buildKernel(entries, options = {}) {
  const registry = new VassalRegistry();
  registry.importState(entries);
  const metrics = new ConcurrencyMetrics();
  const dispatcher = new Dispatcher(registry.asVassalLookup(), { audit() {} });
  let intentSeq = 0;
  let runSeq = 0;
  const orchestrator = new Orchestrator(registry.asVassalLookup(), dispatcher, {
    metrics,
    newIntentId: () => `intent-${++intentSeq}`,
    newRunId: () => `run-${++runSeq}`,
    ...options,
  });
  return { orchestrator, metrics, registry };
}

/** A real H2 driver face (Fastify + bearer auth + JSON) wired to the kernel. */
async function buildFaceKernel(entries) {
  const { orchestrator, metrics, registry } = buildKernel(entries);
  const signer = new Ed25519MemorySigner('zeus-rsk-bench');
  const app = await createHttpServer({ registry, signer, internalToken: FACE_TOKEN, orchestrator, metrics });
  return { app, orchestrator, metrics };
}

function listenOnLoopback(app) {
  return new Promise((resolve, reject) => {
    app.listen({ port: 0, host: '127.0.0.1' }, err => {
      if (err) return reject(err);
      resolve(app.server);
    });
  });
}

async function postIntent(base, names) {
  const response = await fetch(`${base}/api/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FACE_TOKEN}` },
    body: JSON.stringify({
      skill: 'bench',
      realm: 'personal',
      vassals: names,
      aggregation: { kind: 'unanimous' },
      branchTimeoutMs: BRANCH_WATCHDOG_MS,
    }),
  });
  if (!response.ok) throw new Error(`face intent HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function benchFanoutWidth(port) {
  const rows = [];
  for (const width of widths) {
    const { orchestrator } = buildKernel(farmEntries(port, FARM_SIZE));
    const names = Array.from({ length: width }, (_, i) => `vassal-${i}`);
    const samples = [];
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      const result = await orchestrator.fanOut({
        skill: 'bench',
        vassals: names,
        params: {},
        realm: 'personal',
        aggregation: { kind: 'unanimous' },
        branchTimeoutMs: BRANCH_WATCHDOG_MS,
      });
      samples.push(performance.now() - t0);
      if (result.status !== 'completed') {
        const bad = result.branches.filter(b => !b.ok)
          .map(b => `${b.vassal}:${b.timedOut ? 'timeout' : (b.reason ?? 'failed')}`);
        throw new Error(`width ${width}: expected completed, got ${result.status}; branches: ${bad.join(', ') || 'none'}`);
      }
    }
    const s = stats(samples);
    rows.push({
      width,
      ...s,
      parallelEfficiency: round(delayMs / s.p50, 2), // 1.0 = perfectly parallel (wall ~= one vassal)
    });
  }
  return rows;
}

/**
 * Drive `intents` simultaneous intents of PER_INTENT branches each through one
 * orchestrator, and report wall clock and per-intent latency. Queue depth is
 * only sampled when asked for: it is zero without a cap, and polling is extra
 * work inside the window being measured.
 */
async function runConcurrentIntents(orchestrator, metrics, intents, options = {}) {
  const latencies = [];
  let peakQueueDepth = 0;
  const sampler = options.sampleQueue
    ? setInterval(() => {
        const depth = metrics.queueDepthNow();
        if (depth > peakQueueDepth) peakQueueDepth = depth;
      }, 5)
    : null;
  const t0 = performance.now();
  try {
    await Promise.all(
      Array.from({ length: intents }, async (_, c) => {
        // Spread intents across the farm; vassals may be reused, like real life.
        const names = Array.from({ length: PER_INTENT }, (_, k) => `vassal-${(c * PER_INTENT + k) % FARM_SIZE}`);
        const start = performance.now();
        const result = await orchestrator.fanOut({
          skill: 'bench',
          vassals: names,
          params: {},
          realm: 'personal',
          aggregation: { kind: 'unanimous' },
          branchTimeoutMs: BRANCH_WATCHDOG_MS,
        });
        latencies.push(performance.now() - start);
        if (result.status !== 'completed') {
          const label = options.label ?? `concurrency ${intents}`;
          const bad = result.branches.filter(b => !b.ok)
            .map(b => `${b.vassal}:${b.timedOut ? 'timeout' : (b.reason ?? 'failed')}`);
          throw new Error(`${label}: expected completed, got ${result.status}; ${bad.length} bad branch(es): ${bad.slice(0, 6).join(', ') || 'none'}`);
        }
      }),
    );
  } finally {
    clearInterval(sampler);
  }
  return { latencies, wallMs: performance.now() - t0, peakQueueDepth, snapshot: metrics.snapshot() };
}

async function benchConcurrentIntents(port) {
  const rows = [];
  for (const concurrency of concurrencyLevels) {
    const { orchestrator, metrics } = buildKernel(farmEntries(port, FARM_SIZE));
    const { latencies, wallMs, snapshot } = await runConcurrentIntents(orchestrator, metrics, concurrency);
    rows.push({
      concurrentIntents: concurrency,
      branchesPerIntent: PER_INTENT,
      totalBranches: concurrency * PER_INTENT,
      wallMs: round(wallMs),
      intentsPerSecond: round((concurrency / wallMs) * 1000, 2),
      latency: stats(latencies),
      maxInFlightBranches: snapshot.maxInFlight,
      finishedBranches: snapshot.finished,
    });
  }
  return rows;
}

/**
 * Scenario E: the E1.5 concurrency gate under scenario B's heaviest load
 * (32 intents x 4 branches = 128 branches), run behind decreasing caps. This is
 * where the cost of bounding in-flight work gets measured rather than assumed:
 * wall clock and per-intent tail latency are compared against the uncapped run,
 * and the gate itself is checked (in-flight never exceeded the cap, nothing
 * lost, nothing refused while the wait line was unbounded).
 */
async function benchConcurrencyCap(port) {
  const intents = concurrencyLevels[concurrencyLevels.length - 1];
  const totalBranches = intents * PER_INTENT;
  const rows = [];
  for (const cap of capLevels) {
    const { orchestrator, metrics } = buildKernel(farmEntries(port, FARM_SIZE), {
      ...(Number.isFinite(cap) ? { maxConcurrentBranches: cap } : {}),
    });
    const { latencies, wallMs, peakQueueDepth, snapshot } = await runConcurrentIntents(
      orchestrator, metrics, intents,
      { sampleQueue: true, label: `scenario E cap ${Number.isFinite(cap) ? cap : 'unbounded'}` },
    );
    const bound = Number.isFinite(cap) ? cap : totalBranches;
    if (snapshot.maxInFlight > bound) {
      throw new Error(`cap ${cap}: observed ${snapshot.maxInFlight} in flight, above the bound ${bound}`);
    }
    if (snapshot.finished !== totalBranches) {
      throw new Error(`cap ${cap}: finished ${snapshot.finished} of ${totalBranches} branches`);
    }
    if (snapshot.failed !== 0) {
      throw new Error(`cap ${cap}: ${snapshot.failed} branches failed under an unbounded wait line`);
    }
    rows.push({
      cap: Number.isFinite(cap) ? cap : 'unbounded',
      totalBranches,
      wallMs: round(wallMs),
      throughputBranchesPerSecond: round((totalBranches / wallMs) * 1000, 1),
      latency: stats(latencies),
      maxInFlightBranches: snapshot.maxInFlight,
      peakQueueDepth,
      failedBranches: snapshot.failed,
    });
  }
  return rows;
}

/**
 * Scenario C: throughput through the real H2 driver face. Each intent goes over
 * loopback TCP — bearer auth, Fastify routing, JSON parse/serialize — then into
 * the same Orchestrator -> Dispatcher -> mock farm stack as scenario B. The gap
 * between B and C is the HTTP face overhead. A fresh face (and listener) is used
 * per concurrency level for metric isolation.
 */
async function benchHttpFace(port) {
  const rows = [];
  for (const concurrency of concurrencyLevels) {
    const { app } = await buildFaceKernel(farmEntries(port, FARM_SIZE));
    const server = await listenOnLoopback(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // warm up the listener, undici pool and JSON paths (not measured)
      await postIntent(base, ['vassal-0', 'vassal-1', 'vassal-2', 'vassal-3']);

      const latencies = [];
      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async (_, c) => {
          const names = Array.from({ length: PER_INTENT }, (_, k) => `vassal-${(c * PER_INTENT + k) % FARM_SIZE}`);
          const start = performance.now();
          const result = await postIntent(base, names);
          latencies.push(performance.now() - start);
          if (result.status !== 'completed') {
            throw new Error(`face concurrency ${concurrency}: expected completed, got ${result.status}`);
          }
        })
      );
      const wallMs = performance.now() - t0;
      rows.push({
        concurrentIntents: concurrency,
        branchesPerIntent: PER_INTENT,
        totalBranches: concurrency * PER_INTENT,
        wallMs: round(wallMs),
        intentsPerSecond: round((concurrency / wallMs) * 1000, 2),
        latency: stats(latencies),
      });
    } finally {
      // app.close() also closes the loopback listener returned by listen()
      await app.close();
    }
  }
  return rows;
}

/**
 * Scenario D: high-concurrency cancellation propagation. Vassals settle tasks
 * into the non-terminal input-required state (a task parked waiting on input).
 * After many intents are suspended, cancelIntent fans JSON-RPC tasks/cancel out
 * to every non-terminal branch. We assert every branch is canceled exactly once
 * and measure cancellation throughput/wall time against a farm that acks cancels
 * immediately. Uses its own short-think, input-required farm.
 */
async function benchCancellation() {
  const { server, port, getCancelCount } = await startMockFarm(FARM_SIZE, 5, {
    terminalState: 'input-required',
  });
  const rows = [];
  try {
    for (const intents of cancelLevels) {
      const { orchestrator } = buildKernel(farmEntries(port, FARM_SIZE));
      const intentIds = [];
      await Promise.all(
        Array.from({ length: intents }, async (_, c) => {
          const id = `cancel-intent-${intents}-${c}`;
          const names = Array.from({ length: PER_INTENT }, (_, k) => `vassal-${(c * PER_INTENT + k) % FARM_SIZE}`);
          const result = await orchestrator.fanOut({
            intentId: id,
            skill: 'bench',
            vassals: names,
            params: {},
            realm: 'personal',
            aggregation: { kind: 'unanimous' },
            branchTimeoutMs: 5000,
          });
          if (!result.branches.every(branch => branch.ok && branch.state === 'input-required')) {
            throw new Error(
              `cancel bench level ${intents}: expected all branches input-required, got ${JSON.stringify(
                result.branches.map(branch => branch.state)
              )}`
            );
          }
          intentIds.push(id);
        })
      );

      const t0 = performance.now();
      const cancellations = await Promise.all(intentIds.map(id => orchestrator.cancelIntent(id)));
      const wallMs = performance.now() - t0;

      const totalCancelled = cancellations.reduce((n, c) => n + c.results.length, 0);
      const allCanceled = cancellations.every(c => c.results.every(r => r.canceled));
      if (!allCanceled || totalCancelled !== intents * PER_INTENT) {
        throw new Error(
          `cancel bench level ${intents}: expected ${intents * PER_INTENT} cancellations, got ${totalCancelled}`
        );
      }
      rows.push({
        suspendedIntents: intents,
        branchesPerIntent: PER_INTENT,
        totalCancelled,
        wallMs: round(wallMs),
        cancelsPerSecond: round((totalCancelled / wallMs) * 1000, 2),
      });
    }
    const expectedCancels = rows.reduce((n, r) => n + r.totalCancelled, 0);
    if (getCancelCount() !== expectedCancels) {
      throw new Error(
        `cancel bench: mock farm observed ${getCancelCount()} tasks/cancel requests, expected ${expectedCancels}`
      );
    }
    return { rows, cancelRequestsObserved: getCancelCount() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function printTable(title, rows, columns) {
  console.log(`\n${title}`);
  const header = columns.map(c => c.label.padEnd(c.width)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log(columns.map(c => String(c.get(row)).padEnd(c.width)).join(''));
  }
}

async function main() {
  const { server, port } = await startMockFarm(FARM_SIZE, delayMs);
  try {
    const environment = {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      model: os.cpus()[0]?.model ?? 'unknown',
      thinkDelayMs: delayMs,
      reps,
      farmSize: FARM_SIZE,
      measuredAt: new Date().toISOString(),
    };

    // Warm up undici connection pool and V8 JIT paths; not measured.
    {
      const { orchestrator } = buildKernel(farmEntries(port, FARM_SIZE));
      const warm = await orchestrator.fanOut({
        skill: 'bench',
        vassals: ['vassal-0', 'vassal-1', 'vassal-2', 'vassal-3'],
        params: {},
        realm: 'personal',
        aggregation: { kind: 'unanimous' },
        branchTimeoutMs: BRANCH_WATCHDOG_MS,
      });
      if (warm.status !== 'completed') throw new Error('warm-up fan-out failed');
    }

    const fanoutWidth = await benchFanoutWidth(port);
    const concurrentIntents = await benchConcurrentIntents(port);
    const concurrencyCap = capRequested ? await benchConcurrencyCap(port) : [];
    const httpFace = await benchHttpFace(port);
    const cancellation = await benchCancellation();
    const report = {
      environment,
      fanoutWidth,
      concurrentIntents,
      concurrencyCap,
      httpFace,
      cancellation: cancellation.rows,
      cancelRequestsObserved: cancellation.cancelRequestsObserved,
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log('Zeus E10.4 local capacity baseline (mock vassals, loopback HTTP)');
    console.log(`node ${environment.node} | ${environment.platform} | ${environment.cpus} CPUs | think delay ${delayMs}ms | ${reps} reps | farm ${FARM_SIZE}`);
    printTable(
      'A. Single-intent fan-out width (wall should stay ~= one vassal think delay)',
      fanoutWidth,
      [
        { label: 'width', width: 8, get: r => r.width },
        { label: 'p50 ms', width: 10, get: r => r.p50 },
        { label: 'p95 ms', width: 10, get: r => r.p95 },
        { label: 'max ms', width: 10, get: r => r.max },
        { label: 'parallel eff.', width: 14, get: r => r.parallelEfficiency },
      ],
    );
    printTable(
      `B. Concurrent intents (${PER_INTENT} branches each, ${delayMs}ms think per branch)`,
      concurrentIntents,
      [
        { label: 'intents', width: 9, get: r => r.concurrentIntents },
        { label: 'branches', width: 10, get: r => r.totalBranches },
        { label: 'wall ms', width: 10, get: r => r.wallMs },
        { label: 'intents/s', width: 11, get: r => r.intentsPerSecond },
        { label: 'lat p50', width: 10, get: r => r.latency.p50 },
        { label: 'lat p95', width: 10, get: r => r.latency.p95 },
        { label: 'max in-flight', width: 14, get: r => r.maxInFlightBranches },
      ],
    );
    if (concurrencyCap.length > 0) {
      printTable(
        `E. Concurrency gate (same 128-branch load as B, behind decreasing maxConcurrentBranches caps, ${delayMs}ms think)`,
        concurrencyCap,
        [
          { label: 'cap', width: 11, get: r => r.cap },
          { label: 'wall ms', width: 10, get: r => r.wallMs },
          { label: 'br/s', width: 9, get: r => r.throughputBranchesPerSecond },
          { label: 'lat p50', width: 10, get: r => r.latency.p50 },
          { label: 'lat p95', width: 10, get: r => r.latency.p95 },
          { label: 'max inflight', width: 13, get: r => r.maxInFlightBranches },
          { label: 'peak queue', width: 12, get: r => r.peakQueueDepth },
        ],
      );
    }
    printTable(
      `C. H2 driver-face throughput (real loopback HTTP + bearer + JSON, ${PER_INTENT} branches/intent, ${delayMs}ms think)`,
      httpFace,
      [
        { label: 'intents', width: 9, get: r => r.concurrentIntents },
        { label: 'branches', width: 10, get: r => r.totalBranches },
        { label: 'wall ms', width: 10, get: r => r.wallMs },
        { label: 'intents/s', width: 11, get: r => r.intentsPerSecond },
        { label: 'lat p50', width: 10, get: r => r.latency.p50 },
        { label: 'lat p95', width: 10, get: r => r.latency.p95 },
      ],
    );
    printTable(
      `D. Cancellation propagation (suspended input-required intents, ${PER_INTENT} branches/intent, cancel acks immediate)`,
      cancellation.rows,
      [
        { label: 'intents', width: 9, get: r => r.suspendedIntents },
        { label: 'cancels', width: 10, get: r => r.totalCancelled },
        { label: 'wall ms', width: 10, get: r => r.wallMs },
        { label: 'cancels/s', width: 11, get: r => r.cancelsPerSecond },
      ],
    );
    console.log(`\nCancel requests observed at mock farm: ${cancellation.cancelRequestsObserved}`);
    console.log('\nNote: mock loopback baseline bounds kernel overhead, not real-vassal (LLM/network) capacity.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

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
 * vassal capacity (LLM latency, network RTT, auth). Back-pressure / bounded
 * queues remain deferred (#9, gated on >=3 real vassals).
 *
 * Usage:
 *   npm run build && node scripts/bench-capacity.mjs           # human table
 *   node scripts/bench-capacity.mjs --json                     # machine JSON
 *   node scripts/bench-capacity.mjs --delay-ms 50 --reps 7
 */
import http from 'node:http';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { VassalRegistry } from '../dist/registry/registry.js';
import { Dispatcher } from '../dist/dispatch/dispatcher.js';
import { Orchestrator } from '../dist/orchestrator/orchestrator.js';
import { ConcurrencyMetrics } from '../dist/orchestrator/metrics.js';

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
const PER_INTENT = 4;

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

/** One node:http server impersonates the whole vassal farm under /vN/tasks. */
function startMockFarm(count, thinkDelayMs) {
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
    req.on('data', () => {});
    req.on('end', () => {
      const taskId = `task-${match[1]}-${Math.random().toString(36).slice(2, 10)}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false },
        })}\n\n`,
      );
      setTimeout(() => {
        const task = {
          kind: 'task',
          id: taskId,
          contextId: 'ctx',
          status: { state: 'completed', timestamp: new Date().toISOString() },
          artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
        };
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: task })}\n\n`);
      }, thinkDelayMs);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
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

function buildKernel(entries) {
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
  });
  return { orchestrator, metrics };
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
        branchTimeoutMs: delayMs * 20,
      });
      samples.push(performance.now() - t0);
      if (result.status !== 'completed') {
        throw new Error(`width ${width}: expected completed, got ${result.status}`);
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

async function benchConcurrentIntents(port) {
  const rows = [];
  for (const concurrency of concurrencyLevels) {
    const { orchestrator, metrics } = buildKernel(farmEntries(port, FARM_SIZE));
    const latencies = [];
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async (_, c) => {
        // Spread intents across the farm; vassals may be reused, like real life.
        const names = Array.from({ length: PER_INTENT }, (_, k) => `vassal-${(c * PER_INTENT + k) % FARM_SIZE}`);
        const start = performance.now();
        const result = await orchestrator.fanOut({
          skill: 'bench',
          vassals: names,
          params: {},
          realm: 'personal',
          aggregation: { kind: 'unanimous' },
          branchTimeoutMs: delayMs * 20,
        });
        latencies.push(performance.now() - start);
        if (result.status !== 'completed') {
          throw new Error(`concurrency ${concurrency}: expected completed, got ${result.status}`);
        }
      }),
    );
    const wallMs = performance.now() - t0;
    const snapshot = metrics.snapshot();
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
        branchTimeoutMs: delayMs * 20,
      });
      if (warm.status !== 'completed') throw new Error('warm-up fan-out failed');
    }

    const fanoutWidth = await benchFanoutWidth(port);
    const concurrentIntents = await benchConcurrentIntents(port);
    const report = { environment, fanoutWidth, concurrentIntents };

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
    console.log('\nNote: mock loopback baseline bounds kernel overhead, not real-vassal (LLM/network) capacity.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

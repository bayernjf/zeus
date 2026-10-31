#!/usr/bin/env node
// @ts-check
/**
 * Recall micro-benchmark (W2-1a, review P2-1 follow-up).
 *
 * Measures the memory recall path that sits in front of every fan-out branch
 * assembly: RecallIndex cold build, hot (incremental) sync, hot query, and the
 * dimension-switch rebuild. Before W2-1a every searchRecall paid a full
 * clear-and-rebuild, so a cold cache turned one recall into N serial hub
 * round trips (15s timeout each); the index now embeds only content-hash
 * misses through a bounded pool of 4.
 *
 * Two embedder scenarios, same honest scope as bench-capacity's mock farm:
 *   - `local`: the deterministic LocalHashingEmbedder — pure CPU, bounds the
 *     index's own overhead (hashing, BM25, pool scheduling), no network.
 *   - `simulated`: a counting embedder with a fixed artificial per-call
 *     latency (`--embed-delay-ms`, default 5) standing in for the hub round
 *     trip. It shows the pool's cold-build shape (wall ~= ceil(N/4) x delay)
 *     against the serial projection (N x delay) of the pre-W2-1a path. The
 *     projection is computed, not measured — the serial path no longer exists.
 *     Neither number is a real-hub prediction; real latency and rate limits
 *     dominate there.
 *
 * Correctness hard gates (throw, like bench-capacity's): a cold build embeds
 * exactly N facts, a hot sync embeds 0, every hot query embeds exactly 1
 * (the query text), a dimension rebuild re-embeds exactly N, and a known
 * query recalls its fact.
 *
 * Usage:
 *   npm run build && node scripts/bench-recall.mjs            # human table
 *   node scripts/bench-recall.mjs --json                      # machine JSON
 *   node scripts/bench-recall.mjs --facts 200 --reps 30
 *   node scripts/bench-recall.mjs --embed-delay-ms 15
 *   node scripts/bench-recall.mjs --report /tmp/recall-baseline.json
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { MemoryStore } from '../dist/memory/memory-store.js';
import { LocalHashingEmbedder } from '../dist/memory/recall.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
/**
 * @param {string} flag
 * @param {number} fallback
 * @returns {number}
 */
const argNumber = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? Number(args[idx + 1]) : fallback;
};
const argString = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const FACTS = argNumber('--facts', 200);
const REPS = argNumber('--reps', 20);
const EMBED_DELAY_MS = argNumber('--embed-delay-ms', 5);
const REPORT_PATH = argString('--report', '');
const REALM = 'personal';
const FIXED_NOW = () => new Date('2026-10-30T00:00:00.000Z');
/** The store's searchRecall derives queries from branch params; queries here
 *  are single distinctive tokens so hits identify their fact unambiguously. */
const QUERY_STEP = Math.max(1, Math.floor(FACTS / 10));

/**
 * @param {number} n
 * @param {number} [digits]
 * @returns {number}
 */
function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * @param {number[]} samples
 * @returns {{ min: number, p50: number, p95: number, max: number, avg: number }}
 */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
  return {
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1] ?? 0),
    avg: round(avg),
  };
}

/**
 * @param {number[]} sorted
 * @param {number} p
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

/**
 * A counting embedder whose vectors come from the real local hashing embedder
 * and whose reported dimension is mutable, so the bench can flip the vector
 * space the way the hub embedder does on a dimension switch. With
 * `delayMs > 0` each embed also burns that much wall clock, standing in for
 * the hub round trip.
 *
 * @param {number} dimension
 * @param {number} delayMs
 */
function makeEmbedder(dimension, delayMs) {
  const calls = [];
  /** @type {Map<number, LocalHashingEmbedder>} */
  const locals = new Map();
  /** @param {string} text @returns {Promise<number[]>} */
  const embed = async text => {
    calls.push(text);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    let local = locals.get(embedder.dimension);
    if (!local) {
      local = new LocalHashingEmbedder(embedder.dimension);
      locals.set(embedder.dimension, local);
    }
    return local.embed(text);
  };
  const embedder = { dimension, embed, calls };
  return embedder;
}

/**
 * Deterministic fact corpus: N distinct facts over a shared vocabulary, none
 * episodic (decay must not interfere with the measured paths).
 *
 * @param {number} n
 */
function buildEvents(n) {
  const topics = ['typescript', 'rust', 'kubernetes', 'postgres', 'redis', 'graphql'];
  const moods = ['prefers', 'dislikes', 'is-learning', 'teaches', 'evaluating'];
  return Array.from({ length: n }, (_, i) => ({
    eventId: `bench-e${i}`,
    realmId: REALM,
    runId: 'bench-run',
    source: { agentId: 'bench-agent' },
    kind: 'claim',
    content: {
      subject: 'user',
      predicate: moods[i % moods.length],
      object: `${topics[i % topics.length]} variant-${i} 每周例会`,
    },
    refs: [],
    confidence: 0.9,
    occurredAt: '2026-10-30T00:00:00.000Z',
  }));
}

/**
 * Fresh store with the corpus consolidated, index NOT yet materialised.
 * Fixture construction is untimed.
 *
 * @param {any} embedder
 * @param {any[]} events
 */
function freshStore(embedder, events) {
  const store = new MemoryStore(undefined, FIXED_NOW, { embedder });
  for (const event of events) store.append(event);
  store.consolidateRealm(REALM);
  return store;
}

/**
 * @param {any} embedder
 * @param {any[]} events
 * @returns {Promise<{ ms: number, embeds: number, store: any }>}
 */
async function measureColdBuild(embedder, events) {
  const store = freshStore(embedder, events);
  const before = embedder.calls.length;
  const t0 = performance.now();
  await store.buildRecall(REALM);
  const ms = performance.now() - t0;
  return { ms, embeds: embedder.calls.length - before, store };
}

/**
 * One scenario pass over a fresh embedder + corpus. Gates throw on violation.
 *
 * @param {number} delayMs
 */
async function runScenario(delayMs) {
  const events = buildEvents(FACTS);

  // --- cold build (reps: fresh fixture each time, untimed) ---
  /** @type {number[]} */
  const coldSamples = [];
  let last = null;
  for (let r = 0; r < REPS; r++) {
    const embedder = makeEmbedder(256, delayMs);
    last = await measureColdBuild(embedder, events);
    coldSamples.push(last.ms);
    if (last.embeds !== FACTS) {
      throw new Error(`cold build embedded ${last.embeds} facts, expected ${FACTS}`);
    }
  }
  const embedder = makeEmbedder(256, delayMs);
  const { store } = await measureColdBuild(embedder, events);

  // --- hot sync: the same corpus again must embed nothing ---
  const beforeHotSync = embedder.calls.length;
  const tHot = performance.now();
  await store.buildRecall(REALM);
  const hotSyncMs = performance.now() - tHot;
  const hotSyncEmbeds = embedder.calls.length - beforeHotSync;
  if (hotSyncEmbeds !== 0) {
    throw new Error(`hot sync embedded ${hotSyncEmbeds} facts, expected 0`);
  }

  // --- hot query: incremental sync + one query embed per call ---
  const queries = Array.from({ length: 10 }, (_, i) => `variant-${i * QUERY_STEP}`);
  // warm-up (untimed): JIT paths and any lazy init
  const warmHits = await store.searchRecall(REALM, REALM, queries[0]);
  if (warmHits.length === 0) throw new Error(`warm-up query '${queries[0]}' recalled nothing`);
  if (!warmHits.some(h => h.fact.object.includes(queries[0]))) {
    throw new Error(`warm-up query '${queries[0]}' did not recall its fact first-match`);
  }
  /** @type {number[]} */
  const querySamples = [];
  for (let r = 0; r < REPS; r++) {
    for (const query of queries) {
      const before = embedder.calls.length;
      const t0 = performance.now();
      await store.searchRecall(REALM, REALM, query);
      querySamples.push(performance.now() - t0);
      const added = embedder.calls.length - before;
      if (added !== 1) {
        throw new Error(`hot query '${query}' triggered ${added} embeds, expected exactly 1 (the query)`);
      }
    }
  }

  // --- dimension-switch rebuild: the whole corpus re-embeds once ---
  embedder.dimension = 512;
  const beforeFlip = embedder.calls.length;
  const tFlip = performance.now();
  const flipped = await store.buildRecall(REALM);
  const flipMs = performance.now() - tFlip;
  const flipEmbeds = embedder.calls.length - beforeFlip;
  if (flipped.dimension !== 512) throw new Error(`rebuilt index dimension ${flipped.dimension}, expected 512`);
  if (flipEmbeds !== FACTS) {
    throw new Error(`dimension rebuild embedded ${flipEmbeds} facts, expected ${FACTS}`);
  }
  const afterFlip = await store.searchRecall(REALM, REALM, queries[0]);
  if (!afterFlip.some(h => h.fact.object.includes(queries[0]))) {
    throw new Error('post-rebuild recall lost its fact');
  }

  const serialProjectionMs = FACTS * delayMs;
  const coldP50 = round(coldSamples.reduce((s, n) => s + n, 0) / coldSamples.length);
  return {
    coldBuild: { ...stats(coldSamples), embeds: FACTS },
    hotSync: { ms: round(hotSyncMs), embeds: hotSyncEmbeds },
    hotQuery: { ...stats(querySamples), embedsPerQuery: 1, samples: querySamples.length },
    dimensionRebuild: { ms: round(flipMs), embeds: flipEmbeds },
    ...(delayMs > 0
      ? {
          serialProjectionMs: round(serialProjectionMs),
          pooledSpeedupVsSerial: round(serialProjectionMs / coldP50, 2),
        }
      : {}),
  };
}

/** @param {string} title @param {any} row @param {Array<[string, (r: any) => any]>} columns */
function printRow(title, row, columns) {
  console.log(`\n${title}`);
  for (const [label, get] of columns) {
    console.log(`  ${label.padEnd(34)} ${get(row)}`);
  }
}

async function main() {
  const local = await runScenario(0);
  const simulated = await runScenario(EMBED_DELAY_MS);
  const report = {
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      model: os.cpus()[0]?.model ?? 'unknown',
      facts: FACTS,
      reps: REPS,
      embedDelayMs: EMBED_DELAY_MS,
      embedConcurrency: 4,
      measuredAt: new Date().toISOString(),
    },
    local,
    simulated,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const env = report.environment;
    console.log('Zeus recall micro-benchmark (W2-1a): RecallIndex cold build / hot sync / hot query');
    console.log(`node ${env.node} | ${env.platform} | ${env.cpus} CPUs | facts ${env.facts} | reps ${env.reps} | embed concurrency ${env.embedConcurrency}`);
    for (const [name, scenario] of [['local (pure CPU)', local], [`simulated hub latency (${EMBED_DELAY_MS}ms/call)`, simulated]]) {
      printRow(`Scenario: ${name}`, scenario, [
        ['cold build (N embeds, pool of 4)', r => `${r.coldBuild.p50} ms (p95 ${r.coldBuild.p95}, max ${r.coldBuild.max})`],
        ['hot sync (unchanged corpus)', r => `${r.hotSync.ms} ms, embeds: ${r.hotSync.embeds}`],
        ['hot query (sync + query embed)', r => `p50 ${r.hotQuery.p50} ms, p95 ${r.hotQuery.p95} ms, max ${r.hotQuery.max} ms (${r.hotQuery.samples} samples)`],
        ['dimension rebuild (N embeds)', r => `${r.dimensionRebuild.ms} ms, embeds: ${r.dimensionRebuild.embeds}`],
        ...(scenario.serialProjectionMs !== undefined
          ? [['serial projection (pre-W2-1a)', r => `${r.serialProjectionMs} ms -> pooled speedup x${r.pooledSpeedupVsSerial}`]]
          : []),
      ]);
    }
    console.log('\nGates passed: cold=N embeds, hot sync=0, hot query=1 (query only), dimension rebuild=N, recall finds its fact.');
    console.log('Note: simulated-latency numbers stand in for the hub round trip; they bound the pool shape, not real-hub capacity.');
  }

  if (REPORT_PATH) {
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    if (!asJson) console.log(`\nReport written to ${REPORT_PATH}`);
  }
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});

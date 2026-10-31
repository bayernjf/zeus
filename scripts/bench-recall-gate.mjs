#!/usr/bin/env node
// @ts-check
/**
 * Recall micro-benchmark regression gate (W2-1a follow-up, G-batch 2026-10-31).
 *
 * Runs scripts/bench-recall.mjs --json and compares the measured recall-path
 * latencies against `recall-baseline.json`, pinned per environment fingerprint
 * — the same scheme bench-gate.mjs uses for the capacity bench, extended with
 * the bench shape parameters (facts / reps / embed delay) because the CLI can
 * move them and numbers across shapes are not comparable:
 *
 *   <platform>-<arch>-<cpus>-<node>-f<facts>-r<reps>-d<delay>
 *
 * - Correctness is the hard gate inside bench-recall itself (cold build embeds
 *   exactly N, hot sync 0, hot query exactly the query embed, dimension
 *   rebuild N, known query recalls its fact — violations throw, the gate fails
 *   on the non-zero exit).
 * - Latency comparison: +30% over baseline on any tracked metric -> exit 1.
 *   One threshold, no warn tier (deliberate simplification against
 *   bench-gate's two-tier: this micro-bench is cheap to re-run, and the ask
 *   was a single ±30% tripwire). Faster is never red.
 * - Tracked metrics (all delay-kind, ms): local.coldBuild.p50/p95,
 *   local.hotQuery.p50/p95, local.dimensionRebuild.ms, simulated.coldBuild.p50,
 *   simulated.hotQuery.p50/p95. hotSync.ms is sub-millisecond noise and
 *   serialProjection is computed (not measured) — both skipped on purpose.
 *
 * Seeding mode: no baseline entry for this fingerprint -> correctness only,
 * print + exit 0. Baselines accumulate in the file out-of-band, or locally via
 * `--update-baseline` (merges the current run into recall-baseline.json; CI
 * never passes it).
 *
 * Usage:
 *   node scripts/bench-recall-gate.mjs [--baseline recall-baseline.json] [--report out.json] [--update-baseline]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
/** @param {string} flag @param {string} fallback */
const argString = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const hasFlag = (flag) => args.includes(flag);
const baselinePath = argString('--baseline', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'recall-baseline.json'));
const reportPath = argString('--report', '');
const updateBaseline = hasFlag('--update-baseline');

// Same headroom logic as bench-gate: bench variance is real, the gate exists
// to catch measurable degradation, not to pin run-to-run jitter red.
const HARD_DELAY_UP = 0.30; // 延迟退化 > +30% 红
// Relative thresholds need signal above noise: the local (pure-CPU) scenario
// measures sub-millisecond index overhead where ±30% is jitter, not
// regression. Metrics whose baseline sits below this floor are printed but
// never compared (the simulated-hub-latency scenario carries the gate).
const MIN_COMPARABLE_MS = 5;

/** @returns {string} 指纹：环境 + bench 形状（facts/reps/delay 参与对比可比性） */
function fingerprint(report) {
  const env = report.environment;
  return `${os.platform()}-${os.arch()}-${os.cpus().length}-${process.version}-f${env.facts}-r${env.reps}-d${env.embedDelayMs}`;
}

/** @param {number} x */
const round = (x, d = 1) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

/** @param {any} report @returns {Record<string, number>} 扁平指标集（键即报告路径） */
function metricsOf(report) {
  return {
    'local.coldBuild.p50': report.local.coldBuild.p50,
    'local.coldBuild.p95': report.local.coldBuild.p95,
    'local.hotQuery.p50': report.local.hotQuery.p50,
    'local.hotQuery.p95': report.local.hotQuery.p95,
    'local.dimensionRebuild.ms': report.local.dimensionRebuild.ms,
    'simulated.coldBuild.p50': report.simulated.coldBuild.p50,
    'simulated.hotQuery.p50': report.simulated.hotQuery.p50,
    'simulated.hotQuery.p95': report.simulated.hotQuery.p95,
  };
}

async function main() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench-recall.mjs');
  const bench = spawnSync(process.execPath, [script, '--json'], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  if (bench.status !== 0) {
    // Correctness hard gates live inside bench-recall; a non-zero exit is the
    // failure, and its stderr is the message.
    console.error(bench.stderr || bench.stdout || 'bench-recall.mjs exited non-zero');
    process.exit(bench.status ?? 1);
  }
  /** @type {any} */
  let report;
  try {
    report = JSON.parse(bench.stdout);
  } catch {
    console.error('bench-recall.mjs --json produced unparseable output');
    process.exit(2);
  }

  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const fp = fingerprint(report);
  const current = metricsOf(report);

  /** @type {any} */
  let baselineFile;
  try {
    baselineFile = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    baselineFile = { baselines: {} };
  }
  const baseline = baselineFile.baselines?.[fp];

  if (updateBaseline) {
    baselineFile.baselines = baselineFile.baselines ?? {};
    baselineFile.baselines[fp] = {
      measuredAt: report.environment.measuredAt,
      metrics: current,
    };
    writeFileSync(baselinePath, `${JSON.stringify(baselineFile, null, 2)}\n`);
    console.log(`recall gate: baseline pinned for ${fp} at ${baselinePath}`);
    process.exit(0);
  }

  if (!baseline) {
    console.log(`recall gate: no baseline for fingerprint ${fp} (seeding mode; report archived${reportPath ? ` at ${reportPath}` : ''}). Correctness gates passed.`);
    process.exit(0);
  }

  const baseMetrics = baseline.metrics ?? {};
  const rows = [`recall gate: comparing ${fp} against baseline measured ${baseline.measuredAt}`];
  let red = false;
  for (const [key, value] of Object.entries(current)) {
    const base = baseMetrics[key];
    if (typeof base !== 'number' || base <= 0) {
      rows.push(`  ? ${key}: ${round(value)} (baseline missing, skipped)`);
      continue;
    }
    if (base < MIN_COMPARABLE_MS) {
      rows.push(`  ? ${key}: ${round(value)} vs ${round(base)} (baseline below the ${MIN_COMPARABLE_MS}ms noise floor, skipped)`);
      continue;
    }
    const drift = (value - base) / base;
    if (drift > HARD_DELAY_UP) {
      rows.push(`  ✗ ${key}: ${round(value)} vs ${round(base)} (+${round(drift * 100)}% > +30%)`);
      red = true;
    } else if (drift > 0) {
      rows.push(`  ✓ ${key}: ${round(value)} vs ${round(base)} (+${round(drift * 100)}%, threshold)`);
    } else {
      rows.push(`  ✓ ${key}: ${round(value)} vs ${round(base)} (faster/equal, ok)`);
    }
  }
  console.log(rows.join('\n'));
  if (red) {
    console.error('\nrecall gate: RED (recall latency regression beyond the +30% threshold)');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exit(1);
});

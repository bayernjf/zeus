#!/usr/bin/env node
// @ts-check
/**
 * bench:capacity 防退化门禁（B1/A2，2026-10-19）。
 *
 * 跑真内核四场景（复用 scripts/bench-capacity.mjs --json），并按环境指纹与
 * capacity-baseline.json 中钉住的基线对比：
 *
 *   - 正确性硬闸（零容忍，bench 脚本自带 throw）：
 *       场景 A/B/C 任一意图非 completed（含超时分支）、场景 D 取消数不等于
 *       期望、mock farm 实收取消请求 != 期望（丢失/重复）→ bench 非零退出；
 *       门禁另核 ΣtotalCancelled == cancelRequestsObserved。
 *   - 延迟/吞吐相对基线（按环境指纹匹配；无匹配 → 建档模式）：
 *       延迟类（p50/p95/wallMs）现值/基线 − 1 > +0.30 → exit 1 红；
 *       吞吐类（intents/s、cancels/s）< 1 − 0.30 → exit 1 红；
 *       同类阈值 +0.15 / −0.15 → 告警（打印，不拦）。吞吐提升、延迟下降为改善，不告警。
 *
 * 建档模式：当前环境指纹在基线文件中无条目时，只跑正确性硬闸并打印首跑提示，
 * exit 0。基线文件按指纹累积、由仓库内人工/后续批次钉入（跨环境绝对值不可比，
 * CI ubuntu runner 与本地 M4 不共享指纹）。
 *
 * Usage:
 *   node scripts/bench-gate.mjs [--baseline capacity-baseline.json] [--report out.json]
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
const baselinePath = argString('--baseline', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'capacity-baseline.json'));
const reportPath = argString('--report', '');

// 门禁阈值：bench 自身方差约 ±15%（capacity-baseline v0.4 对照段实测），
// 硬红留一倍余量（±30%），告警线取 ±15%。CI 共享 runner 抖动比空闲本机大，
// 阈值只防可测的实质退化，不追求把每次抖动都钉红。
const HARD_DELAY_UP = 0.30; // 延迟退化 > +30% 红
const WARN_DELAY_UP = 0.15; // 延迟退化 > +15% 告警
const HARD_THROUGHPUT_DOWN = 0.30; // 吞吐退化 > −30% 红
const WARN_THROUGHPUT_DOWN = 0.15; // 吞吐退化 > −15% 告警

/** @returns {string} 环境指纹：<platform>-<arch>-<cpus>-<node>（与基线文件键一致） */
function fingerprint() {
  return `${os.platform()}-${os.arch()}-${os.cpus().length}-${process.version}`;
}

/** @param {number} x */
const round = (x, d = 2) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

/** @param {number} current @param {number} baseline @returns {number} 相对偏差 (current-baseline)/baseline */
const drift = (current, baseline) => (current - baseline) / baseline;

/**
 * @param {any} report
 * @param {string} label
 * @param {number} current
 * @param {number|undefined} baseline
 * @param {'delay'|'throughput'} kind
 * @param {string[]} rows
 * @returns {'red'|'warn'|'ok'}
 */
function compareOne(report, label, current, baseline, kind, rows) {
  if (baseline === undefined) return 'ok';
  const d = drift(current, baseline);
  const worse = kind === 'delay' ? d > 0 : d < 0;
  if (!worse) {
    rows.push(`  ✓ ${label}: ${round(current)} vs ${round(baseline)} (${kind === 'delay' ? '更快' : '更高'}, 改善)`);
    return 'ok';
  }
  const magnitude = Math.abs(d);
  if (kind === 'delay' ? magnitude > HARD_DELAY_UP : magnitude > HARD_THROUGHPUT_DOWN) {
    rows.push(`  ✗ ${label}: ${round(current)} vs ${round(baseline)} (${kind === 'delay' ? '延迟' : '吞吐'}退化 ${round(magnitude * 100)}%)`);
    return 'red';
  }
  if (kind === 'delay' ? magnitude > WARN_DELAY_UP : magnitude > WARN_THROUGHPUT_DOWN) {
    rows.push(`  ⚠ ${label}: ${round(current)} vs ${round(baseline)} (退化 ${round(magnitude * 100)}%, 未到硬红阈值)`);
    return 'warn';
  }
  rows.push(`  ✓ ${label}: ${round(current)} vs ${round(baseline)} (偏差 ${round(magnitude * 100)}%, 阈值内)`);
  return 'ok';
}

/** @param {any} report @param {any} baseline @param {string[]} rows @returns {'red'|'warn'|'ok'} */
function compareReport(report, baseline, rows) {
  let verdict = 'ok';
  const note = (v) => { if (v === 'red') verdict = 'red'; else if (v === 'warn' && verdict !== 'red') verdict = 'warn'; };

  rows.push(`  A. fan-out width (基线: ${report.environment.platform} ${report.environment.cpus} CPUs)`);
  for (const row of report.fanoutWidth) {
    const b = baseline.fanoutWidth.find((/** @type {any} */ x) => x.width === row.width);
    note(compareOne(report, `width ${row.width} p50`, row.p50, b?.p50, 'delay', rows));
    note(compareOne(report, `width ${row.width} p95`, row.p95, b?.p95, 'delay', rows));
  }

  rows.push('  B. concurrent intents');
  for (const row of report.concurrentIntents) {
    const b = baseline.concurrentIntents.find((/** @type {any} */ x) => x.concurrentIntents === row.concurrentIntents);
    note(compareOne(report, `intents ${row.concurrentIntents} 吞吐`, row.intentsPerSecond, b?.intentsPerSecond, 'throughput', rows));
    note(compareOne(report, `intents ${row.concurrentIntents} p95`, row.latency.p95, b?.latencyP95, 'delay', rows));
    note(compareOne(report, `intents ${row.concurrentIntents} wall`, row.wallMs, b?.wallMs, 'delay', rows));
  }

  rows.push('  C. H2 face throughput');
  for (const row of report.httpFace) {
    const b = baseline.httpFace.find((/** @type {any} */ x) => x.concurrentIntents === row.concurrentIntents);
    note(compareOne(report, `intents ${row.concurrentIntents} 吞吐`, row.intentsPerSecond, b?.intentsPerSecond, 'throughput', rows));
    note(compareOne(report, `intents ${row.concurrentIntents} p95`, row.latency.p95, b?.latencyP95, 'delay', rows));
  }

  rows.push('  D. cancellation propagation');
  for (const row of report.cancellation) {
    const b = baseline.cancellation.find((/** @type {any} */ x) => x.suspendedIntents === row.suspendedIntents);
    note(compareOne(report, `intents ${row.suspendedIntents} cancels/s`, row.cancelsPerSecond, b?.cancelsPerSecond, 'throughput', rows));
  }
  return verdict;
}

async function main() {
  // 1. 跑 bench（正确性硬闸在 bench 脚本内部：非 completed / 取消丢失 / 泄漏即非零退出）
  const bench = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench-capacity.mjs'), '--json'], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  if (bench.status !== 0) {
    console.error(bench.stderr || bench.stdout || 'bench-capacity.mjs exited non-zero');
    process.exit(bench.status ?? 1);
  }
  /** @type {any} */
  let report;
  try {
    report = JSON.parse(bench.stdout);
  } catch {
    console.error('bench-capacity.mjs --json produced unparseable output');
    process.exit(2);
  }

  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // 2. 正确性复核：Σcancelled == mock farm 实收（无丢失无重复）
  const totalCancelled = report.cancellation.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + r.totalCancelled, 0);
  const expected = report.cancellation.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + r.suspendedIntents * 4, 0);
  if (totalCancelled !== expected || report.cancelRequestsObserved !== expected) {
    console.error(`correctness gate: cancelled ${totalCancelled}, expected ${expected}; farm observed ${report.cancelRequestsObserved}`);
    process.exit(1);
  }

  // 3. 按环境指纹取基线
  const fp = fingerprint();
  let baselineFile;
  try {
    baselineFile = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    baselineFile = { baselines: {} };
  }
  const baseline = baselineFile.baselines?.[fp];
  if (!baseline) {
    console.log(`capacity gate: no baseline for fingerprint ${fp} (seeding mode; report archived${reportPath ? ` at ${reportPath}` : ''}). Correctness invariants passed.`);
    process.exit(0);
  }

  const rows = [`capacity gate: comparing ${fp} against baseline measured ${baseline.measuredAt} (${baseline.runs} runs)`];
  const verdict = compareReport(report, baseline, rows);
  console.log(rows.join('\n'));
  if (verdict === 'red') {
    console.error('\ncapacity gate: RED (latency/throughput regression beyond the hard threshold)');
    process.exit(1);
  }
  if (verdict === 'warn') {
    console.warn('\ncapacity gate: WARN (degradation beyond the notice threshold, within the hard threshold)');
  }
  process.exit(0);
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
// @ts-check
/**
 * Live decision-backend verification (design-decision-backend.md §3.1, S2).
 *
 * The library tests cover the arbitration gate with mock backends, so they can
 * never answer the question the design doc still flags as open: does a real
 * OpenAI-compatible endpoint actually complete the path — reachable, JSON
 * parseable, gated — when the kernel asks it to break a tie? This script is the
 * operator-facing entry point for that answer, and it is deliberately end to
 * end: a real Orchestrator fan-out over two mock branches that disagree, so the
 * S2 hook (`maybeArbitrate`) is the thing under test, not a direct backend call.
 *
 * What it proves, in this order:
 *   0. configuration - a backend is really assembled from env (none = exit 2)
 *   1. reach         - the endpoint answered, and its JSON survived extraction
 *   2. the gate      - an uncalibrated LLM does not conclude by default
 *   3. opt-in        - with --allow-uncalibrated the same call does conclude
 *
 * Step 2 is the load-bearing one: a backend that silently never gets consulted
 * and one that gets consulted and refused look identical in a mock, and only a
 * live run can tell them apart.
 *
 * Usage (requires `npm run build` first — it runs the shipped implementation):
 *   node scripts/verify-decision-backend.mjs
 *   node scripts/verify-decision-backend.mjs --allow-uncalibrated
 *   node scripts/verify-decision-backend.mjs --threshold 0.5 --realm personal
 *
 * Env (see .env.example): ZEUS_LLM_BASE_URL / ZEUS_LLM_API_KEY / ZEUS_LLM_MODEL,
 * or the dedicated ZEUS_DECISION_* trio, which takes precedence.
 *
 * Exit codes: 0 the arbitration ran and behaved as the gate promises;
 *             1 the backend was reached but the result contradicts the gate;
 *             2 usage, missing configuration, or the backend never answered.
 * Requires Node 18+ (global fetch). Zero dependencies.
 */

import { Orchestrator, createLlmBackendFromEnv, createJevBackendFromEnv } from '../dist/index.js';

/** @param {string} [message] @returns {never} */
function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    [
      'usage: node scripts/verify-decision-backend.mjs [--allow-uncalibrated] [--threshold N] [--realm personal|enterprise]',
      '',
      'Runs a real fan-out that ends in an unresolved split and reports what the',
      'configured decision backend did with it.',
    ].join('\n')
  );
  process.exit(2);
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {{allowUncalibrated: boolean, threshold?: number, realm: 'personal'|'enterprise'}} */
  const flags = { allowUncalibrated: false, realm: 'personal' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-uncalibrated') flags.allowUncalibrated = true;
    else if (arg === '--threshold') {
      const raw = argv[++i];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) usage(`--threshold expects a number in 0..1, got ${String(raw)}`);
      flags.threshold = value;
    } else if (arg === '--realm') {
      const raw = argv[++i];
      if (raw !== 'personal' && raw !== 'enterprise') usage(`--realm expects personal or enterprise, got ${String(raw)}`);
      flags.realm = raw;
    } else usage(`unknown argument: ${String(arg)}`);
  }
  return flags;
}

/**
 * A completed A2A task carrying one stance, which is what the aggregator reads.
 * @param {string} vassal
 * @param {string} stance
 * @returns {import('../dist/index.js').DispatchResult}
 */
function branchResult(vassal, stance) {
  const id = `${vassal}-task`;
  return {
    ok: true,
    task: {
      kind: 'task',
      id,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
    },
    events: [{ kind: 'status-update', taskId: id, contextId: 'ctx', status: { state: 'completed' }, final: true }],
    injectedHits: [],
  };
}

const flags = parseFlags(process.argv.slice(2));

/** @type {any[]} */
const traces = [];

const backend =
  createJevBackendFromEnv(process.env) ?? createLlmBackendFromEnv(process.env, { onTrace: trace => traces.push(trace) });
if (!backend) {
  console.error('error: no decision backend configured; set ZEUS_DECISION_* or ZEUS_LLM_* (see .env.example)');
  process.exit(2);
}

const escalated = [];
const orchestrator = new Orchestrator(
  { findBySkill: () => [{ name: 'loom' }, { name: 'atlas' }] },
  {
    async dispatch(req) {
      return req.vassal === 'loom' ? branchResult('loom', 'approve') : branchResult('atlas', 'reject');
    },
    async cancel() {},
  },
  {
    newIntentId: () => 'intent-verify',
    newRunId: () => 'run-verify',
    decisionBackend: backend,
    onConflict: (_conflicts, result) => escalated.push(result),
    ...(flags.threshold !== undefined ? { arbitrationThreshold: flags.threshold } : {}),
    ...(flags.allowUncalibrated ? { allowUncalibratedArbitration: true } : {}),
  }
);

const started = Date.now();
const result = await orchestrator.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: flags.realm });
const elapsedMs = Date.now() - started;
const arbitration = result.backendArbitration;

console.log(`backend        ${backend.kind}/${backend.model}`);
console.log(`latency        ${elapsedMs}ms`);
console.log(`traces         ${traces.length}`);
console.log(`status         ${result.status}`);
console.log(`escalated      ${escalated.length}`);
console.log(`arbitration    ${arbitration ? JSON.stringify(arbitration) : 'none'}`);

if (!arbitration) {
  console.error('\nFAIL: the split never reached a backend; arbitration was not recorded');
  process.exit(2);
}
if (arbitration.backend !== backend.kind || arbitration.model !== backend.model) {
  console.error(`\nFAIL: arbitration names ${String(arbitration.backend)}/${String(arbitration.model)}, expected ${backend.kind}/${backend.model}`);
  process.exit(1);
}
if (typeof arbitration.confidence !== 'number') {
  console.error('\nFAIL: the backend answered but no confidence survived extraction; its JSON did not parse');
  process.exit(1);
}

const effectiveThreshold = flags.threshold ?? 0.8;

if (flags.allowUncalibrated) {
  if (!arbitration.concluded && arbitration.confidence < effectiveThreshold) {
    // Not a gate defect: the threshold is checked before calibration, so a
    // low-confidence answer is refused no matter what the opt-in says.
    console.error(
      `\nNOT CONCLUDED: confidence ${arbitration.confidence} is below the threshold ${effectiveThreshold}; pass --threshold ${Math.floor(arbitration.confidence * 10) / 10} to exercise the conclude path`
    );
    process.exit(2);
  }
  if (!arbitration.concluded) {
    console.error('\nFAIL: --allow-uncalibrated was set and confidence cleared the threshold, so the backend should conclude');
    process.exit(1);
  }
  if (result.conflicts.length !== 0 || result.decision.conclusion === null) {
    console.error('\nFAIL: concluded but the conflict was not cleared onto the decision');
    process.exit(1);
  }
  console.log(`\nPASS: ${backend.kind}/${backend.model} concluded "${String(arbitration.conclusion)}" (confidence ${arbitration.confidence}, calibrated false, opt-in honoured)`);
  process.exit(0);
}

if (arbitration.concluded) {
  console.error('\nFAIL: an uncalibrated backend concluded without --allow-uncalibrated; the gate is not holding');
  process.exit(1);
}
if (result.status !== 'needs-driver' || escalated.length !== 1) {
  console.error('\nFAIL: the unresolved split did not escalate to the driver as designed');
  process.exit(1);
}
console.log(
  `\nPASS: ${backend.kind}/${backend.model} was consulted (confidence ${arbitration.confidence}, calibrated false) and the gate refused to conclude; the split escalated to the driver`
);
process.exit(0);

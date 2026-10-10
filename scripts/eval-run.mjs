#!/usr/bin/env node
// @ts-check
/**
 * design-evals (tech map S7) V2 — offline eval runner (design-evals §5 V2).
 *
 * Reads the eval case set (evals/cases/index.mjs), boots one kernel per case
 * with scripted execution agents (fetchImpl), runs the intent, collects the
 * settled {outcome, audit, events} trace and feeds the V1 pure scorer
 * (src/evals/score.ts). Output is a machine-readable JSON report plus a
 * human-readable summary; the first run pins a baseline, later runs can diff
 * against it.
 *
 * Rules it obeys so it can run unattended: loopback-only scripted agents
 * (no real network), no state written outside the repo's evals/reports
 * directory, only the kernels it starts, and a wall-clock budget.
 *
 * Usage (requires `npm run build` first — it exercises the shipped artifact):
 *   node scripts/eval-run.mjs                     # run all cases, print summary
 *   node scripts/eval-run.mjs --write-baseline    # also pin evals/baseline.json
 *   node scripts/eval-run.mjs --baseline          # diff the run against the pinned baseline
 *   node scripts/eval-run.mjs --baseline-file f.json  # diff against an arbitrary baseline file
 *   node scripts/eval-run.mjs --filter data-policy
 *   node scripts/eval-run.mjs --out /tmp/eval.json
 * Exit codes: 0 every case passed, 1 any case failed or the diff regressed,
 * 2 cannot start (missing build).
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootKernel } from '../dist/state/boot.js';
import { scoreEvalRun, summarizeEvalRun, diffAgainstBaseline } from '../dist/evals/score.js';
import { evalCases } from '../evals/cases/index.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = join(REPO, 'evals/baseline.json');
const REPORTS_DIR = join(REPO, 'evals/reports');
const BUDGET_MS = 120_000;
const startedAt = Date.now();
const args = new Set(process.argv.slice(2));
const WRITE_BASELINE = args.has('--write-baseline');
const USE_BASELINE = args.has('--baseline') || args.has('--baseline-file');
const filter = (() => {
  const at = process.argv.indexOf('--filter');
  return at >= 0 ? process.argv[at + 1] : undefined;
})();
const outPath = (() => {
  const at = process.argv.indexOf('--out');
  return at >= 0 ? process.argv[at + 1] : undefined;
})();
// V3: defaults to the pinned evals/baseline.json; an explicit path lets CI
// matrices and tests diff against an arbitrary baseline without touching it.
const baselineFile = (() => {
  const at = process.argv.indexOf('--baseline-file');
  return at >= 0 ? (process.argv[at + 1] ?? BASELINE_PATH) : BASELINE_PATH;
})();

/** @type {Array<{ caseId: string, passed: boolean, detail: string }>} */
const lines = [];

/** @param {string} caseId @param {boolean} passed @param {string} [detail] */
function reportLine(caseId, passed, detail = '') {
  lines.push({ caseId, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${caseId}${detail ? `  ::  ${detail}` : ''}`);
}

/**
 * Build a scripted-agent fetch implementation for one case. Each agent answers
 * its agent-card and settles tasks with the declared stance/rationale from the
 * task data part (`stance` / `rationale` keys — the shapes src/orchestrator/
 * aggregate.ts extractStance reads). `dataPolicy` rides the card's fealty so
 * the data-policy family can exercise the origin gate. `fail` drives the
 * S10/S11 adversarial cases: the branch's task settles failed, so the recovery
 * chain (branch-failed -> escalate) is what the scorer observes. S12 planner
 * agents (`planner: true`) advertise the `planning` tag and, when `planDraft`
 * is set, return a structured DagSpec under the data part key `plan`. S15
 * streaming agents (`deltas`) emit working-frame status updates before the
 * final task so the dispatcher surfaces branch-delta increments.
 * @param {Array<{ name: string, stance?: string, rationale?: string, dataPolicy?: string, fail?: boolean, planner?: boolean, planDraft?: object, deltas?: string[] }>} agents
 */
function makeFetch(agents) {
  const byName = new Map(agents.map(a => [a.name, a]));
  return /** @type {typeof fetch} */ (async (input) => {
    const url = String(input);
    const name = url.split('/')[3] ?? '';
    const spec = byName.get(name);
    if (!spec) return new Response(JSON.stringify({ error: `no scripted agent named ${name}` }), { status: 404 });
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name, spec.dataPolicy ?? 'read-task-scope', spec.planner === true)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const frames = [];
    // S15: emit the agent's working-frame increments (one status-update per
    // delta) before the final task snapshot, in SSE order.
    for (const preview of spec.deltas ?? []) {
      frames.push({
        jsonrpc: '2.0',
        id: 2,
        result: {
          kind: 'status-update',
          id: `${name}-working`,
          contextId: 'eval',
          status: { state: 'working', data: { preview }, timestamp: '2026-10-10T00:00:00.000Z' },
        },
      });
    }
    if (spec.fail) {
      const failed = {
        kind: 'task',
        id: `${name}-task`,
        contextId: 'eval',
        status: { state: 'failed', message: { code: 'EVAL_SCRIPTED_FAIL', message: 'scripted failure for the adversarial case' } },
        artifacts: [],
      };
      frames.push({ jsonrpc: '2.0', id: 2, result: failed });
      return new Response(
        frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const artifacts = [{
      artifactId: 'a',
      name: 'verdict',
      parts: [
        { kind: 'data', data: { ...(spec.stance ? { stance: spec.stance } : {}), ...(spec.rationale ? { rationale: spec.rationale } : {}) } },
        // S12: a planner draft rides a data part keyed `plan`; anything else
        // (no draft) yields no structured candidate and is audited malformed.
        ...(spec.planDraft !== undefined ? [{ kind: 'data', data: { plan: spec.planDraft } }] : []),
      ],
    }];
    const task = {
      kind: 'task',
      id: `${name}-task`,
      contextId: 'eval',
      status: { state: 'completed' },
      artifacts,
    };
    frames.push({ jsonrpc: '2.0', id: 2, result: task });
    return new Response(
      frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
}

/** @param {string} name @param {string} dataPolicy @param {boolean} isPlanner */
function cardFor(name, dataPolicy, isPlanner) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'bayjf', url: 'http://bayjf.test' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: isPlanner
      ? [{ id: 'research', name: 'Research', description: 'reads the task scope', tags: ['planning'] }]
      : [{ id: 'research', name: 'Research', description: 'reads the task scope', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1', swornTo: 'zeus', domain: 'eval-domain',
      dataRealms: ['personal'], dataPolicy,
      reportBack: true, escalationPolicy: 'on-failure',
    },
  };
}

/** Bridge oversight escalations into the dispatch-audit view the scorer reads:
 *  an `escalated` action carrying interruptLevel becomes an
 *  `interrupt-level-N` decision row (design-hil S10: the level is a governance
 *  fact about when a human is required). The injected oversightAudit replaces
 *  boot's default bridge, so the escalation view comes from the desk's own
 *  entries rather than a second hand-rolled mapping.
 * @param {import('../dist/dispatch/dispatcher.js').AuditEntry[]} audits
 * @returns {(entry: import('../dist/oversight/types.js').OversightAuditEntry) => void}
 */
function makeOversightBridge(audits) {
  return (entry) => {
    if (entry.action === 'escalated' && entry.interruptLevel !== undefined) {
      audits.push({
        ts: entry.ts,
        vassal: entry.vassal,
        runId: entry.runId,
        decision: /** @type {import('../dist/dispatch/dispatcher.js').AuditEntry['decision']} */ (`interrupt-level-${entry.interruptLevel}`),
        detail: entry.escalationId,
      });
    }
  };
}

/**
 * @typedef {{
 *   id: string;
 *   skill: string;
 *   agents: Array<{ name: string, stance?: string, rationale?: string, dataPolicy?: string, fail?: boolean, planner?: boolean, planDraft?: object, deltas?: string[] }>;
 *   request: Record<string, unknown>;
 *   costLimit?: { maxWindowCost: number; circuitWindowMs: number };
 *   expect: Array<import('../dist/evals/types.js').EvalExpectation>;
 *   memory?: Array<{ id: string, subject: string, predicate: string, object: string }>;
 *   planFlow?: { goal: string; plannerSkills?: string[] };
 *   recovery?: { intents: Array<{ intentId: string, status: string, branch: Record<string, unknown> }>; maxAutoResumeMs?: number };
 *   isolation?: { transport: 'stdio' | 'http'; tier: string; manifest: Record<string, unknown>; authorizedRealms: string[]; containerRuntimeAvailable: boolean };
 * }} RunnerCase
 */

/** Build a personal-realm claim event for the guardrails family (S8): the
 *  memory assembly path scans recalled fact text through the content-risk
 *  chain, so a case seeds facts whose rendered text carries (or deliberately
 *  lacks) the adversarial signals.
 * @param {{ id: string, subject: string, predicate: string, object: string }} m
 * @returns {import('../dist/memory/types.js').MemoryEvent}
 */
function memoryClaim(m) {
  return {
    eventId: m.id,
    realmId: 'personal',
    runId: 'eval-memory-seed',
    source: { agentId: 'eval-seed' },
    kind: 'claim',
    content: { subject: m.subject, predicate: m.predicate, object: m.object },
    refs: [],
    confidence: 0.9,
    occurredAt: '2026-10-10T00:00:00.000Z',
  };
}

/** @param {RunnerCase} c */
async function runCase(c) {
  if (filter && !c.id.startsWith(filter)) return null;
  /** @type {import('../dist/dispatch/dispatcher.js').AuditEntry[]} */
  const audits = [];
  const kernel = await bootKernel({
    fetchImpl: makeFetch(c.agents),
    vassalSeeds: c.agents.map(a => `http://127.0.0.1/${a.name}/api/a2a/agent-card`),
    dispatchAudit: e => audits.push(e),
    oversightAudit: makeOversightBridge(audits),
    ...(c.costLimit !== undefined ? { costLimit: c.costLimit } : {}),
  });
  if (c.memory !== undefined) {
    for (const m of c.memory) kernel.memoryStore?.append(memoryClaim(m));
    kernel.memoryStore?.consolidateRealm('personal');
  }

  // S12 planning family: drive PlanFlow instead of a single fan-out. The
  // planner fan-outs land on the same dispatch-audit collection; require
  // confirmation so the case observes the verdict without executing the DAG.
  if (c.planFlow !== undefined) {
    const planFlow = kernel.planFlow;
    if (planFlow === undefined) throw new Error(`case ${c.id}: kernel has no planFlow component`);
    const planResult = await planFlow.run({
      goal: { description: c.planFlow.goal },
      realm: 'personal',
      ...(c.planFlow.plannerSkills !== undefined ? { plannerSkills: c.planFlow.plannerSkills } : {}),
      requireConfirmation: true,
    });
    const trace = { outcome: /** @type {import('../dist/orchestrator/types.js').FanOutResult} */ ({ intentId: '(planning)', runId: '(planning)', skill: c.skill, realm: 'personal', branches: [], stream: [], positions: [], decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'completed', createdAt: 't0' }), audit: audits, events: [], planFlow: planResult };
    return {
      caseDef: /** @type {import('../dist/evals/types.js').EvalCase} */ ({ id: c.id, world: null, agents: c.agents, input: c.request, expect: c.expect }),
      trace,
    };
  }

  // S13 recovery family: run one checkpoint through the pure recovery
  // executor; the recovery-* decisions land on the audit collection.
  if (c.recovery !== undefined) {
    const { executeRecovery } = await import('../dist/orchestrator/recovery.js');
    const checkpoint = /** @type {import('../dist/orchestrator/recovery.js').RecoveryCheckpoint} */ ({
      takenAt: '2026-10-10T00:00:00.000Z',
      intents: c.recovery.intents.map(i => ({
        intentId: i.intentId,
        status: /** @type {import('../dist/orchestrator/types.js').FanOutStatus} */ (i.status),
        branch: /** @type {import('../dist/orchestrator/recovery.js').RecoverableBranch} */ (i.branch),
      })),
    });
    await executeRecovery(checkpoint, {
      settleIntent: () => {},
      awaitOperator: () => {},
      autoResume: async () => {},
    }, {
      audit: e => audits.push(e),
      ...(c.recovery.maxAutoResumeMs !== undefined ? { maxAutoResumeMs: c.recovery.maxAutoResumeMs } : {}),
    });
    const trace = { outcome: /** @type {import('../dist/orchestrator/types.js').FanOutResult} */ ({ intentId: '(recovery)', runId: '(recovery)', skill: c.skill, realm: 'personal', branches: [], stream: [], positions: [], decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'completed', createdAt: 't0' }), audit: audits, events: [] };
    return {
      caseDef: /** @type {import('../dist/evals/types.js').EvalCase} */ ({ id: c.id, world: null, agents: c.agents, input: c.request, expect: c.expect }),
      trace,
    };
  }

  // S16 isolation family: classify + validate a registered body's declaration.
  if (c.isolation !== undefined) {
    const { classifyIsolation, validateIsolation } = await import('../dist/mcp/isolation.js');
    const manifest = /** @type {import('../dist/mcp/isolation.js').IsolationManifest} */ (c.isolation.manifest);
    const level = classifyIsolation({ transport: c.isolation.transport, tier: /** @type {import('../dist/trust/tier.js').TrustTier} */ (c.isolation.tier), manifest });
    const verdict = validateIsolation({ level, manifest, authorizedRealms: c.isolation.authorizedRealms, containerRuntimeAvailable: c.isolation.containerRuntimeAvailable });
    const trace = {
      outcome: /** @type {import('../dist/orchestrator/types.js').FanOutResult} */ ({ intentId: '(isolation)', runId: '(isolation)', skill: c.skill, realm: 'personal', branches: [], stream: [], positions: [], decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'completed', createdAt: 't0' }),
      audit: audits,
      events: [],
      isolation: { level, valid: verdict.ok, reasons: verdict.ok ? [] : verdict.reasons },
    };
    return {
      caseDef: /** @type {import('../dist/evals/types.js').EvalCase} */ ({ id: c.id, world: null, agents: c.agents, input: c.request, expect: c.expect }),
      trace,
    };
  }

  const intentId = `eval-${c.id.replaceAll('/', '-')}`;
  // S15 streaming family: collect the intent's progress spine (branch-delta /
  // intent-partial) through the booted hub before the fan-out dispatches.
  /** @type {import('../dist/orchestrator/progress.js').ProgressEvent[]} */
  const events = [];
  const unsubscribe = kernel.progressHub?.subscribe(intentId, e => events.push(e));
  try {
    const outcome = await kernel.orchestrator.fanOut(
      /** @type {import('../dist/orchestrator/types.js').FanOutRequest} */ ({
        intentId,
        skill: c.skill,
        ...c.request,
      }),
    );
    const trace = { outcome, audit: audits, events };
    return {
      caseDef: /** @type {import('../dist/evals/types.js').EvalCase} */ ({ id: c.id, world: null, agents: c.agents, input: c.request, expect: c.expect }),
      trace,
    };
  } finally {
    unsubscribe?.();
  }
}

/** @param {string} reason */
function fail(reason) {
  console.error(`FAIL  ${reason}`);
  process.exit(2);
}

if (!existsSync(join(REPO, 'dist/state/boot.js'))) {
  fail('run `npm run build` first - the runner exercises the shipped artifact, not the sources');
}

/** @type {import('../src/evals/score.js').EvalResult[]} */
const results = [];
for (const c of evalCases) {
  if (Date.now() - startedAt > BUDGET_MS) {
    fail(`wall-clock budget ${BUDGET_MS / 1000}s exceeded after ${results.length} cases`);
  }
  try {
    const ran = await runCase(c);
    if (ran === null) continue;
    const scored = scoreEvalRun(ran.caseDef, ran.trace);
    results.push(scored);
    const failedChecks = scored.checks.filter(ch => !ch.passed);
    reportLine(scored.caseId, failedChecks.length === 0,
      failedChecks.map(ch => `${ch.name}${ch.detail ? ` (${ch.detail})` : ''}`).join('; '));
  } catch (error) {
    reportLine(c.id, false, `aborted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const report = summarizeEvalRun(results);
console.log(`\n==== ${report.passed}/${report.passed + report.failed} checks passed (${report.caseCount} cases, ${report.blocked} blocked, ${report.warned} warned) ====`);
for (const [family, bucket] of Object.entries(report.byFamily)) {
  if (bucket.total > 0) console.log(`  ${family.padEnd(12)} ${bucket.passed}/${bucket.total} passed, ${bucket.blocked} blocked`);
}

// Machine-readable report: full case results + the metrics report.
const artifact = {
  ranAt: new Date().toISOString(),
  cases: results,
  report,
};
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
} else {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(REPORTS_DIR, `eval-${stamp}.json`), JSON.stringify(artifact, null, 2));
}

if (WRITE_BASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ pinnedAt: artifact.ranAt, report }, null, 2));
  console.log(`baseline pinned -> ${BASELINE_PATH}`);
}

if (USE_BASELINE) {
  if (!existsSync(baselineFile)) fail(`no baseline file at ${baselineFile} - run with --write-baseline first`);
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')).report;
  const regressions = diffAgainstBaseline(report, baseline);
  let blocked = false;
  if (regressions.length > 0) {
    console.log('regressions vs baseline:');
    for (const r of regressions) {
      if (r.severity === 'block') blocked = true;
      console.log(`  [${r.severity}] ${r.family}.${r.metric} ${r.previous} -> ${r.current}`);
    }
  } else {
    console.log('no regression vs baseline');
  }
  // design-evals V3: a block-severity regression (blocked count grew in any
  // family) is what the CI gate exists to catch — it must fail the run, not
  // just print. warn-severity (passed shrank) stays advisory for now.
  if (blocked) process.exit(1);
}

process.exit(report.failed > 0 ? 1 : 0);

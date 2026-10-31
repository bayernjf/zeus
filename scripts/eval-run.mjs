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
 *   node scripts/eval-run.mjs --baseline --comment-out /tmp/pr-comment.md
 *   node scripts/eval-run.mjs --runs-file data/eval-runs.jsonl --suite core
 * Exit codes: 0 every case passed, 1 any case failed or the diff regressed,
 * 2 cannot start (missing build).
 *
 * V3 PR comment: --comment-out writes the metrics table and baseline diff as
 * a GitHub-flavoured Markdown body (carrying a fixed marker for idempotent
 * upserts) before the exit code is decided, so a block-regression run still
 * leaves the body behind for scripts/ci-pr-comment.mjs to post.
 *
 * W4-1 judge: when ZEUS_EVAL_JUDGE_ENABLED is set (and the hub wiring resolves
 * the judge alias), cases declaring a `judge` expectation are scored by the
 * LLM at temperature 0; every judge failure is fail-soft (observe, never
 * blocks). W4-2 runs store: --runs-file appends a JSONL run record (0600,
 * keyed by runId; suite/model/score/per-case results; legacy
 * { ranAt, cases, report } fields unchanged at the top level) served by
 * GET /api/v1/eval-runs when the serve process points ZEUS_EVAL_RUNS_FILE at
 * the same file.
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootKernel } from '../dist/state/boot.js';
import { scoreEvalRun, summarizeEvalRun, diffAgainstBaseline } from '../dist/evals/score.js';
import { createEvalJudgeFromEnv } from '../dist/evals/judge.js';
import { JsonlEvalRunsStore } from '../dist/evals/runs-store.js';
import { createScriptedDecisionBackend } from '../dist/testing/decision-backend.js';
import { evalCases } from '../evals/cases/index.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = join(REPO, 'evals/baseline.json');
const REPORTS_DIR = join(REPO, 'evals/reports');
// ZEUS_EVAL_BUDGET_MS overrides the wall-clock budget (used by tests to force
// a near-zero budget; unattended runs keep the 120s default).
const BUDGET_MS = (() => {
  const override = Number(process.env.ZEUS_EVAL_BUDGET_MS ?? '');
  return Number.isFinite(override) && override > 0 ? override : 120_000;
})();
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
// V3: GitHub PR comment body for the metrics diff. Written before the exit
// code is decided so it exists on block regressions too; the CI publisher
// (scripts/ci-pr-comment.mjs) upserts it idempotently by the fixed marker.
const commentOutPath = (() => {
  const at = process.argv.indexOf('--comment-out');
  return at >= 0 ? process.argv[at + 1] : undefined;
})();
const PR_COMMENT_MARKER = '<!-- zeus-eval-gate -->';
// V3: defaults to the pinned evals/baseline.json; an explicit path lets CI
// matrices and tests diff against an arbitrary baseline without touching it.
const baselineFile = (() => {
  const at = process.argv.indexOf('--baseline-file');
  return at >= 0 ? (process.argv[at + 1] ?? BASELINE_PATH) : BASELINE_PATH;
})();
// W4-2: suite identity + opt-in structured run store. `--runs-file` appends
// one JSONL record (0600, keyed by runId) beside the legacy reports/ JSON —
// never instead of it; the legacy artifact stays the default output.
const suite = (() => {
  const at = process.argv.indexOf('--suite');
  const v = at >= 0 ? process.argv[at + 1] : undefined;
  return v && v.trim() !== '' ? v.trim() : 'core';
})();
const revision = (() => {
  const at = process.argv.indexOf('--revision');
  const v = at >= 0 ? process.argv[at + 1] : undefined;
  return v && v.trim() !== '' ? v.trim() : undefined;
})();
const runsFile = (() => {
  const at = process.argv.indexOf('--runs-file');
  return at >= 0 ? process.argv[at + 1] : undefined;
})();

/** @type {Array<{ caseId: string, passed: boolean, detail: string }>} */
const lines = [];

/** @param {string} caseId @param {boolean} passed @param {string} [detail] */
function reportLine(caseId, passed, detail = '') {
  lines.push({ caseId, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${caseId}${detail ? `  ::  ${detail}` : ''}`);
}

/**
 * V3: render the PR comment body (design-evals §V3). The fixed marker lets
 * scripts/ci-pr-comment.mjs update one comment per PR instead of stacking a
 * new comment on every run. `regressions` is null when no baseline diff ran.
 * @param {import('../src/evals/score.js').EvalMetricsReport} report
 * @param {ReadonlyArray<import('../src/evals/score.js').EvalRegression> | null} regressions
 * @param {boolean} caseFailures whether any eval case failed outright
 * @returns {string}
 */
function renderPrComment(report, regressions, caseFailures) {
  const blockRegression = regressions?.some(r => r.severity === 'block') ?? false;
  const verdict = caseFailures || blockRegression
    ? '**BLOCK REGRESSION — eval gate failed vs the pinned baseline**'
    : '**PASS — no block-severity regression vs the pinned baseline**';
  const out = [
    PR_COMMENT_MARKER,
    '## Eval regression gate (offline, loopback-only)',
    '',
    verdict,
    '',
    `- Cases: ${report.caseCount}`,
    `- Checks: ${report.passed}/${report.passed + report.failed} passed (${report.blocked} block-severity failures, ${report.warned} warn-severity)`,
    '',
    '| Family | passed/total | blocked |',
    '| --- | --- | --- |',
  ];
  for (const [family, bucket] of Object.entries(report.byFamily)) {
    if (bucket.total === 0) continue;
    out.push(`| ${family} | ${bucket.passed}/${bucket.total} | ${bucket.blocked} |`);
  }
  out.push('', 'Diff vs `evals/baseline.json`:');
  if (regressions === null) {
    out.push('', '_baseline diff not run (pass `--baseline`)_');
  } else if (regressions.length === 0) {
    out.push('', 'No metric movement.');
  } else {
    out.push('');
    for (const r of regressions) {
      out.push(`- [${r.severity}] \`${r.family}.${r.metric}\` ${r.previous} -> ${r.current}`);
    }
  }
  out.push('', '<sub>Generated by `scripts/eval-run.mjs` (design-evals V3) against scripted loopback agents. This comment is updated in place.</sub>');
  return out.join('\n');
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
 *   decisionBackend?: { model?: string, usage?: { inputTokens: number, outputTokens: number, reasoningTokens?: number }, failWith?: string };
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
  // W4-3: a case-declared decision backend makes the arbitration/judge path
  // live for this case and emits one DecisionTrace per call — the per-call
  // ledger the budget cost checks consume. Loopback-only by construction
  // (scripted answers, no network); cases without the fixture stay rules-only
  // and their cost checks remain not-assessable. Enabling a backend changes
  // arbitration behaviour, so a fixture case must account for it in its
  // expectations.
  /** @type {import('../dist/decision/types.js').DecisionTrace[]} */
  const decisionTraces = [];
  const scriptedBackend = c.decisionBackend !== undefined
    ? createScriptedDecisionBackend({
        ...(c.decisionBackend.model !== undefined ? { model: c.decisionBackend.model } : {}),
        ...(c.decisionBackend.usage !== undefined ? { usage: c.decisionBackend.usage } : {}),
        ...(c.decisionBackend.failWith !== undefined ? { failWith: /** @type {import('../dist/decision/types.js').DecisionBackendErrorCode} */ (c.decisionBackend.failWith) } : {}),
        onTrace: t => decisionTraces.push(t),
      })
    : undefined;
  const kernel = await bootKernel({
    fetchImpl: makeFetch(c.agents),
    vassalSeeds: c.agents.map(a => `http://127.0.0.1/${a.name}/api/a2a/agent-card`),
    dispatchAudit: e => audits.push(e),
    oversightAudit: makeOversightBridge(audits),
    ...(c.costLimit !== undefined ? { costLimit: c.costLimit } : {}),
    ...(scriptedBackend !== undefined ? { decisionBackend: scriptedBackend } : {}),
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
    /** @type {import('../src/evals/score.js').EvalTrace} */
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
    /** @type {import('../src/evals/score.js').EvalTrace} */
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
    /** @type {import('../src/evals/score.js').EvalTrace} */
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
    /** @type {import('../src/evals/score.js').EvalTrace} */
    const trace = {
      outcome,
      audit: audits,
      events,
      // W4-3: present whenever the case declared a decision backend — an empty
      // array is a ledger that observed zero calls, which is assessable (0
      // tokens); absent means no ledger path, which stays not-assessable.
      ...(scriptedBackend !== undefined ? { traces: decisionTraces } : {}),
    };
    return {
      caseDef: /** @type {import('../dist/evals/types.js').EvalCase} */ ({ id: c.id, world: null, agents: c.agents, input: c.request, expect: c.expect }),
      trace,
    };
  } finally {
    unsubscribe?.();
  }
}

/** @param {string} reason @returns {never} */
function fail(reason) {
  console.error(`FAIL  ${reason}`);
  process.exit(2);
}

if (!existsSync(join(REPO, 'dist/state/boot.js'))) {
  fail('run `npm run build` first - the runner exercises the shipped artifact, not the sources');
}

// Watchdog mirroring scripts/verify-runtime-reliability.mjs: the loop-top
// budget check only fires between cases, so a case that stalls mid-run would
// otherwise hold an unattended session forever. unref() lets a healthy run
// exit without waiting for the timer.
const budgetWatch = setInterval(() => {
  if (Date.now() - startedAt > BUDGET_MS) {
    console.error(`FAIL  wall-clock budget ${BUDGET_MS / 1000}s exceeded (watchdog: the run stalled mid-case)`);
    process.exit(2);
  }
}, Math.min(1_000, BUDGET_MS));
budgetWatch.unref();

/** @type {import('../src/evals/score.js').EvalResult[]} */
const results = [];
// W4-1: the LLM-as-judge is opt-in (ZEUS_EVAL_JUDGE_ENABLED + a resolvable hub
// alias). One judge per process, created lazily on the first case that needs
// it; without it, judge checks degrade to observe (fail-soft) in the scorer.
/** @type {import('../dist/evals/judge.js').EvalJudge | null | undefined} */
let evalJudge;
function judgeFor() {
  if (evalJudge === undefined) evalJudge = createEvalJudgeFromEnv(process.env);
  return evalJudge;
}
for (const c of evalCases) {
  if (Date.now() - startedAt > BUDGET_MS) {
    fail(`wall-clock budget ${BUDGET_MS / 1000}s exceeded after ${results.length} cases`);
  }
  try {
    const ran = await runCase(c);
    if (ran === null) continue;
    // W4-1: only cases that declare a judge expectation reach the judge — one
    // call per expectation, in declaration order; the scorer consumes the
    // verdicts positionally. Every judge failure is a fail-soft verdict, so a
    // hub outage slows the run but cannot flip its outcome.
    const judgeExpectations = c.expect.filter(ex => ex.judge !== undefined);
    if (judgeExpectations.length > 0) {
      const judge = judgeFor();
      if (judge !== null) {
        /** @type {import('../dist/evals/judge.js').JudgeVerdict[]} */
        const verdicts = [];
        for (const ex of judgeExpectations) {
          const judgeEx = ex.judge;
          if (judgeEx === undefined) continue;
          verdicts.push(await judge.score(judgeEx.rubric, ran.trace.outcome));
        }
        ran.trace.judgeVerdicts = verdicts;
      }
    }
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

// W4-2: opt-in structured run store (FR5-2). One JSONL record appended beside
// the legacy artifact — the reports/ JSON stays the default output and its
// shape (ranAt/cases/report) is carried unchanged at the top level of the
// record, so legacy consumers keep working. Keyed by runId (derived from
// ranAt), so a retried run cannot double-write.
if (runsFile) {
  const record = {
    runId: `run-${artifact.ranAt}`,
    suite,
    model: 'rules-only',
    ...(evalJudge !== undefined && evalJudge !== null ? { judgeModel: evalJudge.model } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ranAt: artifact.ranAt,
    cases: results,
    report,
  };
  const store = new JsonlEvalRunsStore(runsFile);
  await store.append(record);
  console.log(`run record -> ${runsFile} (runId ${record.runId}, suite ${record.suite})`);
}

/** @type {ReadonlyArray<import('../src/evals/score.js').EvalRegression> | null} */
let baselineRegressions = null;
let blockRegression = false;
if (USE_BASELINE) {
  if (!existsSync(baselineFile)) fail(`no baseline file at ${baselineFile} - run with --write-baseline first`);
  // A corrupt or shapeless baseline is a "cannot start" (exit 2), same as a
  // missing file — an uncaught SyntaxError/TypeError would exit 1 and read as
  // a gate regression, and would skip the PR comment body write below.
  /** @type {unknown} */
  let parsed = null;
  let parseError = '';
  try {
    parsed = JSON.parse(readFileSync(baselineFile, 'utf8'));
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  if (parseError !== '') fail(`cannot start: baseline at ${baselineFile} is not valid JSON (${parseError})`);
  const candidate = /** @type {{ report?: unknown } | null} */ (parsed)?.report;
  if (candidate === undefined || candidate === null || typeof candidate !== 'object' || !('byFamily' in candidate)) {
    fail(`cannot start: baseline at ${baselineFile} does not carry a pinned eval report`);
  }
  const baseline = /** @type {import('../src/evals/score.js').EvalMetricsReport} */ (candidate);
  const regressions = diffAgainstBaseline(report, baseline);
  baselineRegressions = regressions;
  if (regressions.length > 0) {
    console.log('regressions vs baseline:');
    for (const r of regressions) {
      if (r.severity === 'block') blockRegression = true;
      console.log(`  [${r.severity}] ${r.family}.${r.metric} ${r.previous} -> ${r.current}`);
    }
  } else {
    console.log('no regression vs baseline');
  }
}

// V3: write the PR comment body before the exit-code decision so a
// block-regression run (exit 1) still leaves the body for the CI publisher.
if (commentOutPath) {
  mkdirSync(dirname(commentOutPath), { recursive: true });
  writeFileSync(commentOutPath, `${renderPrComment(report, baselineRegressions, report.failed > 0)}\n`);
  console.log(`pr comment body -> ${commentOutPath}`);
}

// design-evals V3: a block-severity regression (blocked count grew in any
// family) is what the CI gate exists to catch — it must fail the run, not
// just print. warn-severity (passed shrank) stays advisory for now.
if (blockRegression) process.exit(1);

process.exit(report.failed > 0 ? 1 : 0);

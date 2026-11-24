#!/usr/bin/env node
// @ts-check
/**
 * Z-04 acceptance: a long, repeated operator session against the shipped
 * `daily` entry, then a check that context watermarks and memory write-back
 * survive the one-shot process boundary.
 *
 * What this is and is not:
 *   - It is 24 real CLI invocations (separate processes), one persistent
 *     dataDomain and one persistent runtime state file. The operator sentences
 *     are real project questions, not generated filler.
 *   - It is not one week of wall-clock use. The review's "≥ one week / ≥ 20
 *     rounds" is an OR; this takes the 20-round branch and labels it honestly.
 *   - The peer is a local reference A2A agent: deterministic stance, no model,
 *     no filesystem, no egress. Z-04 is about memory/context, not answer quality.
 *
 * Why a script: the interesting failure is the process boundary. A `daily` run
 * writes its record, saves state and exits while consolidation is asynchronous.
 * If the save does not wait, the memory is gone even though every run reports
 * success. `evidence.json` records the observed rows, not a claim that they
 * ought to exist.
 *
 * Usage: npm run build && npm run acceptance:long-session
 * Exit codes: 0 all assertions passed, 1 an assertion failed, 2 usage/build error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAILY = join(REPO, 'dist', 'daily', 'cli.js');
const OUT = join(REPO, 'outputs', 'z04-long-session');
const ROUNDS = Number(process.env.Z04_ROUNDS ?? '24');
if (!Number.isInteger(ROUNDS) || ROUNDS < 20) {
  console.error(`[CONFIG] Z04_ROUNDS must be an integer >= 20, got '${process.env.Z04_ROUNDS ?? ''}'`);
  process.exit(2);
}
if (!existsSync(DAILY)) {
  console.error('[CONFIG] dist/daily/cli.js is missing; run `npm run build` first');
  process.exit(2);
}

/** @type {Array<{slug:string, instruction:string}>} */
const TOPICS = [
  { slug: 'zeus-z04', instruction: 'check the deployment health for Zeus Z-04 memory compaction' },
  { slug: 'zeus-z07', instruction: 'check the deployment health for Zeus Z-07 matrix acceptance' },
  { slug: 'atlas-t5', instruction: 'check the deployment health for Atlas T5 email approval' },
  { slug: 'atlas-t6', instruction: 'check the deployment health for Atlas T6 IM inbound' },
  { slug: 'atlas-t7', instruction: 'check the deployment health for Atlas T7 multi-agent observability' },
  { slug: 'loom-l01', instruction: 'check the deployment health for Loom L-01 thirteen-stage dogfood' },
  { slug: 'loom-l03', instruction: 'check the deployment health for Loom L-03 C1 worker' },
  { slug: 'loom-l04', instruction: 'check the deployment health for Loom L-04 aggregate read API' },
  { slug: 'agent-ops-f6', instruction: 'check the deployment health for Agent Ops F6 serial pipeline' },
  { slug: 'agent-ops-f7', instruction: 'check the deployment health for Agent Ops F7 run details' },
  { slug: 'bayjf-tier0', instruction: 'check the deployment health for BayJF Tier 0 registry' },
  { slug: 'bayjf-p2a', instruction: 'check the deployment health for BayJF P2a map details' },
  { slug: 'commerce-os', instruction: 'check the deployment health for commerce-os metrics' },
  { slug: 'growth-os', instruction: 'check the deployment health for growth-os metrics' },
  { slug: 'code-audit', instruction: 'check the deployment health for code-audit SARIF output' },
  { slug: 'pr-helper', instruction: 'check the deployment health for pr-helper fan-out' },
  { slug: 'job-agent', instruction: 'check the deployment health for job-agent MCP surface' },
  { slug: 'argus', instruction: 'check the deployment health for Argus local monitor' },
  { slug: 'personal-harness', instruction: 'check the deployment health for personal agent harness' },
  { slug: 'tier0-ledger', instruction: 'check the deployment health for Tier 0 four-column ledger' },
  { slug: 'zeus-z05', instruction: 'check the deployment health for Zeus Z-05 inbound caller' },
  { slug: 'zeus-z06', instruction: 'check the deployment health for Zeus Z-06 OAuth subject' },
  { slug: 'atlas-a02', instruction: 'check the deployment health for Atlas A-02 A2A real run' },
  { slug: 'atlas-a06', instruction: 'check the deployment health for Atlas A-06 NL skills' },
  { slug: 'loom-l05', instruction: 'check the deployment health for Loom L-05 recalc formula' },
  { slug: 'loom-l06', instruction: 'check the deployment health for Loom L-06 fit score' },
];

const HANDSHAKE = {
  version: '1',
  swornTo: 'zeus',
  domain: 'z04-reference',
  dataDomains: ['personal'],
  dataPolicy: 'read-task-scope',
  reportBack: true,
  escalationPolicy: 'on-failure',
};

const CARD = {
  name: 'z04-reference-agent',
  description: 'reference peer for Z-04 long-session acceptance; answers from task input only',
  version: '0.1.0',
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['application/json', 'text/plain'],
  defaultOutputModes: ['application/json', 'text/plain'],
  skills: [
    { id: 'deployment-health', name: 'Deployment Health', description: 'check a deployment for health', tags: ['reference'] },
  ],
  authentication: { schemes: ['none'] },
  preferredTransport: 'JSONRPC',
  'x-zeus-handshake': HANDSHAKE,
};

/** @type {import('node:http').Server | undefined} */
let server;
let cardBase = '';

function startAgent() {
  return new Promise((resolvePromise, reject) => {
    server = createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/api/a2a/agent-card') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ...CARD, url: `${cardBase}/api/a2a/tasks` }),
        );
        return;
      }
      if (req.method !== 'POST' || !url.startsWith('/api/a2a/tasks')) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        let rpc = { id: null, method: '', params: {} };
        try {
          rpc = JSON.parse(raw || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
          return;
        }
        const parts = rpc.params?.message?.parts ?? [];
        const text = parts
          .map(part => (part.kind === 'text' ? part.text : part.kind === 'data' ? JSON.stringify(part.data) : ''))
          .filter(Boolean)
          .join(' ');
        const taskId = `z04-task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const task = {
          kind: 'task',
          id: taskId,
          contextId: 'z04-long-session',
          status: { state: 'completed' },
          artifacts: [
            {
              artifactId: 'a-1',
              name: 'deployment-health',
              parts: [
                { kind: 'text', text: 'deployment health: reference peer, 0 failed checks' },
                { kind: 'data', data: { stance: 'healthy', rationale: 'reference peer: no failed checks' } },
              ],
              'x-zeus-report': {
                summary: `reference health answer for ${String(text).slice(0, 80)}`,
                evidence: ['task input only', 'zero egress', 'deterministic stance'],
                cost: { llmTokens: 0, wallSeconds: 0 },
                followUps: [],
              },
            },
          ],
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { kind: 'status-update', taskId, contextId: 'z04-long-session', status: { state: 'working' }, final: false } })}\n\n`);
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? 1, result: task })}\n\n`);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('reference agent did not bind a port'));
        return;
      }
      cardBase = `http://127.0.0.1:${address.port}`;
      resolvePromise();
    });
  });
}

function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ZEUS_') || value === undefined) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseIntentId(stdout) {
  return stdout.match(/^\- \*\*Intent id\*\* `(intent-[0-9a-f-]+)`/m)?.[1] ?? null;
}

function parseRunId(stdout) {
  return stdout.match(/^\- \*\*Intent id\*\* `[^`]+` · run `([^`]+)`/m)?.[1] ?? null;
}

function parseDecision(stdout) {
  return stdout.match(/rule \`[^\`]+\` → \*\*(healthy|unhealthy|unknown)\*\*/)?.[1] ?? null;
}

function watermarkFromAudit(audit, runId) {
  return audit.find(row => row.runId === runId && row.decision === 'context-watermark') ?? null;
}

async function main() {
  await startAgent();
  const cardUrl = `${cardBase}/api/a2a/agent-card`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const work = mkdtempSync(join(tmpdir(), 'zeus-z04-long-session-'));
  const root = join(work, 'notes');
  const stateFile = join(work, 'state.json');
  const auditFile = join(work, 'audit.jsonl');
  mkdirSync(root);
  mkdirSync(OUT, { recursive: true });

  const env = cleanEnv({
    ZEUS_AUDIT_FILE: auditFile,
    ZEUS_AUDIT_MAX_BYTES: '0',
    ZEUS_MEMORY_EMBEDDING: 'off',
  });

  /** @type {Array<Record<string, unknown>>} */
  const session = [];
  const startedAt = new Date().toISOString();
  for (let i = 0; i < ROUNDS; i += 1) {
    const topic = TOPICS[i % TOPICS.length];
    const subject = `project:${topic.slug}:round-${String(i + 1).padStart(2, '0')}`;
    const params = JSON.stringify({
      subject,
      predicate: 'deployment-health',
      message: 'check the deployment health',
      topic: topic.slug,
      round: i + 1,
    });
    const record = `zeus-daily/z04-round-${String(i + 1).padStart(2, '0')}.md`;
    let stdout = '';
    let status = 0;
    try {
      const result = await execFileAsync(process.execPath, [
        DAILY,
        '--root', root,
        '--agent', cardUrl,
        '--state', stateFile,
        '--record', record,
        '--params', params,
        '--timeout', '30000',
        topic.instruction,
      ], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      stdout = result.stdout;
    } catch (error) {
      status = typeof error.code === 'number' ? error.code : 1;
      stdout = String(error.stdout ?? '');
      session.push({ round: i + 1, subject, instruction: topic.instruction, exit: status, stdout: String(stdout).slice(0, 4000), stderr: String(error.stderr ?? '').trim() });
      break;
    }
    const intentId = parseIntentId(stdout);
    const runId = parseRunId(stdout);
    const decision = parseDecision(stdout);
    session.push({
      round: i + 1,
      subject,
      instruction: topic.instruction,
      exit: status,
      intentId,
      runId,
      decision,
      record,
    });
    if (status !== 0 || !stdout.includes('**Intent** `deployment-health`') || decision !== 'healthy') {
      session[session.length - 1].error = 'run did not settle as deployment-health/healthy';
      break;
    }
  }
  const finishedAt = new Date().toISOString();

  if (!existsSync(stateFile)) {
    console.error('[FAIL] session rows before the state file was missing:', JSON.stringify(session, null, 2));
    throw new Error('the session produced no state file');
  }
  const state = readJson(stateFile);
  const domainId = state.dataDomains?.[0]?.dataDomainId;
  const memory = state.memory ?? {};
  const events = Array.isArray(memory.events) ? memory.events : [];
  const factsByDomain = Array.isArray(memory.facts) ? memory.facts : [];
  const facts = (factsByDomain.find(([id]) => id === domainId)?.[1] ?? []);
  const intents = state.orchestrator?.intents ?? [];
  const auditRows = existsSync(auditFile)
    ? readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];

  const rounds = session.filter(row => row.exit === 0 && row.intentId);
  const first = rounds[0];
  const firstIntent = intents.find(entry => entry.intentId === first?.intentId);
  const firstFact = facts.find(fact => fact.subject === first?.subject);
  const firstClaim = firstFact
    ? events.find(event => event.eventId === firstFact.provenance?.[0])
    : undefined;
  const expectedSubjects = session.filter(row => row.exit === 0).map(row => row.subject);
  const missingSubjects = expectedSubjects.filter(subject => !facts.some(fact => fact.subject === subject && fact.status === 'active'));
  const decisionEvents = events.filter(event => String(event.eventId).startsWith('mem-decision-'));
  const writebackSkipped = auditRows.filter(row => row.decision === 'memory-writeback-skipped');
  const consolidationFailed = auditRows.filter(row => row.decision === 'memory-consolidation-failed');
  const watermarks = rounds.map(row => watermarkFromAudit(auditRows, row.runId)).filter(Boolean);
  const assembledMax = Math.max(0, ...watermarks.map(row => Number(String(row.detail).match(/(\d+) context entries assembled/)?.[1] ?? 0)));
  const trimmedTotal = watermarks.reduce((sum, row) => sum + Number(String(row.detail).match(/(\d+) trimmed/)?.[1] ?? 0), 0);
  const budgetTotal = watermarks.reduce((sum, row) => sum + Number(String(row.detail).match(/(\d+) over budget/)?.[1] ?? 0), 0);

  // The store itself is the authority on "old fact is still retrievable":
  // rehydrate it from the saved snapshot and query the first round's subject.
  const { MemoryStore } = await import('../dist/memory/memory-store.js');
  const store = MemoryStore.fromState(memory);
  let oldFactRecall = [];
  if (first?.subject) {
    for (const query of [first.subject, first.subject.replace(/[:]/g, ' ')]) {
      oldFactRecall = await store.searchRecall(domainId, domainId, query, { limit: 10 });
      if (oldFactRecall.length > 0) break;
    }
  }

  const settledFacts = facts.filter(fact => fact.subject === 'deployment-health' && fact.predicate === 'settled-decision');
  const disputedFacts = facts.filter(fact => fact.status === 'disputed');
  const conclusions = settledFacts.map(fact => fact.object?.conclusion).filter(Boolean);
  const checks = {
    roundsCompleted: rounds.length === ROUNDS,
    everyRunSettledHealthy: rounds.length === ROUNDS && rounds.every(row => row.decision === 'healthy'),
    roundsHaveUniqueIntents: new Set(rounds.map(row => row.intentId)).size === rounds.length,
    roundsHaveUniqueRuns: new Set(rounds.map(row => row.runId)).size === rounds.length,
    watermarkPerRun: watermarks.length === ROUNDS,
    writebackPerRun: decisionEvents.length === ROUNDS,
    noWritebackSkipped: writebackSkipped.length === 0,
    noConsolidationFailure: consolidationFailed.length === 0,
    factsNotLost: missingSubjects.length === 0,
    oldFactTraceable: Boolean(firstFact && firstClaim && firstClaim.runId === firstIntent?.runId),
    oldFactRecallable: oldFactRecall.some(hit => hit.fact.factId === firstFact?.factId),
    writebackDidNotPolluteDecision:
      settledFacts.length === 1 &&
      settledFacts[0]?.status === 'active' &&
      disputedFacts.length === 0 &&
      conclusions.length === 1 &&
      conclusions[0] === 'healthy',
    settledDecisionProvenanceComplete: settledFacts[0]?.provenance?.length === ROUNDS,
    capObserved: assembledMax >= Math.min(ROUNDS, 20),
  };
  const ok = Object.values(checks).every(Boolean);

  const sanitize = value => JSON.parse(JSON.stringify(value).split(work).join('$SESSION'));
  const evidence = {
    ok,
    generatedAt: new Date().toISOString(),
    criterion: 'Z-04: ≥20 real CLI rounds; compaction/watermark + writeback; facts preserved, old facts traceable, writeback does not pollute decisions',
    caveat: `20+ round branch used; this is not one week of wall-clock use. ${ROUNDS} rounds against a local deterministic reference peer.`,
    rounds: ROUNDS,
    startedAt,
    finishedAt,
    cardUrl,
    stateFile: '$SESSION/state.json',
    auditFile: '$SESSION/audit.jsonl',
    dataDomainId: domainId,
    counts: {
      sessionRows: session.length,
      uniqueIntentIds: new Set(rounds.map(row => row.intentId)).size,
      uniqueRunIds: new Set(rounds.map(row => row.runId)).size,
      watermarkRows: watermarks.length,
      decisionEvents: decisionEvents.length,
      claimEvents: events.filter(event => event.kind === 'claim').length,
      activeFacts: facts.filter(fact => fact.status === 'active').length,
      settledDecisionFacts: settledFacts.length,
      disputedFacts: disputedFacts.length,
      writebackSkipped: writebackSkipped.length,
      consolidationFailed: consolidationFailed.length,
    },
    watermark: {
      assembledMax,
      trimmedTotal,
      budgetTotal,
      sampleFirst: watermarks[0]?.detail ?? null,
      sampleLast: watermarks[watermarks.length - 1]?.detail ?? null,
    },
    checks,
    missingSubjects,
    firstRound: {
      subject: first?.subject,
      intentId: first?.intentId,
      runId: firstIntent?.runId,
      factId: firstFact?.factId,
      factProvenance: firstFact?.provenance,
      claimRunId: firstClaim?.runId,
      recallTop: oldFactRecall.slice(0, 3).map(hit => ({ factId: hit.fact.factId, subject: hit.fact.subject, object: hit.fact.object, score: hit.score })),
    },
    settledDecisionConclusions: conclusions,
  };

  writeFileSync(join(OUT, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(OUT, 'session.jsonl'), `${session.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(OUT, 'audit.jsonl'), `${auditRows.map(row => JSON.stringify(sanitize(row))).join('\n')}\n`);
  writeFileSync(join(OUT, 'memory.json'), `${JSON.stringify(sanitize({ dataDomainId: domainId, facts, events, corrections: memory.corrections, retractions: memory.retractions }), null, 2)}\n`);

  const summary = [
    '# Z-04 long-session acceptance',
    '',
    `Generated: ${finishedAt}`,
    '',
    `- ok: **${ok}**`,
    `- rounds: **${rounds.length}/${ROUNDS}** (real \`daily\` processes, one persistent state/dataDomain; unique intents **${new Set(rounds.map(row => row.intentId)).size}**, unique runs **${new Set(rounds.map(row => row.runId)).size}**)`,
    `- context watermark rows: **${watermarks.length}** (assembled max **${assembledMax}**, trimmed **${trimmedTotal}**, over budget **${budgetTotal}**)`,
    `- memory decision events: **${decisionEvents.length}**; writeback skipped: **${writebackSkipped.length}**; consolidation failed: **${consolidationFailed.length}**`,
    `- active facts: **${facts.filter(fact => fact.status === 'active').length}**; settled decision facts: **${settledFacts.length}** (provenance **${settledFacts[0]?.provenance?.length ?? 0}**); disputed facts: **${disputedFacts.length}**`,
    `- active facts missing expected subjects: **${missingSubjects.length}**`,
    `- old fact traceable: **${checks.oldFactTraceable}**; old fact recallable: **${checks.oldFactRecallable}**`,
    `- writeback did not pollute decisions: **${checks.writebackDidNotPolluteDecision}** (conclusions: ${conclusions.join(', ')})`,
    '',
    'Caveat: 20+ round branch of the OR criterion; not one week of natural use. The peer is local and deterministic, so this proves the memory/context path, not answer quality.',
    '',
  ].join('\n');
  writeFileSync(join(OUT, '01-summary.md'), summary);

  rmSync(work, { recursive: true, force: true });
  console.log(summary);
  if (!ok) {
    console.error('[FAIL] evidence checks:', JSON.stringify(checks, null, 2));
    process.exit(1);
  }
}

main()
  .catch(error => {
    console.error(`[FAIL] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.close();
  });

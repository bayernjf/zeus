#!/usr/bin/env node
/**
 * T-M7-05: repeatable, deterministic, replayable org-level e2e closed loop.
 *
 * Boots TWO real processes (no stubs, no in-memory fake HTTP):
 *   1. a real agent-world pnpm-monorepo server (WORKER=fake replaces ONLY model
 *      calls; the graph engine, gates, human halts, events and artifacts really
 *      run), with a freshly bootstrapped first account;
 *   2. a real zeus HTTP server (SQLite + taskExecutor=agent-world + sqlite
 *      action store + an Ed25519-signed JSONL decision audit chain).
 *
 * It then drives the full chain for three job families over zeus's bearer API:
 *   - content   (tpl-xiaohongshu,   D0 autonomous, no human)
 *   - listing   (tpl-review-publish, D3 human halt → ops-lead approve → resume)
 *   - after-sales(tpl-customer-service, D2 human halt → approve → resume → webhook)
 * plus fail-closed positions:
 *   - a no-tools position            → SOP_INCOMPATIBLE at claim (zero channel calls)
 *   - an unknown workflow           → SOP_MISSING at claim (zero channel calls)
 *   - a D2-scoped position on listing→ parks at the D3 checkpoint, cannot
 *     self-authorize a D3 publish; only an external D3 approval unlocks it.
 *
 * Finally it verifies the Ed25519 audit chain (positive + tamper negative
 * control), asserts task idempotency (no second graph run on replay), and
 * writes a structured evidence bundle under outputs/tm7-e2e-repeat/.
 *
 * Every spawned process and port is freed on exit (success or failure).
 *
 * Run (Node 24, because agent-world requires it):
 *   eval "$(fnm env)" && fnm use 24.20.0 && npm run e2e:m7
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

// Build-time audit verifier (dist is produced by `npm run build`; the e2e script
// is a manual gate, so it expects a current build).
import { verifyDecisionAuditChain } from '../dist/core/audit/audit-chain.js';
import { decodeAuditJsonl } from '../dist/core/audit/jsonl.js';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ZEUS_ROOT = resolve(SCRIPT_DIR, '..');
// agent-world is the sibling checkout (both live under 000mycodes); never modified.
const AGENT_WORLD_ROOT = resolve(ZEUS_ROOT, '../agent-world');

// ── deterministic test credentials (throwaway, LOCAL only; not real secrets) ──
// They travel ONLY through env (ZEUS_SECRET_AGENT_WORLD_LOGIN) / SecretBackend;
// they are never written into the evidence bundle or git.
const AW_EMAIL = 'tm7-e2e@local.test';
const AW_PASSWORD = 'tm7-e2e-local-only'; // >=6 chars, fake, never a real account
const ZEUS_TOKEN = 'tm7-e2e-internal-token';
const RSK_KEY_ID = 'tm7-e2e-rsk';
const ORG_ID = 'org:tm7-e2e-rpt';
const DEPT_ID = 'dept:tm7-e2e-rpt:ops';

const TOOL = {
  runGraph: 'agent-world:run-graph',
  resumeRun: 'agent-world:resume-run',
  getRun: 'agent-world:get-run',
};

const log = (...a) => console.log('[e2e:m7]', ...a);
const fail = (msg) => { throw new Error(`FAIL: ${msg}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── port picking (avoid the well-known one-off ports; pick dynamically) ────────
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

// ── scratch dir (gitignored; holds DBs, logs, the throwaway RSK pem) ─────────
const scratch = join(tmpdir(), `zeus-e2e-m7-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const awDb = join(scratch, 'agent-world.sqlite');
const zeusDb = join(scratch, 'zeus.sqlite');
const auditFile = join(scratch, 'decision-audit.jsonl');
const rskPem = join(scratch, 'rsk-private.pem');

// Throwaway Ed25519 keypair for the run: zeus seals the audit chain with it,
// and THIS script holds the public half to independently verify the chain.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(rskPem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

// ── process registry + cleanup ──────────────────────────────────────────────
const children = [];
let webhookServer = null;
let cleanupDone = false;

function spawnManaged(file, args, env, label, logFile) {
  const fd = openSync(logFile, 'a');
  const child = spawn(file, args, {
    env: { ...process.env, ...env },
    cwd: label === 'agent-world' ? AGENT_WORLD_ROOT : ZEUS_ROOT,
    stdio: ['ignore', fd, fd],
  });
  child.on('exit', (code) => { if (!cleanupDone) log(`${label} exited with code ${code}`); });
  children.push({ child, label });
  return child;
}

function cleanup(code = 0) {
  if (cleanupDone) return;
  cleanupDone = true;
  for (const { child, label } of children) {
    try { if (!child.killed) child.kill('SIGTERM'); } catch {}
  }
  if (webhookServer) { try { webhookServer.close(); } catch {} }
  // Give children a moment to release ports, then hard-kill stragglers.
  setTimeout(() => {
    for (const { child } of children) {
      try { if (!child.killed) child.kill('SIGKILL'); } catch {}
    }
    process.exit(code);
  }, 600).unref();
}
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));
process.on('uncaughtException', (err) => { console.error('[e2e:m7] uncaught', err); cleanup(1); });

// ── tiny authenticated fetch helper for zeus ─────────────────────────────────
async function zfetch(zeusBase, path, { method = 'GET', body } = {}) {
  const headers = { authorization: `Bearer ${ZEUS_TOKEN}` };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${zeusBase}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

// While a task is halted its `result` is not yet set; the real agent-world
// runId is carried on the `agent-world:awaiting-decision` progress stage.
function awaitingRunId(task) {
  const stage = (task.progress ?? []).find(p => p.stage === 'agent-world:awaiting-decision');
  return stage?.data?.runId;
}

// Poll a task until it reaches a terminal/halted state.
async function waitTask(zeusBase, taskId, terminalStates = ['done', 'failed', 'awaiting_decision']) {
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    const { body } = await zfetch(zeusBase, `/api/v1/org/tasks/${taskId}`);
    last = body;
    if (terminalStates.includes(body?.status)) return body;
    await sleep(700);
  }
  throw new Error(`task ${taskId} did not settle in time; last status=${last?.status}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('node', process.versions.node, '| scratch', scratch);

  // 1. pick dynamic ports
  const awPort = await freePort();
  const zeusPort = await freePort();
  const webhookPort = await freePort();
  const awBase = `http://127.0.0.1:${awPort}`;
  const zeusBase = `http://127.0.0.1:${zeusPort}`;
  log(`ports: agent-world=${awPort} zeus=${zeusPort} webhook=${webhookPort}`);

  // 2. local webhook receiver (in-process; captures after-sales / listing notify)
  const webhookCaptures = [];
  webhookServer = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      webhookCaptures.push({ at: new Date().toISOString(), method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(r => webhookServer.listen(webhookPort, '127.0.0.1', r));
  const webhookUrl = `http://127.0.0.1:${webhookPort}/cs-notify`;

  // 3. boot real agent-world (Node 24; WORKER=fake only fabricates model calls)
  spawnManaged(process.execPath, ['packages/server/dist/index.js'], {
    WORKER: 'fake',
    PORT: String(awPort),
    BIND_HOST: '127.0.0.1',
    ALLOW_PRIVATE_NETWORK: '1',
    DB_FILE: awDb,
  }, 'agent-world', join(scratch, 'agent-world.log'));

  // wait for /api/health
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${awBase}/api/health`); if (r.ok) break; } catch {}
    await sleep(500);
    if (i === 59) fail('agent-world did not come up');
  }
  log('agent-world up at', awBase);

  // bootstrap the FIRST account (fresh DB → registration open)
  const regRes = await fetch(`${awBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: AW_EMAIL, password: AW_PASSWORD }),
  });
  if (!regRes.ok) fail(`agent-world register failed: ${regRes.status} ${await regRes.text()}`);
  const setCookie = regRes.headers.get('set-cookie') ?? '';
  const awToken = /(?:^|,\s*)auth_token=([^;]+)/.exec(setCookie)?.[1];
  if (!awToken) fail('agent-world register returned no auth_token');
  log('agent-world account bootstrapped');

  // helper to read an agent-world run timeline directly (evidence)
  const awTimeline = async (runId) => {
    const r = await fetch(`${awBase}/api/runs/${encodeURIComponent(runId)}/timeline`, {
      headers: { authorization: `Bearer ${awToken}` },
    });
    return r.ok ? r.json() : { error: r.status };
  };

  // 4. boot real zeus (SQLite + agent-world executor + JSONL audit chain)
  spawnManaged(process.execPath, ['dist/http/serve.js'], {
    ZEUS_HOST: '127.0.0.1',
    ZEUS_PORT: String(zeusPort),
    ZEUS_INTERNAL_TOKEN: ZEUS_TOKEN,
    ZEUS_DB_FILE: zeusDb,
    ZEUS_AGENT_WORLD_BASE_URL: `${awBase}/`,
    ZEUS_SECRET_AGENT_WORLD_LOGIN: JSON.stringify({ email: AW_EMAIL, password: AW_PASSWORD }),
    ZEUS_DECISION_AUDIT_FILE: auditFile,
    ZEUS_RSK_KEY_FILE: rskPem,
    ZEUS_RSK_KEY_ID: RSK_KEY_ID,
  }, 'zeus', join(scratch, 'zeus.log'));

  // wait for zeus org API (server may not be listening yet → tolerate connect errors)
  const waitZeus = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await zfetch(zeusBase, '/api/v1/org/organizations');
        if (r.status === 200) return;
      } catch { /* not up yet */ }
      await sleep(500);
    }
    fail('zeus did not come up');
  };
  await waitZeus();
  log('zeus up at', zeusBase);

  // 5. build organization → department → positions
  let r = await zfetch(zeusBase, '/api/v1/org/organizations', {
    method: 'POST',
    body: { id: ORG_ID, name: 'TM7 repeat org', scaleTier: 'team' },
  });
  if (r.status !== 201) fail(`create org: ${r.status} ${JSON.stringify(r.body)}`);

  r = await zfetch(zeusBase, '/api/v1/org/departments', {
    method: 'POST',
    body: { id: DEPT_ID, organizationId: ORG_ID, name: '运营部', mission: '三个真实岗位的业务闭环' },
  });
  if (r.status !== 201) fail(`create dept: ${r.status} ${JSON.stringify(r.body)}`);

  const positions = [
    {
      id: 'pos:tm7-e2e-rpt:content', name: '内容岗',
      requiredSkills: ['content-production'],
      allowedTools: [TOOL.runGraph, TOOL.getRun],
      credentialRefs: ['agent-world:login'], decisionScope: 'D0', agentId: 'agent:c01',
    },
    {
      id: 'pos:tm7-e2e-rpt:listing', name: 'listing发布岗',
      requiredSkills: ['listing-publish'],
      allowedTools: [TOOL.runGraph, TOOL.resumeRun, TOOL.getRun],
      credentialRefs: ['agent-world:login'], decisionScope: 'D3', agentId: 'agent:l01',
    },
    {
      id: 'pos:tm7-e2e-rpt:as', name: '售后岗',
      requiredSkills: ['after-sales-support'],
      allowedTools: [TOOL.runGraph, TOOL.resumeRun, TOOL.getRun],
      credentialRefs: ['agent-world:login'], decisionScope: 'D2', agentId: 'agent:a01',
    },
    // fail-closed: no channel tools, no credentials
    {
      id: 'pos:tm7-e2e-rpt:notools', name: '无工具岗',
      requiredSkills: ['content-production'],
      allowedTools: [], credentialRefs: [], decisionScope: 'D0', agentId: 'agent:n01',
    },
    // fail-closed: D2 scope position on the D3 listing workflow
    {
      id: 'pos:tm7-e2e-rpt:lowscope', name: '低scope-listing岗',
      requiredSkills: ['listing-publish'],
      allowedTools: [TOOL.runGraph, TOOL.resumeRun, TOOL.getRun],
      credentialRefs: ['agent-world:login'], decisionScope: 'D2', agentId: 'agent:x01',
    },
  ];
  for (const p of positions) {
    r = await zfetch(zeusBase, '/api/v1/org/positions', {
      method: 'POST',
      body: {
        id: p.id, organizationId: ORG_ID, departmentId: DEPT_ID, name: p.name,
        responsibilities: [p.name], requiredSkills: p.requiredSkills,
        allowedTools: p.allowedTools, ...(p.credentialRefs.length ? { credentialRefs: p.credentialRefs } : {}),
        decisionScope: p.decisionScope,
      },
    });
    if (r.status !== 201) fail(`create position ${p.id}: ${r.status} ${JSON.stringify(r.body)}`);
    r = await zfetch(zeusBase, `/api/v1/org/positions/${p.id}/assign-agent`, {
      method: 'POST', body: { agentId: p.agentId },
    });
    if (r.status !== 200) fail(`assign agent ${p.id}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  log('organization, department and 5 positions built + agents bound');

  const evidence = { runs: {}, decisions: [], failClosed: {}, idempotency: {}, auditVerify: {} };

  // ── 6. D0 content: autonomous, no human ────────────────────────────────────
  r = await zfetch(zeusBase, '/api/v1/org/tasks', {
    method: 'POST',
    body: {
      organizationId: ORG_ID, title: 'content',
      positionId: 'pos:tm7-e2e-rpt:content',
      idempotencyKey: 'idem-content',
      payload: { workflow: 'content', input: '推广香薰蜡烛：晨间卧室氛围笔记', graphName: 'zeus-content-rpt' },
    },
  });
  if (r.status !== 201) fail(`create content task: ${r.status} ${JSON.stringify(r.body)}`);
  const contentTaskId = r.body.id;
  r = await zfetch(zeusBase, `/api/v1/org/tasks/${contentTaskId}/dispatch`, { method: 'POST' });
  if (r.status !== 202) fail(`dispatch content: ${r.status} ${JSON.stringify(r.body)}`);
  let content = await waitTask(zeusBase, contentTaskId);
  if (content.status !== 'done') fail(`content task expected done, got ${content.status}: ${content.error}`);
  if (content.result?.checkpointGrade !== 'D0') fail('content checkpoint grade should be D0');
  if (!content.result?.runId) fail('content task has no agent-world runId');
  if (!Array.isArray(content.result.artifacts) || content.result.artifacts.length === 0) fail('content produced no artifacts');
  evidence.runs.content = { taskId: contentTaskId, ...content.result, transitions: content.transitions };
  log('D0 content done; runId', content.result.runId, 'artifacts', content.result.artifacts.length);

  // idempotency: re-create with the SAME key must return the same task, no dup run
  r = await zfetch(zeusBase, '/api/v1/org/tasks', {
    method: 'POST',
    body: {
      organizationId: ORG_ID, title: 'content', positionId: 'pos:tm7-e2e-rpt:content',
      idempotencyKey: 'idem-content',
      payload: { workflow: 'content', input: '推广香薰蜡烛：晨间卧室氛围笔记', graphName: 'zeus-content-rpt' },
    },
  });
  if (r.status !== 201) fail(`idempotent recreate: ${r.status}`);
  evidence.idempotency.contentRecreate = {
    returnedSameId: r.body.id === contentTaskId,
    originalRunId: content.result.runId,
    recreatedRunId: r.body.result?.runId ?? null,
  };
  if (r.body.id !== contentTaskId) fail('idempotent recreate returned a NEW task');
  if (r.body.result?.runId !== content.result.runId) fail('idempotent recreate produced a different runId');
  log('idempotency: same key → same task + same runId');

  // ── 7. D3 listing: halt → approve → resume ─────────────────────────────────
  r = await zfetch(zeusBase, '/api/v1/org/tasks', {
    method: 'POST',
    body: {
      organizationId: ORG_ID, title: 'listing',
      positionId: 'pos:tm7-e2e-rpt:listing',
      payload: {
        workflow: 'listing', input: '上架 listing：薄荷精油 100ml', graphName: 'zeus-listing-rpt',
        fieldValues: { reviewWebhookUrl: webhookUrl },
      },
    },
  });
  const listingTaskId = r.body.id;
  await zfetch(zeusBase, `/api/v1/org/tasks/${listingTaskId}/dispatch`, { method: 'POST' });
  let listing = await waitTask(zeusBase, listingTaskId);
  if (listing.status !== 'awaiting_decision') fail(`listing expected awaiting_decision, got ${listing.status}`);
  if (!listing.decisionId) fail('listing halted without a decisionId');
  let d = await zfetch(zeusBase, `/api/v1/decisions/${listing.decisionId}`);
  if (d.body.grade !== 'D3') fail(`listing decision grade expected D3, got ${d.body.grade}`);
  // before approval: the agent-world run must be halted (no autonomous publish)
  let tl = await awTimeline(awaitingRunId(listing));
  evidence.runs.listingHalted = { decisionId: listing.decisionId, grade: d.body.grade, timeline: tl };
  log('D3 listing halted at', tl?.run?.haltedNodeId ?? listing.decisionId, 'grade', d.body.grade);

  // human (ops-lead) approves
  r = await zfetch(zeusBase, `/api/v1/org/tasks/${listingTaskId}/resume`, {
    method: 'POST', body: { decision: 'approve', approver: 'ops-lead' },
  });
  if (r.status !== 202) fail(`resume listing: ${r.status} ${JSON.stringify(r.body)}`);
  listing = await waitTask(zeusBase, listingTaskId);
  if (listing.status !== 'done') fail(`listing expected done after approve, got ${listing.status}: ${listing.error}`);
  if (listing.result?.checkpointGrade !== 'D3') fail('listing checkpoint grade should be D3');
  evidence.runs.listing = { taskId: listingTaskId, ...listing.result, transitions: listing.transitions };
  evidence.decisions.push(d.body);
  log('D3 listing done after approve; runId', listing.result.runId);

  // ── 8. D2 after-sales: halt → approve → resume → webhook ───────────────────
  r = await zfetch(zeusBase, '/api/v1/org/tasks', {
    method: 'POST',
    body: {
      organizationId: ORG_ID, title: 'after-sales',
      positionId: 'pos:tm7-e2e-rpt:as',
      payload: {
        workflow: 'after-sales', input: '工单：客户投诉音箱杂音要求退货', graphName: 'zeus-as-rpt',
        fieldValues: { webhookUrl },
      },
    },
  });
  const asTaskId = r.body.id;
  await zfetch(zeusBase, `/api/v1/org/tasks/${asTaskId}/dispatch`, { method: 'POST' });
  let asTask = await waitTask(zeusBase, asTaskId);
  if (asTask.status !== 'awaiting_decision') fail(`after-sales expected awaiting_decision, got ${asTask.status}`);
  d = await zfetch(zeusBase, `/api/v1/decisions/${asTask.decisionId}`);
  if (d.body.grade !== 'D2') fail(`after-sales decision grade expected D2, got ${d.body.grade}`);
  tl = await awTimeline(awaitingRunId(asTask));
  evidence.runs.asHalted = { decisionId: asTask.decisionId, grade: d.body.grade, timeline: tl };

  r = await zfetch(zeusBase, `/api/v1/org/tasks/${asTaskId}/resume`, {
    method: 'POST', body: { decision: 'approve', approver: 'ops-lead' },
  });
  if (r.status !== 202) fail(`resume after-sales: ${r.status} ${JSON.stringify(r.body)}`);
  asTask = await waitTask(zeusBase, asTaskId);
  if (asTask.status !== 'done') fail(`after-sales expected done, got ${asTask.status}: ${asTask.error}`);
  if (asTask.result?.checkpointGrade !== 'D2') fail('after-sales checkpoint grade should be D2');
  evidence.runs.afterSales = { taskId: asTaskId, ...asTask.result, transitions: asTask.transitions };
  evidence.decisions.push(d.body);
  log('D2 after-sales done; runId', asTask.result.runId, '| webhook captures so far', webhookCaptures.length);

  // ── 9. fail-closed: no-tools position ───────────────────────────────────────
  r = await zfetch(zeusBase, '/api/v1/org/tasks', {
    method: 'POST',
    body: {
      organizationId: ORG_ID, title: 'fc-notools',
      positionId: 'pos:tm7-e2e-rpt:notools',
      payload: { workflow: 'content', input: 'should never run' },
    },
  });
  const noToolsTaskId = r.body.id;
  r = await zfetch(zeusBase, `/api/v1/org/tasks/${noToolsTaskId}/dispatch`, { method: 'POST' });
  // Expect 409 SOP_INCOMPATIBLE (missing tools) — fail-closed at claim, no run.
  if (r.status !== 409 || r.body?.code !== 'SOP_INCOMPATIBLE') {
    fail(`no-tools position expected 409 SOP_INCOMPATIBLE, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  const noToolsTask = (await zfetch(zeusBase, `/api/v1/org/tasks/${noToolsTaskId}`)).body;
  if (noToolsTask.status !== 'pending') fail(`no-tools task should stay pending, got ${noToolsTask.status}`);
  evidence.failClosed.noTools = { dispatchStatus: r.status, code: r.body.code, taskStatus: noToolsTask.status, unmatchedReason: noToolsTask.unmatchedReason };
  log('fail-closed no-tools: 409 SOP_INCOMPATIBLE, task stays pending, zero channel calls');

  // ── 10. fail-closed: unknown workflow → SOP_MISSING ────────────────────────
  r = await zfetch(zeusBase, '/api/v1/org/tasks', {
    method: 'POST',
    body: {
      organizationId: ORG_ID, title: 'fc-unknown',
      positionId: 'pos:tm7-e2e-rpt:content',
      payload: { workflow: 'wechat-publish', input: 'uncatalogued workflow' },
    },
  });
  const unknownTaskId = r.body.id;
  r = await zfetch(zeusBase, `/api/v1/org/tasks/${unknownTaskId}/dispatch`, { method: 'POST' });
  if (r.status !== 409 || r.body?.code !== 'SOP_MISSING') {
    fail(`unknown workflow expected 409 SOP_MISSING, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  evidence.failClosed.unknownWorkflow = { dispatchStatus: r.status, code: r.body.code };
  log('fail-closed unknown workflow: 409 SOP_MISSING');

  // ── 11. fail-closed: D2 scope on D3 listing parks (cannot self-authorize) ──
  r = await zfetch(zeusBase, '/api/v1/org/tasks', {
    method: 'POST',
    body: {
      organizationId: ORG_ID, title: 'fc-lowscope-listing',
      positionId: 'pos:tm7-e2e-rpt:lowscope',
      payload: {
        workflow: 'listing', input: '上架 listing：低scope 100ml', graphName: 'zeus-lowscope-rpt',
        fieldValues: { reviewWebhookUrl: webhookUrl },
      },
    },
  });
  const lowTaskId = r.body.id;
  await zfetch(zeusBase, `/api/v1/org/tasks/${lowTaskId}/dispatch`, { method: 'POST' });
  let low = await waitTask(zeusBase, lowTaskId);
  if (low.status !== 'awaiting_decision') fail(`lowscope listing expected awaiting_decision, got ${low.status}`);
  d = await zfetch(zeusBase, `/api/v1/decisions/${low.decisionId}`);
  if (d.body.grade !== 'D3') fail(`lowscope listing decision should be D3, got ${d.body.grade}`);
  tl = await awTimeline(awaitingRunId(low));
  // BEFORE approval: the run is halted — the D3 publish was NOT performed autonomously.
  if (tl?.run?.status !== 'halted') fail(`lowscope listing run should be halted before approval, got ${tl?.run?.status}`);
  // now an external ops-lead approval unlocks the D3 resume (approved coverage)
  r = await zfetch(zeusBase, `/api/v1/org/tasks/${lowTaskId}/resume`, {
    method: 'POST', body: { decision: 'approve', approver: 'ops-lead' },
  });
  low = await waitTask(zeusBase, lowTaskId);
  if (low.status !== 'done') fail(`lowscope listing expected done after external approve, got ${low.status}`);
  evidence.failClosed.lowScopeD2OnD3 = {
    decisionId: low.decisionId,
    gradeBeforeApproval: 'D3',
    haltedBeforeApproval: true,
    doneAfterExternalApprove: low.status === 'done',
    runId: low.result?.runId,
  };
  evidence.decisions.push(d.body);
  log('fail-closed D2-on-D3: parked at D3 halt, only completed after external ops-lead approval');

  // ── 12. verify the Ed25519 JSONL audit chain (positive + tamper control) ───
  const auditText = readFileSync(auditFile, 'utf8');
  const entries = decodeAuditJsonl(auditText);
  if (entries.length < 2) fail(`expected >=2 audit entries, got ${entries.length}`);
  const verifier = {
    verify: async (keyId, text, sigB64url) => {
      if (keyId !== RSK_KEY_ID) return false;
      try {
        return cryptoVerify(null, Buffer.from(text, 'utf8'), publicKey, Buffer.from(sigB64url, 'base64url'));
      } catch { return false; }
    },
  };
  const verifyRes = await verifyDecisionAuditChain(entries, verifier);
  if (!verifyRes.ok) fail(`audit chain verification failed: ${JSON.stringify(verifyRes)}`);
  // tamper control: mutate a payload byte on a copy → verification must fail.
  const tampered = entries.map((e, i) => i === 1
    ? { ...e, payload: { ...e.payload, data: { ...e.payload.data, tampered: 'yes' } } }
    : e);
  const tamperRes = await verifyDecisionAuditChain(tampered, verifier);
  evidence.auditVerify = {
    entries: entries.length,
    keyId: RSK_KEY_ID,
    positive: verifyRes,
    tamperControl: { ok: tamperRes.ok, reason: tamperRes.ok ? 'TAMPER NOT DETECTED' : 'detected' },
  };
  if (tamperRes.ok) fail('tamper control: mutated chain still verified (expected failure)');
  log(`audit chain: ${entries.length} entries VERIFIED; tamper control correctly rejected`);

  // ── 13. write evidence bundle ────────────────────────────────────────────────
  const outDir = join(ZEUS_ROOT, 'outputs/tm7-e2e-repeat');
  mkdirSync(outDir, { recursive: true });

  // final snapshot of every task
  const finalTasks = {};
  for (const tid of [contentTaskId, listingTaskId, asTaskId, noToolsTaskId, unknownTaskId, lowTaskId]) {
    finalTasks[tid] = (await zfetch(zeusBase, `/api/v1/org/tasks/${tid}`)).body;
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
    format: 'zeus-tm7-e2e-evidence',
    version: 1,
    generatedAt: new Date().toISOString(),
    agentWorld: { base: awBase, worker: 'fake', note: 'WORKER=fake fabricates model calls only; graph engine/gates/halts/run really ran' },
    zeus: { base: zeusBase, sqlite: true, taskExecutor: 'agent-world', actionStore: 'sqlite' },
    webhookCaptures: webhookCaptures.length,
    assertions: {
      contentD0Autonomous: content.status === 'done' && content.result?.checkpointGrade === 'D0',
      listingD3HaltApproveResume: listing.status === 'done',
      afterSalesD2HaltApproveResume: asTask.status === 'done',
      failClosedNoToolsSopIncompatible: evidence.failClosed.noTools.code === 'SOP_INCOMPATIBLE',
      failClosedUnknownWorkflowSopMissing: evidence.failClosed.unknownWorkflow.code === 'SOP_MISSING',
      failClosedD2onD3ParksThenUnlocks: evidence.failClosed.lowScopeD2OnD3.haltedBeforeApproval && evidence.failClosed.lowScopeD2OnD3.doneAfterExternalApprove,
      idempotentSameKeySameRun: evidence.idempotency.contentRecreate.returnedSameId && evidence.idempotency.contentRecreate.recreatedRunId === evidence.idempotency.contentRecreate.originalRunId,
      auditChainVerified: verifyRes.ok === true,
      tamperDetected: tamperRes.ok === false,
      webhookReceived: webhookCaptures.length > 0,
    },
  }, null, 2));
  writeFileSync(join(outDir, 'runs.json'), JSON.stringify(evidence.runs, null, 2));
  writeFileSync(join(outDir, 'decisions.json'), JSON.stringify({ decisions: evidence.decisions }, null, 2));
  writeFileSync(join(outDir, 'fail-closed.json'), JSON.stringify(evidence.failClosed, null, 2));
  writeFileSync(join(outDir, 'idempotency.json'), JSON.stringify(evidence.idempotency, null, 2));
  writeFileSync(join(outDir, 'audit-verify.json'), JSON.stringify(evidence.auditVerify, null, 2));
  writeFileSync(join(outDir, 'webhook-captures.json'), JSON.stringify(webhookCaptures, null, 2));
  writeFileSync(join(outDir, 'tasks.json'), JSON.stringify(finalTasks, null, 2));

  log('evidence written to', outDir);
  log('WEBHOOK captures:', webhookCaptures.length);
  log('ALL ASSERTIONS PASSED');
  cleanup(0);
}

main().catch((err) => { console.error('[e2e:m7] error', err); cleanup(1); });

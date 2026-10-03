#!/usr/bin/env node
// @ts-check
/**
 * Operator intent recognition smoke on the compiled artifact (design constraint 2:
 * a concept that cannot be executed does not belong in this project).
 *
 * Why this file exists: the E2.6 recognition endpoint is covered by pure-function
 * and HTTP injection tests; by project discipline an injection test is not
 * "verified" - the face has to run as a real process over a real socket once
 * (same rationale as deferred #25). This exercises the shipped artifact:
 *
 *   boot the HTTP process with a skill registry -> recognize a matching
 *   instruction resolves locally with zero model involvement (backend: null,
 *   mode: plan) -> a non-matching instruction fails closed (422 no-candidates) ->
 *   an invalid realm is rejected (400) -> asking for the model with no backend
 *   configured fails closed (422 no-backend) instead of guessing.
 *
 * The local rule path is the deterministic core of recognition and the default
 * (data sovereignty: the instruction never leaves the machine unless the caller
 * explicitly opts in). The model path is exercised by injection tests against a
 * mocked backend; consulting a live model is operator territory and covered by
 * `verify:decision-backend` for the adapter itself.
 *
 * Rules it obeys so it can run unattended: loopback only, no external network,
 * temporary directory for everything it creates, its own key and its own token
 * (it never reads a real deployment's secrets or model keys), kills only the
 * processes it started, and a wall-clock budget so a hang surfaces as a failure
 * instead of a stalled job.
 *
 * Usage (requires `npm run build` first):
 *   npm run verify:intent-recognize
 *   npm run verify:intent-recognize -- --keep   # keep the work directory
 * Exit codes: 0 every step passed, 1 a step failed, 2 cannot start (missing
 * build, unusable port).
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const KEEP = process.argv.includes('--keep');
const startedAt = Date.now();
const DRIVER_TOKEN = `verify-intent-${randomBytes(8).toString('hex')}`;

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const steps = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function record(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}
/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {import('node:http').Server} server */
function boundPort(server) {
  const address = server.address();
  if (!address || typeof address === 'string') return undefined;
  return address.port;
}

/** Bind port 0 briefly to get a free loopback port for the process under test. */
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = boundPort(probe);
  await new Promise(resolve => probe.close(() => resolve(undefined)));
  if (port === undefined) throw new Error('probe server never bound to a port');
  return port;
}

if (!existsSync(join(REPO, 'dist/http/serve.js'))) {
  console.error('FAIL  cannot start: dist/http/serve.js is missing - run `npm run build` first');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Workspace: a temp directory with its own realm, state file, audit file and
// root signing key. Nothing here touches a real deployment.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'zeus-verify-intent-'));
const realmRoot = join(work, 'realm');
mkdirSync(realmRoot, { recursive: true });
writeFileSync(join(realmRoot, 'note.md'), '# verify\n\ncontext the recognition face runs against\n');
const stateFile = join(work, 'kernel-state.json');
const auditFile = join(work, 'audit.jsonl');
const keyFile = join(work, 'verify-key.pem');
execFileSync(process.execPath, [join(REPO, 'scripts/gen-rsk-key.mjs'), keyFile], { stdio: 'pipe' });

// ---------------------------------------------------------------------------
// A tiny mock execution agent whose card carries the two skills the operator
// instruction is recognized against (a real catalogue, registered over a real
// socket, same as a production agent would).
// ---------------------------------------------------------------------------
const agentServer = createServer((req, res) => {
  const match = req.url?.match(/^\/(a1)\/api\/a2a\/(agent-card|tasks)$/);
  if (!match) {
    res.writeHead(404).end('not found');
    return;
  }
  if (req.method === 'GET') {
    const servingPort = boundPort(agentServer);
    if (servingPort === undefined) {
      res.writeHead(500).end('agent server has no bound port');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        name: 'pr-helper',
        url: `http://127.0.0.1:${servingPort}/a1/api/a2a/tasks`,
        skills: [
          { id: 'code-review', name: 'Code Review', description: 'review a pull request for defects', tags: [] },
          { id: 'research', name: 'Deep Research', description: 'multi-source research across web and documents', tags: [] },
        ],
        'x-zeus-fealty': {
          version: '1',
          swornTo: 'zeus',
          domain: 'smoke',
          dataRealms: ['personal'],
          dataPolicy: 'read-task-scope',
          reportBack: true,
          escalationPolicy: 'on-failure',
        },
      }),
    );
    return;
  }
  let raw = '';
  req.on('data', chunk => (raw += chunk));
  req.on('end', () => {
    const rpc = JSON.parse(raw || '{}');
    if (rpc.method === 'tasks/cancel') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: 'cancel', contextId: 'x', status: { state: 'canceled' } } }));
      return;
    }
    if (String(req.headers.accept ?? '').includes('text/event-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'status-update', taskId: `t-${Date.now()}`, contextId: 'x', status: { state: 'working' }, final: false } })}\n\n`);
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: `t-${Date.now()}`, contextId: 'x', status: { state: 'completed' }, artifacts: [] } })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: `t-${Date.now()}`, contextId: 'x', status: { state: 'completed' }, artifacts: [] } }));
  });
});
await new Promise(resolve => agentServer.listen(0, '127.0.0.1', () => resolve(undefined)));
const agentPort = boundPort(agentServer);
if (agentPort === undefined) {
  console.error('FAIL  cannot start: the mock agent server never bound to a port');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Boot the HTTP process under test (the shipped artifact, not the sources).
// ---------------------------------------------------------------------------
const port = await freePort();
/** @type {Record<string, string | undefined>} */
const env = {
  ...process.env,
  ZEUS_HOST: '127.0.0.1',
  ZEUS_PORT: String(port),
  ZEUS_STATE_FILE: stateFile,
  ZEUS_AUDIT_FILE: auditFile,
  ZEUS_RSK_KEY_FILE: keyFile,
  ZEUS_INTERNAL_TOKEN: DRIVER_TOKEN,
  ZEUS_REALM_ROOTS: realmRoot,
  ZEUS_VASSAL_SEEDS: `http://127.0.0.1:${agentPort}/a1/api/a2a/agent-card`,
};
// Never inherit a real deployment's seeds or decision/model keys: the model
// path must fail closed on this process (422 no-backend), which is exactly
// what step 5 asserts.
delete env.ZEUS_DECISION_BASE_URL;
delete env.ZEUS_DECISION_API_KEY;
delete env.ZEUS_LLM_BASE_URL;
delete env.ZEUS_LLM_API_KEY;

const bearer = { authorization: `Bearer ${DRIVER_TOKEN}`, 'content-type': 'application/json' };
/** @type {import('node:child_process').ChildProcess | undefined} */
let proc;
let lastErr = '';
async function bootProcess() {
  const child = spawn(process.execPath, [join(REPO, 'dist/http/serve.js')], { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', chunk => (lastErr = String(chunk)));
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error(`process did not become healthy within 5s: ${lastErr.slice(0, 300)}`);
}
/**
 * @param {'GET' | 'POST' | 'DELETE'} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
async function api(method, path, body, headers = bearer) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json, raw: text };
}

try {
  proc = await bootProcess();
  // The card import may take a moment (onRegister -> skill catalogue).
  let registered = false;
  for (let i = 0; i < 40; i += 1) {
    const res = await api('GET', '/api/skills');
    if (res.status === 200 && (res.body?.skills ?? []).length >= 2) {
      registered = true;
      break;
    }
    await sleep(50);
  }
  record('skill catalogue has the agent-registered skills', registered, registered ? '' : 'catalogue did not reach 2 skills');

  // 1. bearer protection, like the rest of the H2 face.
  const noAuth = await api('POST', '/api/intents/recognize', { text: 'review the pr' }, { 'content-type': 'application/json' });
  record('recognize is bearer-protected', noAuth.status === 401, `status=${noAuth.status}`);

  // 2. local rule path: a matching instruction resolves with zero model
  //    involvement - backend null, mode plan, no external bytes left the box.
  const hit = await api('POST', '/api/intents/recognize', { text: 'review this pull request' });
  record('local rule path resolves a matching instruction', hit.status === 200 && hit.body?.ok === true && hit.body?.intent?.skill === 'code-review' && hit.body?.intent?.mode === 'plan' && hit.body?.backend === null, `status=${hit.status} skill=${hit.body?.intent?.skill} backend=${JSON.stringify(hit.body?.backend)}`);

  // 3. fail closed: nothing matches -> 422, never a guessed intent.
  const miss = await api('POST', '/api/intents/recognize', { text: 'unrelated gibberish topic' });
  record('non-matching instruction fails closed (422 no-candidates)', miss.status === 422 && miss.body?.ok === false && miss.body?.reason === 'no-candidates', `status=${miss.status} reason=${miss.body?.reason}`);

  // 4. realm validation on the face.
  const badRealm = await api('POST', '/api/intents/recognize', { text: 'review', realm: 'public' });
  record('invalid realm rejected (400)', badRealm.status === 400, `status=${badRealm.status}`);

  // 5. asking for the model with no backend configured fails closed instead
  //    of guessing (this process deleted all model keys on purpose).
  const noBackend = await api('POST', '/api/intents/recognize', { text: 'review the pr', useModel: true });
  record('useModel without a backend fails closed (422 no-backend)', noBackend.status === 422 && noBackend.body?.ok === false && noBackend.body?.reason === 'no-backend', `status=${noBackend.status} reason=${noBackend.body?.reason}`);

  // 6. the recognized intent is feedable into the plan fan-out face: skill id
  //    round-trips through POST /api/intents as a plan intent.
  const roundTrip = await api('POST', '/api/intents', { skill: 'code-review', realm: 'personal' });
  record('recognized skill id round-trips through the plan intent face', roundTrip.status === 200 && typeof roundTrip.body?.intentId === 'string' && roundTrip.body?.status === 'completed', `status=${roundTrip.status} intentId=${roundTrip.body?.intentId} status=${roundTrip.body?.status}`);
} catch (error) {
  record('verification aborted', false, error instanceof Error ? error.message : String(error));
} finally {
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise(resolve => proc?.once('exit', resolve));
  }
  agentServer.close();
  if (!KEEP) {
    rmSync(work, { recursive: true, force: true });
  } else {
    console.log(`kept work directory: ${work}`);
  }
}

const failed = steps.filter(step => !step.ok);
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failed.length > 0) {
  console.error(`${failed.length}/${steps.length} steps failed after ${elapsed}s`);
  process.exit(1);
}
console.log(`all ${steps.length} steps passed in ${elapsed}s`);
process.exit(0);

#!/usr/bin/env node
// @ts-check
/**
 * Execute-delegation chain smoke on the compiled artifact (design constraint 2:
 * a concept that cannot be executed does not belong in this project).
 *
 * Why this file exists: the execution-delegation dispatch gate (deferred #33,
 * Active work 107) is covered by orchestrator + HTTP injection tests, and by
 * project discipline an injection test is not "verified" - the chain has to run
 * as a real process over a real socket once (same rationale as deferred #25).
 * This exercises the shipped artifact end to end:
 *
 *   boot the HTTP process -> register an execution agent over a real socket ->
 *   execute without a ticket is refused with zero outbound -> issue a ticket
 *   over the real issuance endpoint -> execute with the ticket dispatches once
 *   and the agent really receives the request -> replaying the same ticket is
 *   refused with no new request -> the refusals are audited.
 *
 * Rules it obeys so it can run unattended: loopback only, no external network,
 * temporary directory for everything it creates, its own key and its own token
 * (it never reads a real deployment's secrets), kills only the processes it
 * started, and a wall-clock budget so a hang surfaces as a failure instead of a
 * stalled job.
 *
 * Usage (requires `npm run build` first):
 *   npm run verify:execute-delegation
 *   npm run verify:execute-delegation -- --keep   # keep the work directory
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
const BUDGET_MS = 60_000;
const startedAt = Date.now();
const DRIVER_TOKEN = `verify-exec-${randomBytes(8).toString('hex')}`;

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const steps = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function record(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}
/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The bound port of a listening server, or nothing when it is not listening
 * (a pipe or an already-closed server answers with a string or null).
 * @param {import('node:http').Server} server
 * @returns {number | undefined}
 */
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

// ---------------------------------------------------------------------------
// Mock execution agent: one vassal on a loopback listener, real HTTP both ways,
// recording exactly what the chain needs to prove - whether the kernel really
// dispatched, and how many times.
// ---------------------------------------------------------------------------
/** @typedef {{ name: string, requests: number, auth: string[] }} AgentRecord */
/** @type {Map<string, AgentRecord>} */
const agents = new Map();
/** @param {string} name @returns {AgentRecord} */
function agent(name) {
  const existing = agents.get(name);
  if (existing) return existing;
  const created = { name, requests: 0, auth: [] };
  agents.set(name, created);
  return created;
}
/** @param {string} name @param {number} port */
function card(name, port) {
  return {
    name,
    url: `http://127.0.0.1:${port}/${name}/api/a2a/tasks`,
    skills: [{ id: 'research', name: 'Research', description: 'reads the task scope', tags: [] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'smoke',
      dataRealms: ['personal'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'on-failure',
    },
  };
}
/** @param {string} id */
function task(id) {
  return {
    kind: 'task',
    id,
    contextId: 'verify',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'verdict', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
  };
}
const agentServer = createServer((req, res) => {
  const match = req.url?.match(/^\/(a1)\/api\/a2a\/(agent-card|tasks)$/);
  if (!match) {
    res.writeHead(404).end('not found');
    return;
  }
  const a = agent(match[1] ?? '');
  if (req.method === 'GET') {
    const servingPort = boundPort(agentServer);
    if (servingPort === undefined) {
      res.writeHead(500).end('agent server has no bound port');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card(match[1] ?? '', servingPort)));
    return;
  }
  let raw = '';
  req.on('data', chunk => (raw += chunk));
  req.on('end', () => {
    const rpc = JSON.parse(raw || '{}');
    if (rpc.method === 'tasks/cancel') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { ...task(`cancel-${a.name}`), status: { state: 'canceled' } } }));
      return;
    }
    a.requests += 1;
    a.auth.push(String(req.headers.authorization ?? '(none)'));
    if (String(req.headers.accept ?? '').includes('text/event-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'status-update', taskId: `t-${a.name}-${a.requests}`, contextId: 'verify', status: { state: 'working' }, final: false } })}\n\n`);
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: task(`t-${a.name}-${a.requests}`) })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: task(`t-${a.name}-${a.requests}`) }));
  });
});
await new Promise(resolve => agentServer.listen(0, '127.0.0.1', () => resolve(undefined)));
const agentPort = boundPort(agentServer);
if (agentPort === undefined) {
  console.error('FAIL  cannot start: the mock agent server never bound to a port');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Workspace: a temp directory with its own realm, state file, audit file and
// root signing key. Nothing here touches a real deployment.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'zeus-verify-exec-'));
const realmRoot = join(work, 'realm');
mkdirSync(realmRoot, { recursive: true });
writeFileSync(join(realmRoot, 'note.md'), '# verify\n\ncontext the execute chain reads back\n');
const stateFile = join(work, 'kernel-state.json');
const auditFile = join(work, 'audit.jsonl');
const keyFile = join(work, 'verify-key.pem');
execFileSync(process.execPath, [join(REPO, 'scripts/gen-rsk-key.mjs'), keyFile], { stdio: 'pipe' });

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
};
// Never inherit a real deployment's seeds or decision keys.
delete env.ZEUS_VASSAL_SEEDS;
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
    /* not JSON */
  }
  return { status: res.status, json, text };
}

/** @type {unknown} */
let issuedDelegation = null;
try {
  if (!existsSync(join(REPO, 'dist/http/serve.js'))) {
    record('build present', false, 'run `npm run build` first - this smoke exercises the shipped artifact, not the sources');
    process.exitCode = 2;
  } else {
    record('build present', true, 'dist/http/serve.js');

    proc = await bootProcess();
    const health = await api('GET', '/healthz', undefined, {});
    record('HTTP process boots on a directory and answers /healthz', health.json?.status === 'ok', `port ${port}`);

    const domains = await api('GET', '/api/domains');
    const personal = domains.json?.realms?.find(/** @param {{ type?: string, realmId?: string, itemCount?: number }} realm */ realm => realm.type === 'personal');
    record('realm mounted from a plain directory', !!personal && personal.itemCount >= 1, `realmId=${personal?.realmId} items=${personal?.itemCount}`);
    if (!personal?.realmId) throw new Error('personal realm never mounted');

    const registered = await api('POST', '/api/vassals', { cardUrl: `http://127.0.0.1:${agentPort}/a1/api/a2a/agent-card`, token: `verify-vassal-${randomBytes(6).toString('hex')}` });
    record('agent a1 registered over a real socket', registered.status === 201 || registered.status === 200, `status=${registered.status}${registered.text.slice(0, 220)}`);

    // Step 1: execute without a ticket is refused, zero outbound.
    const before = agent('a1').requests;
    const bare = await api('POST', '/api/intents', {
      skill: 'research',
      realm: 'personal',
      realmId: personal.realmId,
      params: {},
      vassals: ['a1'],
      mode: 'execute',
    });
    const bareBranch = bare.json?.branches?.[0] ?? {};
    record(
      'execute without a ticket is refused with zero outbound',
      bare.json?.branches?.length === 1 && bareBranch.ok === false && bareBranch.reason === 'execute refused: missing' && agent('a1').requests === before,
      `reason=${bareBranch.reason} agentRequests=${agent('a1').requests}`,
    );

    // Step 2: issue a ticket over the real issuance endpoint.
    const issued = await api('POST', '/api/execution-delegations', {
      grantedBy: 'operator@zeus',
      skill: 'research',
      capabilities: ['execute'],
      vassal: 'a1',
      reason: 'verify execute chain',
    });
    record('issuance endpoint hands out a signed delegation', issued.status === 201 && !!issued.json?.delegation, `status=${issued.status}`);
    issuedDelegation = issued.json?.delegation ?? null;
    if (!issuedDelegation) throw new Error('issuance returned no delegation');

    // Step 3: execute with the ticket dispatches exactly once, and the agent
    // really receives the request.
    const payloadWith = {
      skill: 'research',
      realm: 'personal',
      realmId: personal.realmId,
      params: {},
      vassals: ['a1'],
      mode: 'execute',
      executionDelegation: issuedDelegation,
    };
    const admitted = await api('POST', '/api/intents', payloadWith);
    const admittedBranch = admitted.json?.branches?.[0] ?? {};
    record(
      'execute with a valid ticket dispatches exactly once',
      admitted.json?.branches?.length === 1 && admittedBranch.ok === true && agent('a1').requests === before + 1,
      `ok=${admittedBranch.ok} agentRequests=${agent('a1').requests}`,
    );

    // Step 4: replaying the same ticket is refused, no new request.
    const replayed = await api('POST', '/api/intents', payloadWith);
    const replayBranch = replayed.json?.branches?.[0] ?? {};
    record(
      'replaying the same ticket is refused with no new request',
      replayBranch.ok === false && replayBranch.reason === 'execute refused: replayed' && agent('a1').requests === before + 1,
      `reason=${replayBranch.reason} agentRequests=${agent('a1').requests}`,
    );

    // The two refusals are audited (missing + replayed), the issuance is
    // audited once, and the admitted dispatch is not flagged as denied.
    const audit = await api('GET', '/api/audit?limit=100');
    /** @type {Array<{ decision?: string }>} */
    const entries = audit.json?.entries ?? [];
    const decisions = entries.map(/** @param {{ decision?: string }} e */ e => e.decision);
    record(
      'refusals audited as execution-delegation-denied, issuance audited once',
      decisions.filter(d => d === 'execution-delegation-denied').length === 2 && decisions.filter(d => d === 'execution-delegation-issued').length === 1,
      `denied=${decisions.filter(d => d === 'execution-delegation-denied').length} issued=${decisions.filter(d => d === 'execution-delegation-issued').length}`,
    );
  }
} catch (err) {
  record('unexpected failure', false, `${err instanceof Error ? err.message : String(err)}${lastErr ? ` :: stderr: ${lastErr.slice(0, 300)}` : ''}`);
  process.exitCode = 1;
} finally {
  if (proc?.pid) {
    proc.kill();
    await new Promise(resolve => proc?.once('exit', () => resolve(undefined)));
  }
  await new Promise(resolve => agentServer.close(() => resolve(undefined)));
  if (KEEP) {
    console.log(`workdir kept: ${work}`);
  } else {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      console.warn(`could not remove workdir ${work}; leaving it behind`);
    }
  }
}

const elapsed = Math.round((Date.now() - startedAt) / 1000);
const failed = steps.filter(s => !s.ok);
console.log(`\n==== ${steps.length - failed.length}/${steps.length} steps passed ==== (${elapsed}s)`);
if (elapsed > BUDGET_MS / 1000) {
  console.error(`FAIL  wall-clock budget ${BUDGET_MS / 1000}s exceeded`);
  process.exitCode = 1;
}
if (process.exitCode === undefined) process.exitCode = failed.length === 0 ? 0 : 1;

#!/usr/bin/env node
// @ts-check
/**
 * Operator intent recognition through the TUI client, on the compiled
 * artifact (same discipline as deferred #25 / verify:intent-recognize: an
 * injection test is not "verified" - the face has to run as a real process
 * over a real socket once).
 *
 * What this proves end to end:
 *
 *   boot the HTTP process with a skill registry -> the deck client
 *   (dist/tui/client.js, the same thin client `npm run tui` uses) recognizes a
 *   matching instruction over the real socket, local path, zero model
 *   involvement (backend: null, plan-only) -> a non-matching instruction
 *   fails closed (no-candidates) -> asking for the model with no backend
 *   configured fails closed (no-backend) -> the deck renders the hit and the
 *   miss (renderRecognize) -> the command parser maps `i <text>`/`im <text>`
 *   and keeps `info` unambiguous.
 *
 * Rules it obeys so it can run unattended: loopback only, no external
 * network, temporary directory for everything it creates, its own key and
 * its own token, never reads a real deployment's secrets or model keys,
 * kills only the processes it started, wall-clock budget on every await.
 *
 * Usage (requires `npm run build` first):
 *   npm run verify:tui-recognize
 *   npm run verify:tui-recognize -- --keep   # keep the work directory
 * Exit codes: 0 every step passed, 1 a step failed, 2 cannot start.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const KEEP = process.argv.includes('--keep');
const startedAt = Date.now();
const DRIVER_TOKEN = `verify-tui-${randomBytes(8).toString('hex')}`;

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

if (!existsSync(join(REPO, 'dist/http/serve.js')) || !existsSync(join(REPO, 'dist/tui/client.js'))) {
  console.error('FAIL  cannot start: dist/http/serve.js or dist/tui/client.js missing - run `npm run build` first');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Workspace: temp realm, state, audit and root signing key. Nothing touches a
// real deployment.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'zeus-verify-tui-'));
const realmRoot = join(work, 'realm');
mkdirSync(realmRoot, { recursive: true });
writeFileSync(join(realmRoot, 'note.md'), '# verify\n\ncontext the TUI recognition face runs against\n');
const stateFile = join(work, 'kernel-state.json');
const auditFile = join(work, 'audit.jsonl');
const keyFile = join(work, 'verify-key.pem');
execFileSync(process.execPath, [join(REPO, 'scripts/gen-rsk-key.mjs'), keyFile], { stdio: 'pipe' });

// ---------------------------------------------------------------------------
// Mock execution agent carrying the skill catalogue the instruction is
// recognized against (real socket, same shape as a production agent).
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
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: `t-${Date.now()}`, contextId: 'x', status: { state: 'completed' }, artifacts: [] } }),
    );
  });
});
await new Promise(resolve => agentServer.listen(0, '127.0.0.1', () => resolve(undefined)));
const agentPort = boundPort(agentServer);
if (agentPort === undefined) {
  console.error('FAIL  cannot start: the mock agent server never bound to a port');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Boot the HTTP process under test (shipped artifact).
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
// Never inherit a real deployment's model keys: the model path must fail
// closed on this process (422 no-backend), which step 3 asserts.
delete env.ZEUS_DECISION_BASE_URL;
delete env.ZEUS_DECISION_API_KEY;
delete env.ZEUS_LLM_BASE_URL;
delete env.ZEUS_LLM_API_KEY;

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

let client;
let renderRecognize;
let parseCommand;
try {
  proc = await bootProcess();
  // Wait for the card import (onRegister -> skill catalogue).
  let registered = false;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/api/skills`, { headers: { authorization: `Bearer ${DRIVER_TOKEN}` } });
    if (res.status === 200 && ((await res.json()).skills ?? []).length >= 2) {
      registered = true;
      break;
    }
    await sleep(100);
  }
  record('skill catalogue registered over the real socket', registered);

  // Load the shipped TUI modules exactly as `npm run tui` would consume them.
  // Note: dynamic import() on Windows rejects bare `C:\…` paths (ESM loader sees
  // the `c:` scheme), so every absolute path must be a file:// URL.
  ({ createDeckClient: client } = await import(pathToFileURL(join(REPO, 'dist/tui/client.js')).href));
  ({ renderRecognize } = await import(pathToFileURL(join(REPO, 'dist/tui/render.js')).href));
  ({ parseCommand } = await import(pathToFileURL(join(REPO, 'dist/tui/commands.js')).href));
  const deckClient = client(`http://127.0.0.1:${port}`, DRIVER_TOKEN);
  const translator = (await import(pathToFileURL(join(REPO, 'dist/tui/format.js')).href)).makeTranslator('zh-CN');
  const palette = (await import(pathToFileURL(join(REPO, 'dist/tui/tokens.js')).href)).makePalette(false);

  // 1. Local rule hit through the deck client.
  const hit = await deckClient.recognize('review the pull request');
  record(
    'deck client recognizes a matching instruction locally',
    hit.ok === true && hit.skill === 'code-review' && hit.backend === null,
    JSON.stringify(hit),
  );

  // 2. The deck renders the hit: plan-only, zero-egress backend.
  if (hit.ok) {
    const view = renderRecognize({ result: hit, t: translator, palette });
    const rendered =
      view.includes('→ 技能 code-review') && view.includes('本地规则，零出域') && view.includes('plan-only');
    record('renderRecognize shows skill + zero-egress + plan-only', rendered, view.split('\n').slice(1, 4).join(' | '));
  } else {
    record('renderRecognize shows skill + zero-egress + plan-only', false, 'hit did not resolve');
  }

  // 3. Fail-closed miss is surfaced as-is, never a guess.
  const miss = await deckClient.recognize('zzz definitely nothing matches');
  record('a non-matching instruction fails closed (no-candidates)', miss.ok === false && miss.reason === 'no-candidates', JSON.stringify(miss));

  // 4. Model opt-in with no backend configured fails closed too.
  const noModel = await deckClient.recognize('review the pull request', { useModel: true });
  record('model opt-in without a backend fails closed (no-backend)', noModel.ok === false && noModel.reason === 'no-backend', JSON.stringify(noModel));

  // 5. Command parser maps the deck verbs and stays unambiguous.
  const cmd = parseCommand('i review the pr');
  const cmdModel = parseCommand('im research postgres vs sqlite');
  const cmdNoText = parseCommand('i');
  const cmdInfo = parseCommand('info');
  record(
    'parseCommand maps i/im and rejects empty text',
    cmd.kind === 'recognize' && cmd.useModel === false && cmd.text === 'review the pr' &&
      cmdModel.kind === 'recognize' && cmdModel.useModel === true && cmdModel.text === 'research postgres vs sqlite' &&
      cmdNoText.error === 'recognize-needs-text',
    JSON.stringify({ cmd, cmdModel, cmdNoText }),
  );
  record('`info` stays unknown (i must be followed by whitespace)', cmdInfo.error === 'unknown', JSON.stringify(cmdInfo));
} catch (error) {
  record('TUI recognition acceptance', false, error instanceof Error ? error.message : String(error));
} finally {
  proc?.kill('SIGTERM');
  agentServer.close();
  if (KEEP) {
    console.log(`work kept at ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}

const failed = steps.filter(step => !step.ok);
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n${failed.length === 0 ? 'ALL STEPS PASSED' : 'SOME STEPS FAILED'} - ${steps.length} steps in ${elapsed}s`);
process.exit(failed.length === 0 ? 0 : 1);

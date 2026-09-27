#!/usr/bin/env node
/**
 * Core-chain smoke on the compiled artifact (design constraint 2: a concept that
 * cannot be executed does not belong in this project).
 *
 * Why this file exists: every previous "real process, real socket" check of the
 * core chain was written by whoever was running a review, then thrown away, so
 * each round had to re-invent it and the strongest class of evidence survived
 * only as prose in a change log (deferred #25). This is that chain as an asset:
 *
 *   boot the HTTP process -> mount a realm from a plain directory -> register an
 *   execution agent over a real socket with an outbound credential -> fan out an
 *   intent -> kernel-resolved realm content reaches the agent -> the published
 *   roster verifies offline with only the public key -> the published root key
 *   is that same key -> revoke cuts the wire ->
 *   SIGTERM persists -> a restart restores.
 *
 * Rules it obeys so it can run unattended: loopback only, no external network,
 * temporary directory for everything it creates, its own key and its own tokens
 * (it never reads a real deployment's secrets), kills only the processes it
 * started, and a wall-clock budget so a hang surfaces as a failure instead of a
 * stalled job.
 *
 * Usage (requires `npm run build` first):
 *   npm run smoke:core
 *   npm run smoke:core -- --keep        # keep the work directory for inspection
 * Exit codes: 0 every step passed, 1 a step failed, 2 cannot start (missing
 * build, unusable port).
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const KEEP = process.argv.includes('--keep');
const BUDGET_MS = 120_000;
const startedAt = Date.now();
const NEEDLE_TOKEN = `needle-${randomBytes(6).toString('hex')}`;
const DRIVER_TOKEN = `smoke-driver-${randomBytes(8).toString('hex')}`;
const VASSAL_SECRET = `smoke-vassal-${randomBytes(8).toString('hex')}`;

const steps = [];
function record(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Bind port 0 briefly to get a free loopback port for the process under test. */
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// Mock execution agent: three vassals on one loopback listener, real HTTP both
// ways, and it records exactly what a reviewer would want to know about -
// whether the credential arrived, and what payload the kernel actually sent.
// ---------------------------------------------------------------------------
const agents = new Map();
function agent(name) {
  if (!agents.has(name)) agents.set(name, { name, requests: 0, auth: [], payloads: [] });
  return agents.get(name);
}
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
function task(id) {
  return {
    kind: 'task',
    id,
    contextId: 'smoke',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'verdict', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
  };
}
const agentServer = createServer((req, res) => {
  const match = req.url?.match(/^\/(a[123])\/api\/a2a\/(agent-card|tasks)$/);
  if (!match) {
    res.writeHead(404).end('not found');
    return;
  }
  const a = agent(match[1]);
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card(match[1], agentServer.address().port)));
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
    a.payloads.push(rpc.params?.message?.parts?.[0]?.data ?? {});
    if (String(req.headers.accept ?? '').includes('text/event-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'status-update', taskId: `t-${a.name}-${a.requests}`, contextId: 'smoke', status: { state: 'working' }, final: false } })}\n\n`);
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: task(`t-${a.name}-${a.requests}`) })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: task(`t-${a.name}-${a.requests}`) }));
  });
});
await new Promise(resolve => agentServer.listen(0, '127.0.0.1', resolve));
const agentPort = agentServer.address().port;
const cardUrl = name => `http://127.0.0.1:${agentPort}/${name}/api/a2a/agent-card`;

// ---------------------------------------------------------------------------
// Work directory: one plain directory is the whole data domain (data sovereignty
// is the claim being tested, so the smoke must not need anything else).
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'zeus-smoke-core-'));
const realmRoot = join(work, 'realm');
const dataDir = join(work, 'data');
mkdirSync(realmRoot, { recursive: true });
writeFileSync(join(realmRoot, 'brief.md'), `# brief\nthe marker ${NEEDLE_TOKEN} lives only in the user's directory\n`);
const keygenOutput = execFileSync(process.execPath, [join(REPO, 'scripts/gen-rsk-key.mjs'), join(work, 'smoke-key.pem')], { stdio: 'pipe' }).toString();
const publicKeyPath = join(work, 'smoke-key.public.pem');
if (!existsSync(publicKeyPath)) {
  console.error(`FAIL  cannot start: keygen did not produce ${publicKeyPath}`);
  process.exit(2);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  ZEUS_HOST: '127.0.0.1',
  ZEUS_PORT: String(port),
  ZEUS_STATE_FILE: join(dataDir, 'kernel-state.json'),
  ZEUS_AUDIT_FILE: join(dataDir, 'audit.jsonl'),
  ZEUS_RSK_KEY_FILE: join(work, 'smoke-key.pem'),
  ZEUS_INTERNAL_TOKEN: DRIVER_TOKEN,
  ZEUS_REALM_ROOTS: realmRoot,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};
delete env.ZEUS_VASSAL_SEEDS;
const bearer = { authorization: `Bearer ${DRIVER_TOKEN}`, 'content-type': 'application/json' };

const children = [];
async function bootProcess(processEnv = env, processBase = base) {
  const child = spawn(process.execPath, [join(REPO, 'dist/http/serve.js')], { env: processEnv, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', chunk => (log += chunk));
  child.stderr.on('data', chunk => (log += chunk));
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`process exited early (code ${child.exitCode}):\n${log.slice(-600)}`);
    try {
      const response = await fetch(`${processBase}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { child, log: () => log };
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error(`never became healthy:\n${log.slice(-600)}`);
}
async function stopProcess(child) {
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function api(method, path, body, headers = bearer) {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON responses keep their text */ }
  return { status: response.status, json, text };
}
function verifyRoster(args) {
  try {
    const out = execFileSync(process.execPath, [join(REPO, 'scripts/verify-roster.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out, err: '' };
  } catch (error) {
    return { code: error.status, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') };
  }
}
function mode(path) {
  return existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : 'missing';
}
function watchdog() {
  if (Date.now() - startedAt > BUDGET_MS) {
    record(`wall-clock budget ${BUDGET_MS / 1000}s exceeded`, false, `after ${steps.length} steps`);
    finish();
  }
}
const timer = setInterval(watchdog, 5000);

let proc = null;
let stopped = false;
function finish() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  agentServer.close();
  const failed = steps.filter(step => !step.ok);
  console.log(`\n==== ${steps.length - failed.length}/${steps.length} steps passed ====`);
  console.log(`workdir: ${work}${KEEP || failed.length ? ' (kept)' : ' (removed)'}`);
  if (failed.length) console.log(`failed steps:\n${failed.map(step => ` - ${step.name}${step.detail ? ` :: ${step.detail}` : ''}`).join('\n')}`);
  if (!KEEP && !failed.length) {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* leaving a temp dir is not a failure */ }
  }
  process.exit(failed.length ? 1 : 0);
}

try {
  if (!existsSync(join(REPO, 'dist/http/serve.js'))) {
    record('build present', false, 'run `npm run build` first - the smoke exercises the shipped artifact, not the sources');
    finish();
  }
  record('build present', true, 'dist/http/serve.js');

  proc = await bootProcess();
  const health = await api('GET', '/healthz', undefined, {});
  record('HTTP process boots on a directory and answers /healthz', health.json?.status === 'ok', `port ${port}`);

  const domains = await api('GET', '/api/domains');
  const personal = domains.json?.realms?.find(realm => realm.type === 'personal');
  record('realm mounted from a plain directory', !!personal && personal.itemCount >= 1, `realmId=${personal?.realmId} items=${personal?.itemCount}`);

  for (const name of ['a1', 'a2', 'a3']) {
    const registered = await api('POST', '/api/vassals', { cardUrl: cardUrl(name), token: VASSAL_SECRET });
    record(`agent ${name} registered over a real socket`, registered.status === 201 || registered.status === 200, `status=${registered.status}`);
  }

  const envelope = (await api('GET', '/api/roster/public', undefined, {})).json;
  writeFileSync(join(work, 'roster.json'), JSON.stringify(envelope));
  record('published roster is a signed envelope', !!envelope?.seal?.snapshotDigest && envelope?.snapshot?.schemaVersion === 1, `entries=${envelope?.snapshot?.entries?.length}`);

  const verdict = verifyRoster(['--file', join(work, 'roster.json'), '--key', publicKeyPath, '--now', envelope.seal.issuedAt]);
  record('roster verifies offline with only the public key', verdict.code === 0 && /VERIFIED/.test(verdict.out), `exit=${verdict.code}`);
  const stale = verifyRoster([
    '--file', join(work, 'roster.json'), '--key', publicKeyPath, '--quiet',
    '--now', new Date(Date.parse(envelope.seal.issuedAt) + (envelope.seal.maxAgeSeconds + 60) * 1000).toISOString(),
  ]);
  record('the same bytes are refused once past maxAge', stale.code === 1 && /maxAge/.test(stale.err), `exit=${stale.code} ${stale.err.trim().slice(0, 60)}`);

  // The key a verifier is told to trust, checked against the key that actually
  // signed: an empty or unrelated descriptor would pass a status-only check.
  const keysRes = await api('GET', '/api/roster/keys', undefined, {});
  const published = keysRes.json?.keys?.find(key => key.kid === envelope.seal?.keyId);
  record(
    'the root key endpoint answers unauthenticated and lists the sealing keyId',
    keysRes.status === 200 && !!published && keysRes.json.keys.length === 1,
    `status=${keysRes.status} kids=${(keysRes.json?.keys ?? []).map(key => key.kid).join(',')}`
  );
  record(
    'the published public key is the one the roster verified against',
    !!published && published.spkiPem.trim() === readFileSync(publicKeyPath, 'utf8').trim(),
    `kid=${published?.kid ?? '(none found)'}`
  );
  const expectedThumbprint = createHash('sha256')
    .update(`{"crv":"Ed25519","kty":"OKP","x":${JSON.stringify(published?.x ?? '')}}`, 'utf8')
    .digest('base64url');
  record(
    'the pinning fingerprint recomputes from the published JWK',
    !!published && published.jwkThumbprint === expectedThumbprint && /^[0-9a-f:]{95}$/.test(published.spkiSha256),
    `thumbprint=${published?.jwkThumbprint?.slice(0, 12)}…`
  );
  // Byte equality would still leave the published encoding unusable: an operator
  // who trusts this endpoint has nothing but the response body to verify with, so
  // the shipped CLI must accept exactly those bytes.
  writeFileSync(join(work, 'keys.json'), JSON.stringify(keysRes.json));
  writeFileSync(join(work, 'published.pem'), published?.spkiPem ?? '');
  const viaPublished = verifyRoster(['--file', join(work, 'roster.json'), '--key', join(work, 'published.pem'), '--now', envelope.seal.issuedAt]);
  record(
    'a verifier holding only the endpoint response verifies the roster with the shipped CLI',
    viaPublished.code === 0 && /VERIFIED/.test(viaPublished.out),
    `exit=${viaPublished.code} ${viaPublished.err.trim().split('\n')[0] ?? ''}`
  );
  // One string, three touchpoints: keygen prints it before anything is running,
  // the endpoint publishes it, and the verifier displays it. An operator pinning
  // out of band reads it at one of the three, so they had better agree.
  const pin = published?.jwkThumbprint ?? '(none)';
  const spkiPin = published?.spkiSha256 ?? '(none)';
  record(
    'the pinning value is one string across keygen, publication and verification',
    keygenOutput.includes(pin) && keygenOutput.includes(spkiPin)
      && verdict.out.includes(`jwk=${pin}`) && verdict.out.includes(`spki=${spkiPin}`)
      && viaPublished.out.includes(`jwk=${pin}`),
    `jwk=${pin.slice(0, 10)}… spki=${spkiPin.slice(0, 8)}…`
  );

  const fanOut = await api('POST', '/api/intents', { skill: 'research', realm: 'personal', realmId: personal.realmId, aggregation: { kind: 'unanimous' }, params: { subject: 'smoke-target', predicate: 'verdict' } });
  record('intent fans out to every provider', fanOut.json?.status === 'completed' && fanOut.json?.branches?.length === 3, `status=${fanOut.json?.status} http=${fanOut.status} body=${fanOut.text.slice(0, 220)}`);
  record('the outbound credential reaches the agent', ['a1', 'a2', 'a3'].every(name => agent(name).auth.at(-1) === `Bearer ${VASSAL_SECRET}`), `seen: ${['a1','a2','a3'].map(n => agent(n).auth.map(x => x === `Bearer ${VASSAL_SECRET}` ? 'ok' : (x === '(none)' ? 'none' : x.slice(0, 10) + '…')).join(',')).join(' | ')}`);
  record('branches ran concurrently, not serially', ['a1', 'a2', 'a3'].every(name => agent(name).requests === 1), 'one request each inside a single fan-out');

  const sourced = await api('POST', '/api/intents', { skill: 'research', realm: 'personal', realmId: personal.realmId, realmSource: { realmId: personal.realmId, text: NEEDLE_TOKEN }, params: { subject: 'smoke-target', predicate: 'verdict' } });
  const forwarded = JSON.stringify(agent('a1').payloads.at(-1) ?? {});
  record('the kernel itself reads the realm and forwards content', sourced.json?.status === 'completed' && forwarded.includes(NEEDLE_TOKEN), `agent saw the marker: ${forwarded.includes(NEEDLE_TOKEN)}`);

  // The DAG driver face is reachable only if serve.ts actually injects dagRunner:
  // without it every call answers 503 "not assembled", and neither a route-presence
  // grep nor an inject-level test can tell those two apart (deferred #23 was called
  // out twice for exactly that gap). An id the runner has never seen has to come
  // back as the runner's own 404, which is unreachable unless it is injected.
  const dagProbe = await api('GET', '/api/intents/no-such-dag/dag');
  const dagAnonymous = await api('GET', '/api/intents/no-such-dag/dag', undefined, {});
  record(
    'the DAG driver face is assembled in this process, not merely routed',
    dagProbe.status === 404 && /unknown dag/.test(dagProbe.json?.detail ?? '') && dagAnonymous.status === 401,
    `authenticated=${dagProbe.status} (${String(dagProbe.json?.detail ?? dagProbe.text).slice(0, 40)}), anonymous=${dagAnonymous.status}`,
  );

  const leakViews = ['/api/roster', '/api/roster/public', '/api/roster/keys', '/api/state', '/api/metrics'];
  const leaks = [];
  for (const path of leakViews) {
    const publicFace = path.startsWith('/api/roster/');
    const response = await api('GET', path, undefined, publicFace ? {} : bearer);
    if (response.text.includes(VASSAL_SECRET)) leaks.push(path);
  }
  record('no read view echoes the agent credential', leaks.length === 0, leaks.join(', ') || `checked ${leakViews.length} views`);

  const auditMode = mode(env.ZEUS_AUDIT_FILE);
  const auditText = existsSync(env.ZEUS_AUDIT_FILE) ? readFileSync(env.ZEUS_AUDIT_FILE, 'utf8') : '';
  record('governance decisions are persisted 0600', auditMode === '600' && /"decision":"dispatched"/.test(auditText), `mode=${auditMode} lines=${auditText.trim().split('\n').length}`);
  const auditRead = await api('GET', '/api/audit?limit=5');
  record('the audit trail reads back over the bearer API', auditRead.status === 200 && auditRead.text.includes('dispatched'), `status=${auditRead.status}`);

  // The two drift/export faces, checked on the compiled process rather than only
  // in inject-level tests: a snapshot has to round-trip through JSON, and the
  // diff has to answer both directions (no drift against itself, drift against
  // an empty baseline) rather than always answering one way.
  const snap = await api('GET', '/api/memory/snapshot');
  const baseline = snap.json?.state;
  const factCount = (baseline?.facts ?? []).reduce((total, pair) => total + (Array.isArray(pair?.[1]) ? pair[1].length : 0), 0);
  record('finished intents produced memory claims and folded them into facts', snap.status === 200 && (baseline?.events?.length ?? 0) >= 3 && factCount >= 1, `events=${baseline?.events?.length} facts=${factCount} - deferred #27 was exactly this number being 0`);
  const selfDiff = await api('POST', '/api/memory/reconcile', { previous: baseline });
  // Direction control: a baseline holding an event the live store has never seen
  // has to come back as removals, which is the half an always-zero diff would get
  // wrong. (It also shows up in the counts above: no runtime producer appends
  // memory events, so drift cannot be induced from the dispatch path - deferred #27.)
  const ghostDiff = await api('POST', '/api/memory/reconcile', {
    previous: { events: [{ eventId: 'ghost-event-not-in-store' }], facts: [] },
  });
  record(
    'memory reconcile answers in both directions',
    selfDiff.status === 200 && selfDiff.json?.hasDrift === false
      && ghostDiff.status === 200 && ghostDiff.json?.hasDrift === true
      && ghostDiff.json?.eventsRemoved === 1,
    `self=${selfDiff.json?.hasDrift}, ghost=${ghostDiff.json?.hasDrift}/removed ${ghostDiff.json?.eventsRemoved}`,
  );
  const badSnapshot = await api('POST', '/api/memory/reconcile', { previous: {} });
  record('a malformed baseline is refused naming the field', badSnapshot.status === 400 && /body\.previous\.events/.test(badSnapshot.json?.detail ?? ''), badSnapshot.json?.detail ?? `status=${badSnapshot.status}`);

  const diaryExport = await api('GET', '/api/diary/export');
  const diaryRead = await api('GET', '/api/diary');
  // Key order differs by design (the export is canonicalised, Fastify serialises
  // in insertion order), so compare structures and then check the export is
  // byte-stable across calls - that stability is the whole point of exportDiary.
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
  };
  const exportMatchesRead = diaryExport.status === 200
    && JSON.stringify(canonical(JSON.parse(diaryExport.text))) === JSON.stringify(canonical(diaryRead.json?.entries ?? []));
  const diaryExportAgain = await api('GET', '/api/diary/export');
  const diaryBadDate = await api('GET', '/api/diary/export?date=09-23');
  record(
    'diary export matches the read view and is byte-stable',
    exportMatchesRead && diaryExportAgain.text === diaryExport.text && diaryBadDate.status === 400 && (diaryRead.json?.entries ?? []).length > 0,
    `entries=${(diaryRead.json?.entries ?? []).length}, badDate=${diaryBadDate.status}`,
  );

  const revokedAt = agent('a1').requests;
  const revoked = await api('DELETE', '/api/vassals/a1', undefined, { authorization: `Bearer ${DRIVER_TOKEN}` });
  const afterRevoke = await api('POST', '/api/intents', { skill: 'research', realm: 'personal', vassals: ['a1'] });
  record('revocation cuts the wire immediately', revoked.status === 200 && agent('a1').requests === revokedAt && afterRevoke.json?.status !== 'completed', `delete=${revoked.status} ${revoked.text.slice(0,120)} | requests stayed at ${agent('a1').requests}, intent status=${afterRevoke.json?.status}`);
  // The public view drops revoked rows by design, so the revoked state is
  // read from the internal roster.
  const rosterWithRevoked = (await api('GET', '/api/roster')).json;
  writeFileSync(join(work, 'roster-revoked.json'), JSON.stringify(rosterWithRevoked));
  const revVerdict = verifyRoster(['--file', join(work, 'roster-revoked.json'), '--key', publicKeyPath, '--now', rosterWithRevoked.seal.issuedAt]);
  record('a roster carrying a revoked row still verifies offline', revVerdict.code === 0, `entries=${(rosterWithRevoked.snapshot.entries ?? []).map(e => `${e.name}=${e.status}`).join(' ')}`);

  await stopProcess(proc.child);
  const stateMode = mode(env.ZEUS_STATE_FILE);
  record('SIGTERM persists kernel state at 0600', stateMode === '600', `mode=${stateMode} bytes=${existsSync(env.ZEUS_STATE_FILE) ? statSync(env.ZEUS_STATE_FILE).size : 0}`);

  proc = await bootProcess();
  const restoredRoster = (await api('GET', '/api/roster')).json;
  const statuses = (restoredRoster?.snapshot?.entries ?? []).map(entry => `${entry.name}=${entry.status}`).join(' ');
  record('restart restores agents and governance state', /a1=revoked/.test(statuses) && /a2=active/.test(statuses), statuses);
  const restoredRealms = await api('GET', '/api/domains');
  record('restart re-attaches the data domain', (restoredRealms.json?.realms ?? []).some(realm => realm.type === 'personal' && realm.itemCount >= 1), `realms=${(restoredRealms.json?.realms ?? []).length}`);
  // Memory is the layer that was silently empty before deferred #27, so the
  // restart has to be proven against it and not assumed from the roster.
  const restoredMemory = await api('GET', '/api/memory/snapshot');
  const restoredFacts = (restoredMemory.json?.state?.facts ?? []).reduce((total, pair) => total + (Array.isArray(pair?.[1]) ? pair[1].length : 0), 0);
  record('restart restores the memory fact source, not just the roster', (restoredMemory.json?.state?.events?.length ?? 0) >= 3 && restoredFacts >= 1, `events=${restoredMemory.json?.state?.events?.length} facts=${restoredFacts}`);
  const afterRestart = await api('POST', '/api/intents', { skill: 'research', realm: 'personal', vassals: ['a2'] });
  record('dispatch works after the restart', afterRestart.json?.status === 'completed', `status=${afterRestart.json?.status} agent requests=${agent('a2').requests}`);
  writeFileSync(join(work, 'roster-restored.json'), JSON.stringify(restoredRoster));
  record('the restarted process publishes a roster that still verifies', verifyRoster(['--file', join(work, 'roster-restored.json'), '--key', publicKeyPath, '--now', restoredRoster.seal.issuedAt]).code === 0);
  // serve.ts is the only place that decides this label, and nothing below the
  // assembly knows it - so a unit test cannot show the wiring, only a process can.
  const restartedKeys = await api('GET', '/api/roster/keys', undefined, {});
  const restartedState = await api('GET', '/api/state');
  record(
    'a key-file process reports its root key as surviving a restart',
    restartedKeys.json?.keySource === 'configured' && restartedKeys.json?.survivesRestart === true
      && restartedState.json?.rosterKey?.source === 'configured'
      && restartedState.json?.rosterKey?.keyId === restartedKeys.json?.keys?.[0]?.kid,
    `keys=${restartedKeys.json?.keySource ?? '(absent)'} state=${restartedState.json?.rosterKey?.source ?? '(absent)'} kid=${restartedKeys.json?.keys?.[0]?.kid}`
  );

  await stopProcess(proc.child);

  // The two booleans above say the process *believes* its key is ephemeral; they
  // do not say the key actually rotates. "Restarts invalidate every seal" is the
  // operator-facing consequence, so the check has to observe two boots and see a
  // different root key - a loader that quietly reused one key would satisfy every
  // label and still void nothing. Own directory, own port, no key material at all.
  const ephemeralDir = join(work, 'ephemeral');
  mkdirSync(ephemeralDir, { recursive: true });
  const ephemeralPort = await freePort();
  const ephemeralBase = `http://127.0.0.1:${ephemeralPort}`;
  const ephemeralEnv = {
    ...env,
    ZEUS_PORT: String(ephemeralPort),
    ZEUS_STATE_FILE: join(ephemeralDir, 'kernel-state.json'),
    ZEUS_AUDIT_FILE: join(ephemeralDir, 'audit.jsonl'),
    ZEUS_RSK_KEY_ID: 'zeus-rsk-ephemeral-smoke',
  };
  delete ephemeralEnv.ZEUS_RSK_KEY;
  delete ephemeralEnv.ZEUS_RSK_KEY_FILE;
  async function ephemeralBootKeys() {
    const ephemeralProc = await bootProcess(ephemeralEnv, ephemeralBase);
    try {
      const response = await fetch(`${ephemeralBase}/api/roster/keys`);
      const body = await response.json();
      return { source: body?.keySource, survives: body?.survivesRestart, thumbprint: body?.keys?.[0]?.jwkThumbprint ?? '' };
    } finally {
      await stopProcess(ephemeralProc.child);
    }
  }
  const firstEphemeral = await ephemeralBootKeys();
  const secondEphemeral = await ephemeralBootKeys();
  record(
    'an ephemeral process publishes a genuinely different root key on every restart',
    firstEphemeral.source === 'ephemeral' && firstEphemeral.survives === false
      && secondEphemeral.source === 'ephemeral'
      && firstEphemeral.thumbprint.length > 0 && secondEphemeral.thumbprint.length > 0
      && firstEphemeral.thumbprint !== secondEphemeral.thumbprint,
    `run1=${firstEphemeral.thumbprint.slice(0, 12)}… run2=${secondEphemeral.thumbprint.slice(0, 12)}… source=${firstEphemeral.source ?? '(absent)'}`
  );
} catch (error) {
  record('smoke aborted', false, error instanceof Error ? error.message : String(error));
}
finish();

#!/usr/bin/env node
/**
 * A1 acceptance: register a REAL execution agent into a running Zeus and drive
 * one fan-out through it (docs/pre-launch-checklist.md row A1, milestone M3).
 *
 * Why a script and not a runbook: the gap this closes has always been "did it
 * ever actually run", and prose cannot answer that. Every step prints the
 * observed status code or count, so the output pastes straight into the
 * checklist as evidence.
 *
 * What it mutates: it registers an agent in the target Zeus (that is the test),
 * and only revokes again if you pass --revoke-test. Everything else is a read.
 *
 * Usage:
 *   KERNEL_URL=http://127.0.0.1:8799 \
 *   ZEUS_INTERNAL_TOKEN="$(cat data/internal-token)" \
 *   CARD_URL=https://pr-helper-ten.vercel.app/api/a2a/agent-card \
 *   AGENT_TOKEN=<the bearer that agent expects, if any> \
 *   SKILL=research \
 *   node scripts/acceptance-real-fanout.mjs [--revoke-test] [--timeout 60000]
 *
 * Proxy note: Zeus fetches the card and dispatches to the agent **itself**, so
 * any proxy needed to reach the agent belongs in the *Zeus process* environment
 * (NODE_USE_ENV_PROXY=1 HTTPS_PROXY=...), not in this script's.
 *
 * Exit codes: 0 every step passed, 1 a step failed (reasons on stderr),
 * 2 configuration or usage error (nothing was called).
 * Secrets are never printed: the agent credential and the internal token appear
 * only as "present/absent".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;
const argv = process.argv.slice(2);
const revokeTest = argv.includes('--revoke-test');
const timeoutIndex = argv.indexOf('--timeout');
const timeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 60_000;

function usageExit(reason) {
  console.error(`[CONFIG] ${reason}`);
  process.exit(2);
}
if (timeoutIndex >= 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) usageExit(`--timeout must be a positive number of ms`);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: KERNEL_URL=… ZEUS_INTERNAL_TOKEN=… CARD_URL=… [AGENT_TOKEN=…] [SKILL=…] node scripts/acceptance-real-fanout.mjs [--revoke-test] [--timeout ms]`);
  process.exit(0);
}

const KERNEL_URL = (env.KERNEL_URL ?? '').replace(/\/+$/, '');
const INTERNAL_TOKEN = env.ZEUS_INTERNAL_TOKEN ?? '';
const CARD_URL = env.CARD_URL ?? '';
const AGENT_TOKEN = env.AGENT_TOKEN ?? '';
const SKILL = env.SKILL ?? 'research';
if (!KERNEL_URL) usageExit('KERNEL_URL is required (e.g. http://127.0.0.1:8799)');
if (!INTERNAL_TOKEN) usageExit('ZEUS_INTERNAL_TOKEN is required: this acceptance drives the internal/driver face');
if (!CARD_URL) usageExit('CARD_URL is required: the agent-card URL of the real execution agent');
for (const [name, value] of [['KERNEL_URL', KERNEL_URL], ['CARD_URL', CARD_URL]]) {
  try {
    new URL(value);
  } catch {
    usageExit(`${name} is not a valid URL: ${value}`);
  }
}

const steps = [];
function record(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
  if (!ok) console.error(`  reason: ${detail || 'no detail reported'}`);
}

const marker = `fanout-${randomBytes(4).toString('hex')}`;
const bearer = { authorization: `Bearer ${INTERNAL_TOKEN}` };

async function call(method, path, { auth = false, body } = {}) {
  const url = `${KERNEL_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: { ...(auth ? bearer : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}
const clip = value => String(value ?? '').replace(/\s+/g, ' ').slice(0, 160);
// The snapshot exports facts as [realmId, FactRecord[]] pairs, so a count has to
// walk the pairs; reading a scalar field that is not there would report 0 and
// look like "the producer is broken" when it is the reader that is wrong.
const factCount = state => (Array.isArray(state?.facts) ? state.facts : [])
  .reduce((total, pair) => total + (Array.isArray(pair?.[1]) ? pair[1].length : 0), 0);

async function main() {
  console.log(`target ${KERNEL_URL.replace(/^https?:\/\//, '')}  skill=${SKILL}  card=${CARD_URL.replace(/^https?:\/\//, '')}`);
  console.log(`credentials: internal token ${INTERNAL_TOKEN ? 'present' : 'missing'} (length ${INTERNAL_TOKEN.length}), agent token ${AGENT_TOKEN ? 'present' : 'absent'}  — neither value is ever printed`);

  // 1. Liveness, before anything is mutated.
  let health;
  try {
    health = await call('GET', '/healthz');
  } catch (error) {
    record('the target Zeus answers /healthz', false, `cannot reach ${KERNEL_URL}: ${error instanceof Error ? error.message : String(error)} - is it running? (if the agent is external, the proxy belongs to the Zeus process, not here)`);
    return finish();
  }
  record('the target Zeus answers /healthz', health.status === 200 && health.json?.status === 'ok', `status=${health.status} ${clip(health.text)}`);
  if (!steps[0].ok) return finish();

  // 2. The auth boundary is real: the driver face must refuse an anonymous call.
  const anonymous = await call('GET', '/api/roster');
  record('the internal roster refuses an unauthenticated call', anonymous.status === 401, `status=${anonymous.status}`);
  const authorized = await call('GET', '/api/roster', { auth: true });
  record('the internal roster answers with the bearer token', authorized.status === 200 && Array.isArray(authorized.json?.snapshot?.entries), `status=${authorized.status}`);
  if (!steps[2].ok) return finish();

  // 3. Which root key seals this deployment, and its pinning value.
  const keys = await call('GET', '/api/roster/keys');
  const rootKey = keys.json?.keys?.[0];
  record('the deployment publishes a root public key', keys.status === 200 && !!rootKey?.jwkThumbprint, `kid=${rootKey?.kid ?? '(none)'}`);
  if (rootKey) {
    console.log(`      announce/compare: jwkThumbprint=${rootKey.jwkThumbprint}`);
    if (rootKey.kid === 'zeus-rsk-dev') {
      console.log('      WARN  kid is the dev default: this process may be sealing with an ephemeral key, so do not pin it (set ZEUS_RSK_KEY_ID + a key file)');
    }
  }

  // 4. Register the real agent (this is the write the test exists to perform).
  const beforeNames = (authorized.json?.snapshot?.entries ?? []).map(entry => entry.name);
  const registered = await call('POST', '/api/vassals', { auth: true, body: { cardUrl: CARD_URL, ...(AGENT_TOKEN ? { token: AGENT_TOKEN } : {}) } });
  const registerOk = registered.status === 201 || registered.status === 200 || (registered.status >= 400 && /already/i.test(registered.text));
  record('the real agent registers (card fetched, fealty validated)', registerOk, `status=${registered.status} ${clip(registered.text)}`);
  if (!registerOk) return finish();

  const agentName = registered.json?.card?.name ?? registered.json?.name ?? beforeNames.find(name => name !== undefined && CARD_URL.includes(name)) ?? '(from roster)';
  const afterRoster = await call('GET', '/api/roster', { auth: true });
  const entry = (afterRoster.json?.snapshot?.entries ?? []).find(candidate => candidate.name === agentName);
  record('the agent is listed active in the internal roster', !!entry && entry.status === 'active', `name=${agentName} status=${entry?.status ?? '(absent)'}`);

  // 5. The credential must not come back out through any read view.
  const echoes = [];
  if (AGENT_TOKEN) {
    for (const [label, response] of [['/api/roster', afterRoster], ['/api/roster/public', await call('GET', '/api/roster/public')], ['/api/state', await call('GET', '/api/state', { auth: true })]]) {
      if (response.text.includes(AGENT_TOKEN)) echoes.push(label);
    }
  }
  record('no read view echoes the agent credential', AGENT_TOKEN ? echoes.length === 0 : true, AGENT_TOKEN ? (echoes.join(', ') || 'checked 3 views') : 'skipped: no AGENT_TOKEN supplied');

  // 6. One fan-out through the real agent. The kernel requires body.realm, and a
  //    memory claim only lands when the intent names the realm it worked in, so
  //    the realmId is looked up rather than assumed.
  const domains = await call('GET', '/api/domains', { auth: true });
  const personal = (domains.json?.realms ?? []).find(realm => realm.type === 'personal');
  const memoryBefore = await call('GET', '/api/memory/snapshot', { auth: true });
  const eventsBefore = memoryBefore.json?.state?.events?.length ?? -1;
  const factsBefore = factCount(memoryBefore.json?.state);
  const fanOut = await call('POST', '/api/intents', {
    auth: true,
    body: {
      skill: SKILL,
      realm: 'personal',
      ...(personal?.realmId ? { realmId: personal.realmId } : {}),
      vassals: [agentName],
      params: { subject: marker, predicate: 'verdict', prompt: `Zeus acceptance ${marker}: report one short factual stance.` },
    },
  });
  const intentId = fanOut.json?.intentId;
  record('the intent is accepted', [200, 201, 202].includes(fanOut.status) && !!intentId, `status=${fanOut.status} ${clip(fanOut.text)}`);
  if (!intentId) return finish();
  if (!personal) console.log(`      NOTE  no personal realm on this deployment (memory claims are realm-scoped, so step "verdict became a claim" cannot pass; mount one with ZEUS_REALM_ROOTS)`);
  console.log(`      intentId=${intentId}${fanOut.json?.runId ? ` runId=${fanOut.json.runId}` : ''} target=${agentName}`);

  const deadline = Date.now() + timeoutMs;
  let result = fanOut.json;
  while (Date.now() < deadline && !['completed', 'failed', 'canceled', 'needs-driver'].includes(result?.status)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const polled = await call('GET', `/api/intents/${intentId}`, { auth: true });
    if (polled.status === 200) result = polled.json;
  }
  const branches = Array.isArray(result?.branches) ? result.branches : [];
  record('the fan-out reached a terminal state inside the timeout', ['completed', 'failed', 'canceled', 'needs-driver'].includes(result?.status), `status=${result?.status ?? '(unknown)'} after ${timeoutMs - (deadline - Date.now())}ms`);
  record('at least one branch came back from the real agent', branches.length >= 1, `branches=${branches.length}`);
  // A branch carries ok/state/task, not a summary: the stance is what proves the
  // agent answered with content rather than merely accepting the call.
  const succeeded = branches.filter(branch => branch?.ok === true);
  const positions = Array.isArray(result?.positions) ? result.positions : [];
  record('a branch succeeded and contributed a stance', succeeded.length >= 1 && positions.length >= 1, `ok=${succeeded.length}/${branches.length} positions=${positions.length} first=${clip(positions[0] ? `${positions[0].vassal}=${positions[0].stance}` : '(none)')}`);
  const failedBranches = branches.filter(branch => branch?.ok !== true);
  if (failedBranches.length) console.log(`      branch failures: ${failedBranches.map(branch => `${branch.vassal}=${clip(branch.reason)}`).join(' | ')}`);
  if (result?.refused) console.log(`      governance refusal before dispatch: ${clip(JSON.stringify(result.refused))}`);

  // 7. Governance facts written by that same run. The audit trail is filtered
  //    client-side here because a deployment may hold a long file: the claim is
  //    "an entry for *this* run exists", not "the newest entries mention it".
  const branchRuns = new Set(branches.map(branch => branch.runId).filter(Boolean));
  const audit = await call('GET', '/api/audit?limit=50', { auth: true });
  const entries = audit.json?.entries ?? [];
  const mine = entries.filter(entry => entry.decision === 'dispatched' && (branchRuns.has(entry.runId) || entry.vassal === agentName));
  record('the dispatch is on the audit trail, bound to this run', audit.status === 200 && mine.length >= 1, `status=${audit.status} entries=${entries.length} forThisRun=${mine.length} auditFile=${audit.json?.file ?? '(none configured)'} decisions=${[...new Set(entries.map(entry => entry.decision))].join(',') || '(none)'}`);

  const memoryAfter = await call('GET', '/api/memory/snapshot', { auth: true });
  const eventsAfter = memoryAfter.json?.state?.events?.length ?? -1;
  const factsAfter = factCount(memoryAfter.json?.state);
  record('the verdict became a memory claim (E8.5 producer, real agent)', eventsBefore >= 0 && eventsAfter > eventsBefore, `events ${eventsBefore} -> ${eventsAfter}, facts ${factsBefore} -> ${factsAfter}`);

  // 8. The roster this deployment publishes must verify with only its published key.
  const publicRoster = await call('GET', '/api/roster/public');
  const work = mkdtempSync(join(tmpdir(), 'zeus-fanout-'));
  try {
    writeFileSync(join(work, 'roster.json'), publicRoster.text);
    if (rootKey?.spkiPem) writeFileSync(join(work, 'published.pem'), rootKey.spkiPem);
    let verifyNote = 'skipped: no published key material to verify with';
    let verified = false;
    if (rootKey?.spkiPem) {
      try {
        const out = execFileSync(process.execPath, [join(REPO, 'scripts/verify-roster.mjs'), '--file', join(work, 'roster.json'), '--key', join(work, 'published.pem')], { encoding: 'utf8' });
        verified = /VERIFIED/.test(out);
        verifyNote = out.match(/(VERIFIED|REJECTED[^\n]*)/)?.[1] ?? '(no verdict)';
      } catch (error) {
        verifyNote = clip(String(error.stderr ?? error.message));
      }
    }
    record('the live roster verifies offline against the published key', verified, clip(verifyNote));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // 9. Revocation force, only when asked for: it changes the deployment's roster.
  if (revokeTest) {
    const removed = await call('DELETE', `/api/vassals/${encodeURIComponent(agentName)}`, { auth: true });
    record('revocation is accepted', removed.status === 200, `status=${removed.status} ${clip(removed.text)}`);
    const dropped = await call('GET', '/api/roster/public');
    record('a revoked agent leaves the public roster immediately', !dropped.text.includes(`"${agentName}"`), `name=${agentName}`);
  } else {
    console.log("SKIP  revocation force (pass --revoke-test to check it; it edits this deployment's roster)");
  }

  console.log('');
  console.log('evidence bundle (paste into pre-launch checklist row A1):');
  console.log(`  target=${KERNEL_URL} agent=${agentName} skill=${SKILL} marker=${marker}`);
  console.log(`  intentId=${intentId} status=${result?.status} branches=${branches.length} ok=${succeeded.length} positions=${positions.length}`);
  console.log(`  keyId=${rootKey?.kid ?? '?'} jwkThumbprint=${rootKey?.jwkThumbprint ?? '?'}`);
  console.log(`  memory events ${eventsBefore} -> ${eventsAfter}; revoked=${revokeTest ? 'tested' : 'not tested'}`);
  return finish();
}

function finish() {
  const failed = steps.filter(step => !step.ok);
  console.log(`\n==== ${steps.length - failed.length}/${steps.length} steps passed ====`);
  if (failed.length) {
    console.error(`failed steps:\n${failed.map(step => ` - ${step.name}`).join('\n')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERROR] ${message}`);
  console.error('        the acceptance stopped mid-run; nothing else was attempted. Re-run after fixing the cause (VERBOSE=1 prints the stack).');
  if (process.env.VERBOSE) console.error(error instanceof Error ? error.stack ?? '' : '');
  process.exit(1);
});

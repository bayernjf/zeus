#!/usr/bin/env node
// @ts-check
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
 * TASK_URL (optional): an explicit override for the JSON-RPC endpoint dispatch
 * posts to. Dispatch normally honours the endpoint the card itself declares
 * (A2A AgentCard.url), and only falls back to the cardUrl convention (cardUrl
 * …/agent-card → …/tasks) when the card declares nothing usable. Pass this when
 * a card declares the wrong endpoint or none at all: it wins over both.
 *
 * REALM (optional, default "personal"): the realm type the driven intent targets.
 * A vassal only serves the data realms its fealty declares, so an agent whose
 * card says dataRealms=["enterprise"] is refused a personal-realm intent — mount
 * the matching realm (ZEUS_REALM_ENTERPRISE) and pass REALM=enterprise.
 *
 * PARAMS (optional, JSON object): the skill parameters to send. An execution
 * agent validates its own parameters, so the question-shaped default
 * (subject/predicate/prompt) only suits an agent that answers questions; an
 * agent that runs a named skill needs that skill's own params — e.g.
 * PARAMS='{"owner":"me","repo":"x"}' for pr-helper's deployment-health, which
 * otherwise replies input-required "Missing required parameters: owner, repo".
 *
 * EXPECT_STANCE (optional, default "0"): whether the target agent is expected to
 * *vote* (return a stance in its artifact's data part) or merely to *report*.
 * These are different claims about an agent, and the acceptance must assert the
 * one that is true of it:
 *   - 0 (executor): the branch must come back with content (an artifact), and
 *     the stance-aggregation and memory-claim steps are reported as N/A — a
 *     stance is what an agent returns when asked to decide, and an execution
 *     agent is asked to do.
 *   - 1 (decision): the branch must additionally contribute a stance, and that
 *     stance must land as a memory claim.
 * Passing 0 does not weaken the run: register/dispatch/audit/verify are asserted
 * either way, and the content check is asserted in both.
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

/**
 * @param {string} reason
 * @returns {never}
 */
function usageExit(reason) {
  console.error(`[CONFIG] ${reason}`);
  process.exit(2);
}
if (timeoutIndex >= 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) usageExit(`--timeout must be a positive number of ms`);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: KERNEL_URL=… ZEUS_INTERNAL_TOKEN=… CARD_URL=… [AGENT_TOKEN=…] [TASK_URL=…] [SKILL=…] [REALM=personal|enterprise] [PARAMS='{"k":"v"}'] [EXPECT_STANCE=0|1] node scripts/acceptance-real-fanout.mjs [--revoke-test] [--timeout ms]`);
  process.exit(0);
}

const KERNEL_URL = (env.KERNEL_URL ?? '').replace(/\/+$/, '');
const INTERNAL_TOKEN = env.ZEUS_INTERNAL_TOKEN ?? '';
const CARD_URL = env.CARD_URL ?? '';
const AGENT_TOKEN = env.AGENT_TOKEN ?? '';
const TASK_URL = env.TASK_URL ?? '';
const SKILL = env.SKILL ?? 'research';
const REALM = env.REALM ?? 'personal';
const EXPECT_STANCE = env.EXPECT_STANCE ?? '0';
if (REALM !== 'personal' && REALM !== 'enterprise') usageExit(`REALM must be "personal" or "enterprise", got ${REALM}`);
if (EXPECT_STANCE !== '0' && EXPECT_STANCE !== '1') usageExit(`EXPECT_STANCE must be "0" (the agent reports) or "1" (the agent votes), got ${EXPECT_STANCE}`);
// A skill's params are its own: the runner cannot guess them, so it takes the
// object verbatim when given one and only falls back to the question-shaped
// default for an agent that answers questions.
/** @type {Record<string, unknown> | undefined} */
let PARAMS;
if (env.PARAMS) {
  try {
    PARAMS = JSON.parse(env.PARAMS);
  } catch (error) {
    usageExit(`PARAMS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (PARAMS === null || typeof PARAMS !== 'object' || Array.isArray(PARAMS)) usageExit(`PARAMS must be a JSON object of skill parameters, got ${Array.isArray(PARAMS) ? 'an array' : typeof PARAMS}`);
}
if (!KERNEL_URL) usageExit('KERNEL_URL is required (e.g. http://127.0.0.1:8799)');
if (!INTERNAL_TOKEN) usageExit('ZEUS_INTERNAL_TOKEN is required: this acceptance drives the internal/driver face');
if (!CARD_URL) usageExit('CARD_URL is required: the agent-card URL of the real execution agent');
for (const [name, value] of [['KERNEL_URL', KERNEL_URL], ['CARD_URL', CARD_URL], ...(TASK_URL ? [['TASK_URL', TASK_URL]] : [])]) {
  try {
    new URL(value ?? '');
  } catch {
    usageExit(`${name} is not a valid URL: ${value}`);
  }
}

/** @type {Array<{ name: string, ok: boolean }>} */
const steps = [];
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function record(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
  if (!ok) console.error(`  reason: ${detail || 'no detail reported'}`);
}

const marker = `fanout-${randomBytes(4).toString('hex')}`;
/** @type {Record<string, string>} */
const bearer = { authorization: `Bearer ${INTERNAL_TOKEN}` };

/**
 * @param {string} method
 * @param {string} path
 * @param {{ auth?: boolean, body?: unknown }} [options]
 * @returns {Promise<{ status: number, text: string, json: any }>}
 */
async function call(method, path, { auth = false, body } = {}) {
  const url = `${KERNEL_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: { ...(auth ? bearer : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}
const clip = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/g, ' ').slice(0, 160);
// The snapshot exports facts as [realmId, FactRecord[]] pairs, so a count has to
// walk the pairs; reading a scalar field that is not there would report 0 and
// look like "the producer is broken" when it is the reader that is wrong.
const factCount = (/** @type {any} */ state) => (Array.isArray(state?.facts) ? state.facts : [])
  .reduce((/** @type {number} */ total, /** @type {any} */ pair) => total + (Array.isArray(pair?.[1]) ? pair[1].length : 0), 0);

async function main() {
  console.log(`target ${KERNEL_URL.replace(/^https?:\/\//, '')}  skill=${SKILL}  card=${CARD_URL.replace(/^https?:\/\//, '')}  expectStance=${EXPECT_STANCE}`);
  console.log(`credentials: internal token ${INTERNAL_TOKEN ? 'present' : 'missing'} (length ${INTERNAL_TOKEN.length}), agent token ${AGENT_TOKEN ? 'present' : 'absent'}  — neither value is ever printed`);
  if (TASK_URL) console.log(`task endpoint: ${TASK_URL} (explicit override; without it dispatch uses the endpoint the card declares, else ${CARD_URL.replace(/\/api\/a2a\/agent-card\/?$/, '/api/a2a/tasks')})`);

  // 1. Liveness, before anything is mutated.
  let health;
  try {
    health = await call('GET', '/healthz');
  } catch (error) {
    record('the target Zeus answers /healthz', false, `cannot reach ${KERNEL_URL}: ${error instanceof Error ? error.message : String(error)} - is it running? (if the agent is external, the proxy belongs to the Zeus process, not here)`);
    return finish();
  }
  record('the target Zeus answers /healthz', health.status === 200 && health.json?.status === 'ok', `status=${health.status} ${clip(health.text)}`);
  if (!steps[0]?.ok) return finish();

  // 2. The auth boundary is real: the driver face must refuse an anonymous call.
  const anonymous = await call('GET', '/api/roster');
  record('the internal roster refuses an unauthenticated call', anonymous.status === 401, `status=${anonymous.status}`);
  const authorized = await call('GET', '/api/roster', { auth: true });
  record('the internal roster answers with the bearer token', authorized.status === 200 && Array.isArray(authorized.json?.snapshot?.entries), `status=${authorized.status}`);
  if (!steps[2]?.ok) return finish();

  // 3. Which root key seals this deployment, and its pinning value.
  const keys = await call('GET', '/api/roster/keys');
  const rootKey = keys.json?.keys?.[0];
  record('the deployment publishes a root public key', keys.status === 200 && !!rootKey?.jwkThumbprint, `kid=${rootKey?.kid ?? '(none)'}`);
  if (rootKey) {
    console.log(`      announce/compare: jwkThumbprint=${rootKey.jwkThumbprint}`);
    // The kernel reports whether its key survives a restart; only an older build
    // (no such field) leaves the runner to infer from the default kid, and then it
    // has to say so rather than reporting a guess as a fact.
    if (keys.json?.keySource === 'ephemeral') {
      console.log('      WARN  this process seals with an EPHEMERAL key: it changes on every restart, so nothing may be pinned to it (set ZEUS_RSK_KEY_FILE or ZEUS_RSK_KEY)');
    } else if (keys.json?.keySource === 'configured') {
      console.log('      key source: configured (a pin against this key survives a restart)');
    } else if (rootKey.kid === 'zeus-rsk-dev') {
      console.log('      WARN  kid is the dev default and this build reports no key source, so ephemerality cannot be determined here - check the deployment (set ZEUS_RSK_KEY_ID + a key file)');
    }
  }

  // 4. Register the real agent (this is the write the test exists to perform).
  const beforeNames = (authorized.json?.snapshot?.entries ?? []).map((/** @type {any} */ entry) => entry.name);
  const registered = await call('POST', '/api/vassals', { auth: true, body: { cardUrl: CARD_URL, ...(TASK_URL ? { taskUrl: TASK_URL } : {}), ...(AGENT_TOKEN ? { token: AGENT_TOKEN } : {}) } });
  const registerOk = registered.status === 201 || registered.status === 200 || (registered.status >= 400 && /already/i.test(registered.text));
  record('the real agent registers (card fetched, fealty validated)', registerOk, `status=${registered.status} ${clip(registered.text)}`);
  if (!registerOk) return finish();

  const agentName = registered.json?.card?.name ?? registered.json?.name ?? beforeNames.find((/** @type {string} */ name) => name !== undefined && CARD_URL.includes(name)) ?? '(from roster)';
  const afterRoster = await call('GET', '/api/roster', { auth: true });
  const entry = (afterRoster.json?.snapshot?.entries ?? []).find((/** @type {any} */ candidate) => candidate.name === agentName);
  record('the agent is listed active in the internal roster', !!entry && entry.status === 'active', `name=${agentName} status=${entry?.status ?? '(absent)'}`);

  // 5. The credential must not come back out through any read view.
  const echoes = [];
  if (AGENT_TOKEN) {
    const views = /** @type {Array<[string, { text: string }]>} */ ([['/api/roster', afterRoster], ['/api/roster/public', await call('GET', '/api/roster/public')], ['/api/state', await call('GET', '/api/state', { auth: true })]]);
    for (const [label, response] of views) {
      if (response.text.includes(AGENT_TOKEN)) echoes.push(label);
    }
  }
  record('no read view echoes the agent credential', AGENT_TOKEN ? echoes.length === 0 : true, AGENT_TOKEN ? (echoes.join(', ') || 'checked 3 views') : 'skipped: no AGENT_TOKEN supplied');

  // 6. One fan-out through the real agent. The kernel requires body.realm, and a
  //    memory claim only lands when the intent names the realm it worked in, so
  //    the realmId is looked up rather than assumed.
  const domains = await call('GET', '/api/domains', { auth: true });
  const target = (domains.json?.realms ?? []).find((/** @type {any} */ realm) => realm.type === REALM);
  const memoryBefore = await call('GET', '/api/memory/snapshot', { auth: true });
  const eventsBefore = memoryBefore.json?.state?.events?.length ?? -1;
  const factsBefore = factCount(memoryBefore.json?.state);
  const fanOut = await call('POST', '/api/intents', {
    auth: true,
    body: {
      skill: SKILL,
      realm: REALM,
      ...(target?.realmId ? { realmId: target.realmId } : {}),
      vassals: [agentName],
      params: PARAMS ?? { subject: marker, predicate: 'verdict', prompt: `Zeus acceptance ${marker}: report one short factual stance.` },
    },
  });
  const intentId = fanOut.json?.intentId;
  record('the intent is accepted', [200, 201, 202].includes(fanOut.status) && !!intentId, `status=${fanOut.status} ${clip(fanOut.text)}`);
  if (!intentId) return finish();
  if (!target) console.log(`      NOTE  no ${REALM} realm on this deployment (memory claims are realm-scoped, so step "verdict became a claim" cannot pass; mount one with ZEUS_REALM_ROOTS / ZEUS_REALM_ENTERPRISE)`);
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
  // What proves the agent did the work is that it came back with content. A
  // stance is a different claim: it is what an agent returns when asked to
  // decide, and an execution agent is asked to do — so which one is asserted is
  // selected by EXPECT_STANCE rather than assumed. Asserting the stance against
  // an executor would report a working agent as broken.
  const succeeded = branches.filter((/** @type {any} */ branch) => branch?.ok === true);
  const positions = Array.isArray(result?.positions) ? result.positions : [];
  const contentOf = (/** @type {any} */ branch) => (Array.isArray(branch?.task?.artifacts) ? branch.task.artifacts : [])
    .filter((/** @type {any} */ artifact) => Array.isArray(artifact?.parts) && artifact.parts.length >= 1);
  const withContent = succeeded.filter((/** @type {any} */ branch) => contentOf(branch).length >= 1);
  const report = withContent.flatMap(contentOf).map((/** @type {any} */ artifact) => artifact['x-zeus-report']).find(Boolean);
  record('a branch succeeded and returned content (an artifact with parts)', withContent.length >= 1, `ok=${succeeded.length}/${branches.length} withContent=${withContent.length} report=${clip(report?.summary ?? '(none)')}`);
  if (EXPECT_STANCE === '1') {
    record('a branch contributed a stance', succeeded.length >= 1 && positions.length >= 1, `ok=${succeeded.length}/${branches.length} positions=${positions.length} first=${clip(positions[0] ? `${positions[0].vassal}=${positions[0].stance}` : '(none)')}`);
  } else {
    console.log(`SKIP  stance aggregation: EXPECT_STANCE=0, this agent is expected to report content, not to vote (positions=${positions.length}); the content check above is the assertion for it`);
  }
  const failedBranches = branches.filter((/** @type {any} */ branch) => branch?.ok !== true);
  if (failedBranches.length) console.log(`      branch failures: ${failedBranches.map((/** @type {any} */ branch) => `${branch.vassal}=${clip(branch.reason)}`).join(' | ')}`);
  if (result?.refused) console.log(`      governance refusal before dispatch: ${clip(JSON.stringify(result.refused))}`);

  // 7. Governance facts written by that same run. The audit trail is filtered
  //    client-side here because a deployment may hold a long file: the claim is
  //    "an entry for *this* run exists", not "the newest entries mention it".
  const branchRuns = new Set(branches.map((/** @type {any} */ branch) => branch.runId).filter(Boolean));
  const audit = await call('GET', '/api/audit?limit=50', { auth: true });
  const entries = audit.json?.entries ?? [];
  const mine = entries.filter((/** @type {any} */ entry) => entry.decision === 'dispatched' && (branchRuns.has(entry.runId) || entry.vassal === agentName));
  record('the dispatch is on the audit trail, bound to this run', audit.status === 200 && mine.length >= 1, `status=${audit.status} entries=${entries.length} forThisRun=${mine.length} auditFile=${audit.json?.file ?? '(none configured)'} decisions=${[...new Set(entries.map((/** @type {any} */ entry) => entry.decision))].join(',') || '(none)'}`);

  const memoryAfter = await call('GET', '/api/memory/snapshot', { auth: true });
  const eventsAfter = memoryAfter.json?.state?.events?.length ?? -1;
  const factsAfter = factCount(memoryAfter.json?.state);
  // The E8.5 producer derives a claim from a stance, so this step only has
  // meaning for an agent that returns one; asserting it against an executor
  // would be asserting a step the producer correctly skipped.
  if (EXPECT_STANCE === '1') {
    record('the verdict became a memory claim (E8.5 producer, real agent)', eventsBefore >= 0 && eventsAfter > eventsBefore, `events ${eventsBefore} -> ${eventsAfter}, facts ${factsBefore} -> ${factsAfter}`);
  } else {
    console.log(`SKIP  memory claim: a claim is produced from a stance and EXPECT_STANCE=0 says this agent returns none (events ${eventsBefore} -> ${eventsAfter})`);
  }

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
        const err = /** @type {{ stderr?: unknown, message?: unknown }} */ (error);
        verifyNote = clip(String(err.stderr ?? err.message ?? error));
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
  console.log(`  intentId=${intentId} status=${result?.status} branches=${branches.length} ok=${succeeded.length} withContent=${withContent.length} positions=${positions.length}`);
  console.log(`  expected stance=${EXPECT_STANCE} (${EXPECT_STANCE === '1' ? 'decision agent: stance + memory claim asserted' : 'execution agent: content asserted, stance/claim N/A'})  report=${clip(report?.summary ?? '(none)')}`);
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

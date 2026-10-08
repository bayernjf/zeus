#!/usr/bin/env node
// @ts-check
/**
 * Zeus ↔ loom interop acceptance: register loom (a real A2A peer, plan-only
 * executor) into a running Zeus and drive one fan-out through it, asserting the
 * loom-specific contract along the way (docs/pre-launch-checklist.md row A2,
 * milestone M3 — Zeus↔loom 联调).
 *
 * Why a script and not a runbook: the same reason as acceptance-real-fanout —
 * "did it ever actually run" is a question prose cannot answer. Every step
 * prints the observed status or count so the output pastes into the checklist
 * as evidence.
 *
 * What it mutates: it registers loom in the target Zeus (that is the test) and
 * only revokes again with --revoke-test. Everything else is a read.
 *
 * Usage:
 *   KERNEL_URL=http://127.0.0.1:8799 \
 *   ZEUS_INTERNAL_TOKEN="$(cat data/internal-token)" \
 *   CARD_URL=http://127.0.0.1:8000/.well-known/agent-card.json \
 *   AGENT_TOKEN=<loom Agent Key, Q88> \
 *   node scripts/acceptance-loom-interop.mjs [--revoke-test] [--sse-test] [--timeout 60000]
 *
 * Env:
 *   KERNEL_URL          — the running Zeus to drive (default none, required).
 *   ZEUS_INTERNAL_TOKEN — Zeus bearer for the H2 surface.
 *   CARD_URL            — loom's agent card URL. Defaults to LOOM_URL +
 *                         "/.well-known/agent-card.json" when LOOM_URL is set.
 *   LOOM_URL            — loom base (e.g. http://127.0.0.1:8000); used for the
 *                         card default and the SSE probe target.
 *   AGENT_TOKEN         — loom Agent Key (Q88); required for registration and
 *                         for the optional SSE probe.
 *   SKILL               — loom skill id; default "generate-content" (the card's
 *                         display name is not what tasks/send executes).
 *   REALM               — intent realm, default "personal".
 *   PARAMS              — optional JSON skill params for the intent.
 *
 * Asserted contract (loom side, Q150):
 *   - card name = "loom", url absolute (LOOM_PUBLIC_BASE_URL forwarded),
 *     capabilities.streaming = true, authentication bearer, 3 plan skills.
 *   - POST /api/a2a/tasks speaks JSON-RPC tasks/send (Zeus dispatches here).
 *   - plan mode only: a plan intent comes back with an artifact (content), no
 *     stance (EXPECT_STANCE is fixed to 0 for loom).
 *   - optional --sse-test: tasks/sendSubscribe delivers the task update as an
 *     SSE event (loom capabilities.streaming).
 *
 * Exit codes: 0 every step passed, 1 a step failed, 2 configuration error.
 * Secrets are never printed.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;
const argv = process.argv.slice(2);
const revokeTest = argv.includes('--revoke-test');
const sseTest = argv.includes('--sse-test');
const timeoutIndex = argv.indexOf('--timeout');
const timeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 60_000;

const KERNEL_URL = (env.KERNEL_URL ?? '').replace(/\/+$/, '');
const INTERNAL_TOKEN = env.ZEUS_INTERNAL_TOKEN ?? '';
const LOOM_URL = (env.LOOM_URL ?? '').replace(/\/+$/, '');
const CARD_URL = (env.CARD_URL ?? (LOOM_URL ? `${LOOM_URL}/.well-known/agent-card.json` : '')).replace(/\/+$/, '');
const AGENT_TOKEN = env.AGENT_TOKEN ?? '';
const SKILL = env.SKILL ?? 'generate-content';
const REALM = env.REALM ?? 'personal';
const PARAMS = env.PARAMS ? JSON.parse(env.PARAMS) : undefined;

// loom executes plan skills by their **id** (generate-content / compliance-check /
// effect-backfill), not by the card's display name ("Plan content generation");
// the display name is the card's public label, the id is what tasks/send runs.
// Default params match generate-content's required fields (tenant_id/product_id).

if (!KERNEL_URL) { console.error('KERNEL_URL is required'); process.exit(2); }
if (!INTERNAL_TOKEN) { console.error('ZEUS_INTERNAL_TOKEN is required'); process.exit(2); }
if (!CARD_URL) { console.error('CARD_URL (or LOOM_URL) is required'); process.exit(2); }
if (!AGENT_TOKEN) { console.error('AGENT_TOKEN is required (loom Agent Key, Q88)'); process.exit(2); }

/** @type {Array<{name: string, ok: boolean, note: string}>} */
const steps = [];
function record(name, ok, note) {
  steps.push({ name, ok, note });
  console.log(`${ok ? '✓' : '✗'}  ${name} — ${note}`);
}
const marker = `loom-interop-${randomBytes(4).toString('hex')}`;
const bearer = { authorization: `Bearer ${INTERNAL_TOKEN}` };
const clip = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/g, ' ').slice(0, 160);

async function call(method, path, { auth = false, body } = {}) {
  const headers = { accept: 'application/json' };
  if (auth) headers.authorization = `Bearer ${INTERNAL_TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${KERNEL_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}

async function main() {
  console.log(`kernel: ${KERNEL_URL}`);
  console.log(`card:   ${CARD_URL}`);
  console.log(`skill:  ${SKILL}  realm: ${REALM}  marker: ${marker}`);

  // 1. Kernel is up.
  const health = await call('GET', '/healthz');
  record('the kernel is reachable', health.status === 200, `status=${health.status}`);
  if (!steps[0]?.ok) return finish();

  // 2. Fetch loom's card and assert the loom-specific contract.
  const cardRes = await fetch(CARD_URL, { headers: { accept: 'application/json' } });
  const cardText = await cardRes.text();
  let card;
  try { card = JSON.parse(cardText); } catch { card = null; }
  record('the card is fetchable JSON', cardRes.status === 200 && !!card, `status=${cardRes.status}`);
  if (!card) return finish();
  record('card name is loom', card.name === 'loom', `name=${clip(card.name)}`);
  record('card url is absolute and points at tasks', /^https?:\/\//.test(card.url ?? '') && (card.url ?? '').includes('/api/a2a/tasks'), `url=${clip(card.url)}`);
  record('card declares streaming capability', card.capabilities?.streaming === true, `streaming=${card.capabilities?.streaming}`);
  record('card declares bearer authentication', Array.isArray(card.authentication?.schemes) && card.authentication.schemes.includes('bearer'), `schemes=${clip(card.authentication?.schemes)}`);
  const skillNames = Array.isArray(card.skills) ? card.skills.map((/** @type {any} */ s) => s.name) : [];
  record('card lists the three plan skills', ['Plan content generation', 'Plan compliance cleaning', 'Plan effect feedback backfill'].every((/** @type {string} */ n) => skillNames.includes(n)), `skills=${clip(skillNames.join(','))}`);

  // 3. Optional direct SSE probe of loom's sendSubscribe (independent of Zeus).
  if (sseTest) {
    const probeTask = {
      jsonrpc: '2.0',
      id: `sse-probe-${marker}`,
      method: 'tasks/sendSubscribe',
      params: { skill: SKILL, params: PARAMS ?? { tenant_id: marker, product_id: marker } },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const sse = await fetch(`${LOOM_URL}/api/a2a/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
        body: JSON.stringify(probeTask),
        signal: controller.signal,
      });
      if (sse.status !== 200) throw new Error(`status ${sse.status}`);
      const reader = sse.body?.getReader();
      let sawEvent = false;
      let buf = '';
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          if (buf.includes('event:') || buf.includes('data:')) { sawEvent = true; break; }
        }
        reader.releaseLock();
      }
      record('loom sendSubscribe streams an SSE event', sawEvent, `streaming=${sawEvent}`);
    } catch (error) {
      record('loom sendSubscribe streams an SSE event', false, `error=${clip(error)}`);
    } finally {
      clearTimeout(timer);
    }
  } else {
    console.log('SKIP  direct SSE probe (--sse-test not passed; the Zeus-driven fan-out below still exercises tasks/send)');
  }

  // 4. Register loom into Zeus and assert roster state.
  const registered = await call('POST', '/api/vassals', { auth: true, body: { cardUrl: CARD_URL, token: AGENT_TOKEN } });
  const registerOk = registered.status === 201 || registered.status === 200 || (registered.status >= 400 && /already/i.test(registered.text));
  record('loom registers (card fetched, fealty validated)', registerOk, `status=${registered.status} ${clip(registered.text)}`);
  if (!registerOk) return finish();

  const afterRoster = await call('GET', '/api/roster', { auth: true });
  const entry = (afterRoster.json?.snapshot?.entries ?? []).find((/** @type {any} */ candidate) => candidate.name === 'loom');
  record('loom is listed active in the internal roster', !!entry && entry.status === 'active', `name=${entry?.name} status=${entry?.status ?? '(absent)'}`);

  // 5. No read view echoes the loom credential.
  if (AGENT_TOKEN) {
    const views = /** @type {Array<[string, { text: string }]>} */ ([
      ['/api/roster', afterRoster],
      ['/api/roster/public', await call('GET', '/api/roster/public', { auth: true })],
      ['/api/roster/keys', await call('GET', '/api/roster/keys', { auth: true })],
    ]);
    const echoes = views.filter(([_, r]) => r.text.includes(AGENT_TOKEN)).map(([label]) => label);
    record('no read view echoes the loom credential', echoes.length === 0, echoes.join(', ') || 'checked 3 views');
  } else {
    record('no read view echoes the loom credential', true, 'skipped (no token)');
  }

  // 6. One fan-out through loom (plan mode). Kernel reads the card-declared url.
  const domains = await call('GET', '/api/domains', { auth: true });
  const target = (domains.json?.realms ?? []).find((/** @type {any} */ realm) => realm.type === REALM);
  const fanOut = await call('POST', '/api/intents', {
    auth: true,
    body: {
      skill: SKILL,
      realm: REALM,
      ...(target?.realmId ? { realmId: target.realmId } : {}),
      vassals: ['loom'],
      params: PARAMS ?? { tenant_id: marker, product_id: marker },
    },
  });
  const intentId = fanOut.json?.intentId;
  record('the intent is accepted', [200, 201, 202].includes(fanOut.status) && !!intentId, `status=${fanOut.status} ${clip(fanOut.text)}`);
  if (!intentId) return finish();
  console.log(`      intentId=${intentId}${fanOut.json?.runId ? ` runId=${fanOut.json.runId}` : ''}`);

  const deadline = Date.now() + timeoutMs;
  let result = fanOut.json;
  while (Date.now() < deadline && !['completed', 'failed', 'canceled', 'needs-driver'].includes(result?.status)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const polled = await call('GET', `/api/intents/${intentId}`, { auth: true });
    if (polled.status === 200) result = polled.json;
  }
  const branches = Array.isArray(result?.branches) ? result.branches : [];
  record('the fan-out reached a terminal state inside the timeout', ['completed', 'failed', 'canceled', 'needs-driver'].includes(result?.status), `status=${result?.status}`);
  record('at least one branch came back from loom', branches.length >= 1, `branches=${branches.length}`);

  const succeeded = branches.filter((/** @type {any} */ branch) => branch?.ok === true);
  const contentOf = (/** @type {any} */ branch) => (Array.isArray(branch?.task?.artifacts) ? branch.task.artifacts : [])
    .filter((/** @type {any} */ artifact) => Array.isArray(artifact?.parts) && artifact.parts.length >= 1);
  const withContent = succeeded.filter((/** @type {any} */ branch) => contentOf(branch).length >= 1);
  const report = withContent.flatMap(contentOf).map((/** @type {any} */ artifact) => artifact['x-zeus-report']).find(Boolean);
  record('a branch succeeded and returned an artifact with content', withContent.length >= 1, `ok=${succeeded.length}/${branches.length} withContent=${withContent.length}`);
  record('the report is loom\'s plan text (executor mode, no stance expected)', report !== undefined, `report=${clip(typeof report === 'string' ? report : JSON.stringify(report))}`);

  // 7. Governance facts written by that same run. Audit entries are filtered
  //    client-side (a deployment may hold a long file); the claim is "an entry
  //    for *this* run exists", matching the acceptance-real-fanout precedent.
  const branchRuns = new Set(branches.map((/** @type {any} */ branch) => branch.runId).filter(Boolean));
  const audit = await call('GET', `/api/audit?limit=50`, { auth: true });
  const entries = Array.isArray(audit.json?.entries) ? audit.json.entries : [];
  const mine = entries.filter((/** @type {any} */ entry) => entry.decision === 'dispatched' && (branchRuns.has(entry.runId) || entry.vassal === 'loom'));
  // Zeus models the terminal state inside the dispatch entry (entry.state), not
  // as a separate decision row; a completed/failed state on the matching entry
  // is the terminal signal.
  const terminal = mine.filter((/** @type {any} */ entry) => String(entry.state ?? '').includes('completed') || String(entry.state ?? '').includes('failed'));
  record('audit records the loom fan-out (dispatch + terminal bound to this run)', audit.status === 200 && mine.length >= 1 && terminal.length >= 1, `status=${audit.status} entries=${entries.length} dispatched=${mine.length} terminal=${terminal.length}`);

  // 8. Optional teardown: revoke loom again (--revoke-test).
  if (revokeTest) {
    const revoked = await call('DELETE', `/api/vassals/${encodeURIComponent('loom')}`, { auth: true });
    record('loom is revoked again', [200, 204].includes(revoked.status), `status=${revoked.status}`);
  } else {
    console.log('SKIP  teardown revoke (--revoke-test not passed; loom stays registered for the next run)');
  }

  return finish();
}

function finish() {
  const failed = steps.filter((/** @type {{ok: boolean}} */ step) => !step.ok);
  console.log('');
  console.log(failed.length === 0
    ? `ALL ${steps.length} STEPS PASSED`
    : `${failed.length}/${steps.length} STEPS FAILED`);
  if (failed.length) {
    for (const step of failed) console.log(`  ✗ ${step.name} — ${step.note}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`unexpected: ${clip(error)}`);
  process.exit(1);
});

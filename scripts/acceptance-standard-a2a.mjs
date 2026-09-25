#!/usr/bin/env node
/**
 * Acceptance #6 guard script (design-vassal-protocol.md §7, item 6):
 * "A standards-only A2A client that knows nothing about x-zeus-* must still be
 *  able to call pr-helper successfully — the guard test for 'superset, not walled
 *  garden'. If this fails, the protocol design fails."
 *
 * This script deliberately:
 *   - reads only standard Agent Card fields (name / skills / url); it never reads
 *     card['x-zeus-fealty'] or any other x-zeus-* extension;
 *   - sends a standard `tasks/send` JSON-RPC call with a plain text part (the
 *     skill id is the first whitespace token, the standard fallback pr-helper's
 *     rpc.parseSkillAndParams implements);
 *   - never sends x-zeus-runId or any extension metadata.
 *
 * Usage (after pr-helper is deployed):
 *   BASE_URL=https://<pr-helper-host> node scripts/acceptance-standard-a2a.mjs [skill]
 *   TOKEN=<bearer>   optional, only if the deployment sets ZEUS_A2A_TOKEN
 *
 * Exit code: 0 all checks passed; 1 any check failed (diagnostics on stderr).
 * Requires Node 18+ (global fetch). Zero dependencies.
 */

const BASE_URL = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.TOKEN || process.env.A2A_TOKEN || '';
const SKILL = process.argv[3] || process.env.SKILL || 'deployment-health';

const VALID_STATES = ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'];

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}
function pass(message) {
  console.log(`[PASS] ${message}`);
}

if (!BASE_URL) {
  fail('BASE_URL is required, e.g. BASE_URL=https://pr-helper.example.com node scripts/acceptance-standard-a2a.mjs');
}

const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function main() {
  // 1. Standard Agent Card discovery.
  const cardUrl = `${BASE_URL}/api/a2a/agent-card`;
  const cardRes = await fetch(cardUrl, { headers: authHeaders });
  if (!cardRes.ok) fail(`agent-card discovery failed: HTTP ${cardRes.status} at ${cardUrl}`);
  const card = await cardRes.json();
  if (typeof card.name !== 'string' || !card.name) fail('agent card has no string "name"');
  if (!Array.isArray(card.skills) || card.skills.length === 0) fail('agent card has no skills[]');
  // NOTE: card['x-zeus-fealty'] is intentionally never read — a standards-only
  // client has no knowledge of Zeus extensions.
  pass(`agent card discovered: "${card.name}" with ${card.skills.length} skill(s)`);

  // 2. Standard tasks/send with a plain text part; no x-zeus-* fields anywhere.
  //    The JSON-RPC surface lives on the same path as card discovery
  //    (GET = Agent Card, POST = JSON-RPC), matching pr-helper's routing.
  const requestBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tasks/send',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text: SKILL }],
      },
    },
  };
  const taskRes = await fetch(`${BASE_URL}/api/a2a/agent-card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(requestBody),
  });
  if (!taskRes.ok) fail(`tasks/send failed: HTTP ${taskRes.status}`);
  const envelope = await taskRes.json();
  if (envelope.error) fail(`JSON-RPC error ${envelope.error.code}: ${envelope.error.message}`);
  const task = envelope.result;
  if (!task || task.kind !== 'task') fail('response envelope has no result with kind="task"');
  if (!task.id || !task.contextId) fail('task is missing id or contextId');
  if (!VALID_STATES.includes(task.status?.state)) fail(`unexpected task state: ${String(task.status?.state)}`);
  pass(`task accepted and lifecycle started: id=${task.id} state=${task.status.state}`);

  console.log('');
  console.log(`PASS: acceptance #6 — a standards-only A2A client (zero x-zeus-* usage) completed a call against ${BASE_URL}`);
}

main().catch(error => fail(error && error.stack ? error.stack : String(error)));

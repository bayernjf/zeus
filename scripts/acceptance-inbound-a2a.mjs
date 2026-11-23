#!/usr/bin/env node
// @ts-check
/**
 * Z-05: a real local/intranet upstream A2A caller for Zeus's inbound face.
 *
 * This script is the operator-runnable counterpart to
 * `tests/http-inbound-a2a-live.test.ts`. It opens a real HTTP connection to a
 * running Zeus instance and sends a JSON-RPC `tasks/send` with the caller's
 * Agent Card in `x-zeus-caller-card`, exactly as an upstream agent would.
 *
 * The caller card must be the same card Zeus has in its registry when the caller
 * is expected to be roster-anchored (tier-3); an unregistered card is still
 * accepted, but only as tier-1 with a read-only skill. The server audit log is
 * the authority for which tier was decided; this script only asserts the
 * transport + task receipt contract.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:8787 TOKEN=<operator-bearer> \
 *   CALLER_CARD_FILE=./caller-card.json \
 *   node scripts/acceptance-inbound-a2a.mjs [skill]
 *
 * CALLER_CARD (inline JSON) is accepted when a file is not convenient.
 * Exit code: 0 all checks passed; 1 any check failed.
 * Requires Node 18+ (global fetch). Zero dependencies.
 */

import { readFileSync } from 'node:fs';

const BASE_URL = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
const SKILL = process.argv[3] || process.env.SKILL || 'summarize';
const TOKEN = process.env.TOKEN || process.env.A2A_TOKEN || '';
const TASK_ID = process.env.TASK_ID || `acceptance-inbound-${Date.now()}`;
const VALID_STATES = ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'];

/** @param {string} message */
function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}
/** @param {string} message */
function pass(message) {
  console.log(`[PASS] ${message}`);
}

if (!BASE_URL) {
  fail('BASE_URL is required, e.g. BASE_URL=http://127.0.0.1:8787 node scripts/acceptance-inbound-a2a.mjs');
}

function readCallerCard() {
  const inline = process.env.CALLER_CARD;
  const file = process.env.CALLER_CARD_FILE;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (error) {
      fail(`CALLER_CARD is not valid JSON: ${String(error)}`);
    }
  }
  if (!file) fail('CALLER_CARD_FILE or CALLER_CARD is required (the upstream agent card JSON)');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read CALLER_CARD_FILE=${file}: ${String(error)}`);
  }
}

const callerCard = readCallerCard();
if (!callerCard || typeof callerCard.name !== 'string' || !callerCard.name) {
  fail('caller card has no string "name"');
}
if (!callerCard['x-zeus-handshake']) {
  fail('caller card has no x-zeus-handshake; Zeus refuses cards without a valid oath');
}

/** @type {Record<string, string>} */
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function main() {
  const cardUrl = `${BASE_URL}/.well-known/agent-card.json`;
  const cardRes = await fetch(cardUrl, { headers: authHeaders });
  if (!cardRes.ok) fail(`Zeus agent-card discovery failed: HTTP ${cardRes.status} at ${cardUrl}`);
  const zeusCard = await cardRes.json();
  if (typeof zeusCard.name !== 'string' || !zeusCard.name) fail('Zeus agent card has no string "name"');
  pass(`Zeus agent card discovered: "${zeusCard.name}"`);

  const requestHeaders = {
    'Content-Type': 'application/json',
    'x-zeus-caller-card': JSON.stringify(callerCard),
    ...authHeaders,
  };
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tasks/send',
    params: {
      taskId: TASK_ID,
      message: 'acceptance inbound a2a',
      skills: [SKILL],
    },
  };
  const taskRes = await fetch(cardUrl, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
  if (!taskRes.ok) {
    const detail = await taskRes.text().catch(() => '');
    fail(`tasks/send failed: HTTP ${taskRes.status} ${detail}`.trim());
  }
  const envelope = await taskRes.json();
  if (envelope.error) fail(`JSON-RPC error ${envelope.error.code}: ${envelope.error.message}`);
  // Zeus returns the A2A task receipt directly (design-inbound-a2a §3); a
  // wrappers-around implementation may return it under JSON-RPC `result`. Accept
  // both so the script stays a transport check, not a shape assertion.
  const task = envelope.result ?? envelope;
  if (!task || task.kind !== 'task') fail('response envelope has no result with kind="task"');
  if (!task.id || !task.contextId) fail('task is missing id or contextId');
  if (!VALID_STATES.includes(task.status?.state)) fail(`unexpected task state: ${String(task.status?.state)}`);
  pass(`task accepted: id=${task.id} context=${task.contextId} state=${task.status.state}`);

  console.log('');
  console.log(
    `PASS: inbound A2A caller "${callerCard.name}" reached Zeus at ${BASE_URL} with skill "${SKILL}" (task ${TASK_ID})`,
  );
}

main().catch(error => fail(error && error.stack ? error.stack : String(error)));

#!/usr/bin/env node
// @ts-check
// Export a verifiable audit report from the decision audit JSONL.
//
//   node scripts/audit-report.mjs [--state-dir DIR] [--audit FILE] [--key FILE]
//                                 [--key-id ID] [--out DIR] [--json-only]
//
// The report is for someone who does not trust us: every entry's hash, the
// chain head and tail, the verification result and the command to re-run the
// check with nothing but the public key. The exit code follows the verification
// result, so a tampered chain can never leave a green report behind.
//
// Only the PUBLIC key is needed -- `--key` accepts the private PEM or its public
// counterpart, because verification decrypts and signs nothing. Fail-closed:
// missing key, empty file, broken link all exit 1 with a reason.

import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { decodeAuditJsonl } from '../dist/core/audit/jsonl.js';
import { verifyDecisionAuditChain } from '../dist/core/audit/audit-chain.js';
import { Ed25519Verifier } from '../dist/core/signing.js';

/** The server publishes `audit.jsonl`; older checkouts used the longer name. */
export const AUDIT_CANDIDATES = ['data/audit.jsonl', 'data/decision-audit.jsonl'];
export const KEY_CANDIDATES = ['data/rsk-ed25519.pem'];

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`audit-report: ${message}\n`);
  process.exit(1);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) fail(`unknown argument: ${arg}`);
    const name = arg.slice(2);
    if (name === 'help') {
      out.help = '1';
      continue;
    }
    if (name === 'json-only') {
      out['json-only'] = '1';
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
    out[name] = value;
    i += 1;
  }
  return out;
}

/**
 * @param {string} dir
 * @param {string[]} candidates
 * @returns {string | null}
 */
function firstExisting(dir, candidates) {
  for (const candidate of candidates) {
    const path = resolve(dir, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * A key that cannot be read is not a key. Refusing here instead of verifying
 * against an empty keyring matters: an empty keyring reports every signature as
 * invalid, which is indistinguishable from a tampered chain.
 * @param {string} path
 */
function loadPublicKey(path) {
  let pem;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`cannot read signing key ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!pem.includes('KEY-----')) fail(`signing key ${path} does not look like a PEM key`);
  try {
    // Accepts a private PEM as well: deriving the public half is all we need.
    return createPublicKey(pem);
  } catch (error) {
    fail(
      `signing key ${path} is not a usable Ed25519 key: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function utcStamp() {
  const now = new Date();
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

/** @param {string} value @param {number} keep */
const head = (value, keep = 16) => (value.length <= keep ? value : `${value.slice(0, keep)}…`);

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        'usage: node scripts/audit-report.mjs [--state-dir DIR] [--audit FILE] [--key FILE]',
        '                                    [--key-id ID] [--out DIR] [--json-only]',
        '',
        `audit candidates: ${AUDIT_CANDIDATES.join(', ')}`,
        `key candidates:   ${KEY_CANDIDATES.join(', ')}`,
      ].join('\n') + '\n'
    );
    return;
  }

  const stateDir = resolve(args['state-dir'] ?? '.');
  const auditPath = args.audit ? resolve(stateDir, args.audit) : firstExisting(stateDir, AUDIT_CANDIDATES);
  if (!auditPath) fail(`no audit file under ${stateDir} (looked for ${AUDIT_CANDIDATES.join(', ')})`);
  if (!existsSync(auditPath)) fail(`audit file does not exist: ${auditPath}`);

  if (statSync(auditPath).size === 0) fail(`no entries -- ${auditPath} is empty; nothing to verify`);
  const raw = readFileSync(auditPath, 'utf8');
  if (raw.trim() === '') fail(`no entries -- ${auditPath} contains only whitespace`);

  /** @type {import('../dist/core/audit/types.js').DecisionAuditEntry[]} */
  let entries;
  try {
    entries = decodeAuditJsonl(raw);
  } catch (error) {
    fail(`cannot decode ${auditPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (entries.length === 0) fail(`no entries -- ${auditPath} decoded to zero records`);

  const keyPath = args.key ? resolve(stateDir, args.key) : firstExisting(stateDir, KEY_CANDIDATES);
  if (!keyPath) {
    fail(
      `signing key not found under ${stateDir} (looked for ${KEY_CANDIDATES.join(', ')}); ` +
        'a chain cannot be verified without it'
    );
  }
  if (!existsSync(keyPath)) fail(`signing key does not exist: ${keyPath}`);

  const publicKey = loadPublicKey(keyPath);
  const publicKeySha256 = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');

  // The chain records which key sealed each entry. Defaulting to the first
  // entry's keyId keeps a rotated key from turning a valid chain into "invalid".
  const keyId = args['key-id'] ?? entries[0]?.keyId ?? '';
  const verifier = new Ed25519Verifier([[keyId, publicKey]]);

  const verification = await verifyDecisionAuditChain(entries, verifier);
  const first = entries[0];
  const last = entries[entries.length - 1];
  const now = new Date().toISOString();

  const report = {
    generatedAt: now,
    auditFile: auditPath,
    auditBytes: statSync(auditPath).size,
    keyFile: keyPath,
    keyId,
    publicKeySha256,
    count: entries.length,
    first: { seq: first?.seq ?? null, hash: first?.hash ?? null, at: first?.payload?.at ?? null },
    last: { seq: last?.seq ?? null, hash: last?.hash ?? null, at: last?.payload?.at ?? null },
    verification,
    // Replays reproducible by a third party: same file, same public key.
    verifyCommand: `node scripts/audit-report.mjs --audit ${auditPath} --key ${keyPath} --json-only`,
    entries: entries.map((entry) => ({
      seq: entry.seq,
      at: entry.payload?.at ?? null,
      kind: entry.payload?.kind ?? null,
      decisionId: entry.payload?.decisionId ?? null,
      actor: entry.payload?.actor ?? null,
      hash: entry.hash,
      signature: entry.signature,
    })),
  };

  const outDir = resolve(args.out ?? 'audit-reports');
  mkdirSync(outDir, { recursive: true });
  const outStamp = utcStamp();
  const jsonPath = join(outDir, `audit-report-${outStamp}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  const rows = report.entries.map(
    (entry) =>
      `| ${entry.seq} | ${text(entry.at)} | ${text(entry.kind)} | ${text(entry.decisionId)} | ${head(text(entry.actor))} | \`${head(text(entry.hash))}\` |`
  );

  const verdict = verification.ok
    ? `VERIFY_OK — ${verification.count} entries, seq 0..${last?.seq ?? 0}, last entry ${text(last?.payload?.at) || '(no timestamp)'}`
    : `VERIFY_FAILED at seq ${verification.seq} — ${verification.reason}`;

  const markdown = [
    '# Decision audit report',
    '',
    `**${verdict}**`,
    '',
    `- Generated: ${now}`,
    `- Audit file: \`${auditPath}\` (${report.auditBytes} bytes)`,
    `- Key file: \`${keyPath}\` (keyId \`${keyId}\`)`,
    `- Public key SHA-256 (SPKI DER): \`${publicKeySha256}\``,
    `- Chain head: seq ${first?.seq ?? '-'} \`${text(first?.hash ?? '')}\``,
    `- Chain tail: seq ${last?.seq ?? '-'} \`${text(last?.hash ?? '')}\``,
    '',
    '## How to re-check this report',
    '',
    'Verification needs no private key and no network:',
    '',
    '```bash',
    'npm run build          # the script reads dist/, the same code the server runs',
    `node scripts/audit-report.mjs --audit ${auditPath} --key <public-key.pem> --out /tmp/verify`,
    '```',
    '',
    'A single altered byte in the JSONL changes the recomputed hash, so the script reports',
    '`VERIFY_FAILED` and exits 1. An unverifiable chain must never produce exit 0.',
    '',
    '## Entries',
    '',
    '| seq | at | kind | decisionId | actor | hash |',
    '|---:|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');

  const mdPath = join(outDir, `audit-report-${outStamp}.md`);
  if (!args['json-only']) writeFileSync(mdPath, markdown, { mode: 0o600 });

  process.stdout.write(
    `audit-report: ${verdict}\n` +
      `  json: ${jsonPath}\n` +
      (args['json-only'] ? '' : `  md:   ${mdPath}\n`)
  );

  process.exit(verification.ok ? 0 : 1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

#!/usr/bin/env node
/**
 * Offline roster verification (design-fealty-signing.md §4/§4.1, PRD E4.9/E5.4).
 *
 * The signing chain's whole promise is "a published roster can be verified
 * without trusting the server that published it" — but until now the only way to
 * exercise that promise was to write TypeScript against the library. This script
 * is the operator-facing entry point for it: fetch (or read) a signed roster
 * snapshot, hold the RSK public key, and report whether it is genuine.
 *
 * It verifies, in this order (same order the library uses):
 *   0. version gates  - payload schemaVersion, seal.v, attestation.v
 *   1. seal binding   - snapshotDigest over the canonical payload
 *   2. freshness      - issuedAt skew, maxAgeSeconds
 *   3. seal signature - Ed25519 over the canonical unsigned seal
 *   4. per entry      - attestation presence, name binding, exact status match,
 *                       hard expiry for active rows, signature
 * Optional deep check (--card <name>=<path>) recomputes the card digests, which
 * detects tampering with fields the roster projection drops.
 *
 * Usage (requires `npm run build` first — it verifies with the shipped
 * implementation, not a re-implementation of canonicalization):
 *   node scripts/verify-roster.mjs --url https://host/api/roster/public --key ./rsk-public.pem
 *   node scripts/verify-roster.mjs --file ./roster.json --key zeus-rsk-2026-09=./rsk-public.pem
 *   node scripts/verify-roster.mjs --url http://127.0.0.1:8787/api/roster --key ./k.pem \
 *        --token "$ZEUS_INTERNAL_TOKEN" --card pr-helper=./card.json
 *
 * Exit codes: 0 verified; 1 verification rejected (reason on stderr);
 *             2 usage or I/O failure (bad arguments, unfetchable URL, unreadable
 *               key or file, unparseable JSON).
 * Requires Node 18+ (global fetch). Zero dependencies.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    [
      'usage: node scripts/verify-roster.mjs (--url <uri> | --file <path>) --key <[keyId=]publicKeyPem> [--key ...] [options]',
      '',
      '  --url URI          fetch the signed envelope over HTTP (GET)',
      '  --file PATH          read a saved envelope from disk',
      '  --key [keyId=]PATH   RSK public key (PEM). Repeatable; with no keyId the',
      '                       envelope\'s own seal.keyId is assumed',
      '  --token BEARER       authorization bearer, for the internal roster only',
      '  --header NAME=VALUE  extra request header (repeatable)',
      '  --card name=PATH     deep-check that entry against a locally held Agent Card',
      '  --now ISO            evaluation time for freshness (default: wall clock)',
      '  --quiet              print only the verdict line',
      '',
      'exit: 0 verified | 1 rejected | 2 usage or I/O error',
    ].join('\n')
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { keys: [], cards: [], headers: [] };

for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) usage(`${flag} needs a value`);
    return v;
  };
  if (flag === '--url') opts.url = next();
  else if (flag === '--file') opts.file = next();
  else if (flag === '--key') opts.keys.push(next());
  else if (flag === '--token') opts.token = next();
  else if (flag === '--header') opts.headers.push(next());
  else if (flag === '--card') opts.cards.push(next());
  else if (flag === '--now') opts.now = next();
  else if (flag === '--quiet') opts.quiet = true;
  else usage(`unknown argument: ${flag}`);
}

if (!opts.url && !opts.file) usage('give either --url or --file');
if (opts.url && opts.file) usage('--url and --file are mutually exclusive');
if (opts.keys.length === 0) usage('at least one --key is required');
if (opts.now && Number.isNaN(Date.parse(opts.now))) usage(`--now is not an ISO date: ${opts.now}`);

function splitSpec(spec) {
  const at = spec.indexOf('=');
  // A bare path has no '='; "keyId=path" does. Windows paths would break this,
  // so the delimited form is documented as keyId=path and a bare path is the norm.
  return at === -1 ? { keyId: null, path: spec } : { keyId: spec.slice(0, at), path: spec.slice(at + 1) };
}

async function loadEnvelope() {
  if (opts.file) {
    if (!existsSync(opts.file)) usage(`no such file: ${opts.file}`);
    return readFileSync(opts.file, 'utf8');
  }
  const headers = {};
  for (const h of opts.headers) {
    const at = h.indexOf('=');
    if (at === -1) usage(`--header wants NAME=VALUE, got: ${h}`);
    headers[h.slice(0, at)] = h.slice(at + 1);
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let response;
  try {
    response = await fetch(opts.url, { headers });
  } catch (e) {
    console.error(`error: cannot reach ${opts.url}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (!response.ok) {
    console.error(`error: ${opts.url} responded ${response.status} ${response.statusText}`);
    process.exit(2);
  }
  return response.text();
}

let envelope;
try {
  envelope = JSON.parse(await loadEnvelope());
} catch (e) {
  usage(`artifact is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
}

// Import after parsing so argument errors never depend on the build being present.
let Ed25519Verifier, verifySignedSnapshot, attestationMatchesCard;
try {
  ({ Ed25519Verifier, verifySignedSnapshot, attestationMatchesCard } = await import('../dist/registry/signing.js'));
} catch {
  usage('dist/registry/signing.js is missing - run `npm run build` first');
}

const sealKeyId = envelope?.seal?.keyId;
if (!sealKeyId) usage('artifact has no seal.keyId - is this a signed roster envelope?');

const pairs = [];
for (const spec of opts.keys) {
  const { keyId, path } = splitSpec(spec);
  if (!existsSync(path)) usage(`no such key file: ${path}`);
  let key;
  try {
    key = createPublicKey(readFileSync(path, 'utf8'));
  } catch (e) {
    usage(`cannot read public key ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') usage(`public key ${path} is ${String(key.asymmetricKeyType)}, expected ed25519`);
  // An unlabelled key is assumed to belong to the keyId in the seal; a labelled
  // one is registered under its own id, which lets several keys be offered.
  pairs.push([keyId ?? sealKeyId, key]);
}

const entriesDeepChecked = [];
const deepFailures = [];
const cards = new Map();
for (const spec of opts.cards) {
  const { keyId: name, path } = splitSpec(spec);
  if (!name) usage(`--card wants name=path, got: ${spec}`);
  if (!existsSync(path)) usage(`no such card file: ${path}`);
  try {
    cards.set(name, JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    usage(`card ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const verifier = new Ed25519Verifier(pairs);
const now = opts.now ? new Date(opts.now) : new Date();
const result = await verifySignedSnapshot(envelope, verifier, now);

const snapshot = envelope.snapshot ?? {};
const issuedAt = envelope.seal?.issuedAt;
const ageSeconds = issuedAt ? (now.getTime() - Date.parse(issuedAt)) / 1000 : null;

if (!opts.quiet) {
  console.log(`scope             ${String(snapshot.scope)}`);
  console.log(`schemaVersion     ${String(snapshot.schemaVersion ?? '(absent: pre-v1.2 artifact, read as 1)')}`);
  console.log(`entries           ${Array.isArray(snapshot.entries) ? snapshot.entries.length : '(none)'}`);
  console.log(`seal keyId        ${sealKeyId}`);
  console.log(`seal issuedAt     ${String(issuedAt)}${ageSeconds === null ? '' : ` (age ${ageSeconds.toFixed(0)}s)`}`);
  console.log(`seal maxAge       ${String(envelope.seal?.maxAgeSeconds)}s`);
  const statuses = Array.isArray(snapshot.entries)
    ? snapshot.entries.map(e => `${String(e.name)}=${String(e.status)}`).join(' ') || '(empty)'
    : '(none)';
  console.log(`entry statuses    ${statuses}`);
  for (const [name, card] of cards) {
    const attestation = envelope.attestations?.[name];
    if (!attestation) {
      console.log(`deep check ${name}  no attestation for that name`);
      continue;
    }
    entriesDeepChecked.push(name);
    const matched = attestationMatchesCard(attestation, card);
    // A deep check that cannot fail the run is decoration, not verification.
    if (!matched) deepFailures.push(name);
    console.log(`deep check ${name}  ${matched ? 'card digests match' : 'MISMATCH: card does not match the attestation'}`);
  }
}

if (!result.ok) {
  console.error(`REJECTED: ${result.reason}`);
  process.exit(1);
}

if (deepFailures.length) {
  console.error(`REJECTED: card digests do not match the attestation for: ${deepFailures.join(', ')}`);
  process.exit(1);
}

// A supplied card that no attestation covers is not a pass: it means the roster
// does not speak for that agent, and silently ignoring it would read as a match.
const uncovered = [...cards.keys()].filter(name => !entriesDeepChecked.includes(name));
if (uncovered.length) {
  console.error(`REJECTED: no attestation for supplied card(s): ${uncovered.join(', ')}`);
  process.exit(1);
}

console.log(`VERIFIED  ${pairs.length === 1 ? `keyId=${pairs[0][0]}` : `${pairs.length} keys offered`}: signature, digest binding, freshness and per-entry attestations all check out`);
process.exit(0);

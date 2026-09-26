import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { projectPublicRoster } from '../src/registry/roster.js';
import { Ed25519MemorySigner, sealSnapshot, canonicalDigest, type AttestationSource } from '../src/registry/signing.js';
import type { AgentCard } from '../src/a2a/types.js';
import type { VassalEntry as RegistryEntry } from '../src/registry/registry.js';

const SCRIPT = fileURLToPath(new URL('../scripts/verify-roster.mjs', import.meta.url));
const T0 = new Date('2026-09-26T09:00:00.000Z');
const dir = mkdtempSync(join(tmpdir(), 'zeus-verify-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fealtyCard(name: string): AgentCard {
  return {
    name,
    url: `http://${name}.internal`,
    skills: [{ id: `${name}-skill`, name: `${name} skill`, description: '', tags: [] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: `${name}-domain`,
      dataRealms: ['personal'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
    },
  } as unknown as AgentCard;
}

function registryEntry(card: AgentCard): RegistryEntry & { status: 'active' | 'revoked' } {
  return {
    cardUrl: `${String(card.url)}/api/a2a/agent-card`,
    taskUrl: `${String(card.url)}/api/a2a/tasks`,
    card,
    fealty: card['x-zeus-fealty'] as never,
    registeredAt: T0.toISOString(),
    revoked: false,
    status: 'active',
  } as unknown as RegistryEntry & { status: 'active' | 'revoked' };
}

/** Build a genuinely signed envelope and drop it on disk, exactly like a publication. */
async function publish(name = 'roster') {
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  const card = fealtyCard('pr-helper');
  const snapshot = projectPublicRoster([registryEntry(card)], () => T0);
  const sources: AttestationSource[] = [{ name: 'pr-helper', card, cardUrl: `${String(card.url)}/api/a2a/agent-card` }];
  const envelope = await sealSnapshot(snapshot, signer, { now: T0, maxAgeSeconds: 3600, attestationTtlSeconds: 3600, sources });
  const envelopePath = join(dir, `${name}.json`);
  const keyPath = join(dir, `${name}.pub.pem`);
  writeFileSync(envelopePath, JSON.stringify(envelope));
  writeFileSync(keyPath, signer.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(dir, `${name}.card.json`), JSON.stringify(card));
  return { envelope, envelopePath, keyPath, cardPath: join(dir, `${name}.card.json`), signer };
}

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // The seal is only valid inside its maxAgeSeconds window, and the script's
  // default evaluation time is the wall clock — so a case that omits --now
  // measures the calendar, not the code. (It did: these four cases went red once
  // real time passed T0+3600s while the implementation was unchanged.) Pin it
  // unless the caller asks for a specific instant.
  const effective = args.includes('--now') ? args : [...args, '--now', T0.toISOString()];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...effective]);
    let stdout = '';
    let stderr = '';
    // Spawning node costs a cold start; this suite runs while other suites share
    // the CPU, so the ceiling has to survive contention, not just the work itself.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('verify-roster script timed out'));
    }, 40_000);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Every case spawns a cold Node process. Measured here on an idle machine:
// 3-8s per case. Contention measured elsewhere in this repo slows these ~10x
// (a 2.5s vault case took 25s with two suites racing), which would put them
// straight through the global 20s ceiling. The ceiling is a hang detector, not a
// claim about how fast a process spawn must be, so it is raised for this file
// only - the rest of the suite keeps 20s.
describe('scripts/verify-roster.mjs', { timeout: 90_000 }, () => {
  it('verifies a published roster with only the public key', async () => {
    const { envelopePath, keyPath } = await publish('valid');
    const result = await run(['--file', envelopePath, '--key', keyPath]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/VERIFIED/);
    expect(result.stdout).toMatch(/schemaVersion\s+1/);
    expect(result.stdout).toMatch(/entry statuses\s+pr-helper=active/);
  });

  it('refuses a replay of a still-signed but stale seal', async () => {
    const { envelopePath, keyPath } = await publish('stale');
    // Same key, same bytes, same signature: only the freshness gate can catch a
    // re-served old roster, so the gate must fire at the script boundary too.
    const past = new Date(T0.getTime() + 3601_000).toISOString();
    const result = await run(['--file', envelopePath, '--key', keyPath, '--now', past]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/past maxAgeSeconds/);
  });

  it('rejects an edited payload with the digest reason, not a signature reason', async () => {
    const { envelope, envelopePath, keyPath } = await publish('tampered');
    const edited = structuredClone(envelope);
    edited.snapshot.entries[0].name = 'someone-else';
    // Recompute the digest so only the signature layer could notice, then drop the
    // digest edit too: this proves the binding check is the one that fires.
    writeFileSync(envelopePath, JSON.stringify(edited));
    const tamperedDigest = await run(['--file', envelopePath, '--key', keyPath]);
    expect(tamperedDigest.status).toBe(1);
    expect(tamperedDigest.stderr).toMatch(/snapshotDigest mismatch/);
  });

  it('rejects when the signature does not match the re-serialised content', async () => {
    const { envelope, envelopePath, signer } = await publish('reSigned');
    const edited = structuredClone(envelope);
    edited.snapshot.entries[0].description = 'rewritten';
    edited.seal.snapshotDigest = canonicalDigest(edited.snapshot);
    // Re-signing with the same key still needs a valid signature over the new
    // bytes; drop the signature to stand in for an attacker who cannot forge it.
    edited.seal.sig = 'AAAA';
    writeFileSync(envelopePath, JSON.stringify(edited));
    const result = await run(['--file', envelopePath, '--key', join(dir, 'reSigned.pub.pem')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/seal signature verification failed/);
    expect(signer.keyId).toBe('zeus-rsk-test');
  });

  it('rejects a foreign public key', async () => {
    const { envelopePath } = await publish('foreign');
    const other = generateKeyPairSync('ed25519');
    const otherPath = join(dir, 'other.pub.pem');
    writeFileSync(otherPath, other.publicKey.export({ type: 'spki', format: 'pem' }));
    const result = await run(['--file', envelopePath, '--key', otherPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/seal signature verification failed/);
  });

  it('rejects a payload from a newer schema version instead of verifying it', async () => {
    const { envelope, envelopePath, signer } = await publish('future');
    const edited = structuredClone(envelope);
    edited.snapshot.schemaVersion = 99;
    // A future producer signs its own shape, so digest and signature are both
    // self-consistent here: only the version gate can refuse it.
    const resealed = await sealSnapshot(edited.snapshot, signer, { now: T0, maxAgeSeconds: 3600 });
    writeFileSync(envelopePath, JSON.stringify(resealed));
    const result = await run(['--file', envelopePath, '--key', join(dir, 'future.pub.pem')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unsupported roster schemaVersion 99/);
  });

  it('deep-checks a held card and refuses when it matches nothing', async () => {
    const { envelopePath, keyPath, cardPath } = await publish('deep');
    const match = await run(['--file', envelopePath, '--key', keyPath, '--card', `pr-helper=${cardPath}`]);
    expect(match.status).toBe(0);
    expect(match.stdout).toMatch(/deep check pr-helper  card digests match/);

    const mismatch = structuredClone(JSON.parse(readFileSync(cardPath, 'utf8')));
    mismatch['x-zeus-fealty'].dataPolicy = 'write';
    const badPath = join(dir, 'deep.card.bad.json');
    writeFileSync(badPath, JSON.stringify(mismatch));
    const bad = await run(['--file', envelopePath, '--key', keyPath, '--card', `pr-helper=${badPath}`]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/MISMATCH/);

    const unknown = await run(['--file', envelopePath, '--key', keyPath, '--card', `ghost=${cardPath}`]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/no attestation for supplied card\(s\): ghost/);
  });

  it('exits 2 on I/O and usage failures rather than reporting a verification verdict', async () => {
    const missingKey = existsSync(join(dir, 'nope.pem'));
    expect(missingKey).toBe(false);
    const { envelopePath } = await publish('io');
    const noKey = await run(['--file', envelopePath]);
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toMatch(/at least one --key/);
    expect(noKey.stderr).toMatch(/usage:/);

    const badPath = join(dir, 'not-json.json');
    writeFileSync(badPath, '{nope');
    const bad = await run(['--file', badPath, '--key', join(dir, 'io.pub.pem')]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/not valid JSON/);

    const unreachable = await run(['--url', 'http://127.0.0.1:9/roster', '--key', join(dir, 'io.pub.pem')]);
    expect(unreachable.status).toBe(2);
    expect(unreachable.stderr).toMatch(/cannot reach/);
  });
});

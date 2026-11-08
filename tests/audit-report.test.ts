import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditEntryHash, auditSigningText } from '../src/core/audit/audit-chain.js';
import { Ed25519MemorySigner } from '../src/core/signing.js';
import type { DecisionAuditEntry, DecisionAuditPayload } from '../src/core/audit/types.js';

const script = fileURLToPath(new URL('../scripts/audit-report.mjs', import.meta.url));

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** Seal a short chain the way the server does, and lay it on disk. */
async function writeChain(
  size: number
): Promise<{ root: string; auditFile: string; keyFile: string; publicFile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zeus-audit-report-'));
  tempDir = root;
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const pair = generateKeyPairSync('ed25519');
  const keyFile = join(dataDir, 'rsk-ed25519.pem');
  const publicFile = join(dataDir, 'rsk-public.pem');
  writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });

  const signer = new Ed25519MemorySigner('drill-key', pair.privateKey, pair.publicKey);
  const kinds = ['decision.created', 'decision.approved', 'decision.completed'] as const;
  let prevHash = 'GENESIS';
  const lines: string[] = [];

  for (let index = 0; index < size; index += 1) {
    const payload: DecisionAuditPayload = {
      kind: kinds[index % kinds.length] ?? 'decision.created',
      at: `2026-11-0${index + 1}T00:00:00.000Z`,
      decisionId: `dec_${String(index).padStart(3, '0')}`,
      actor: 'drill-owner',
      data: { step: index },
    };
    const doc = { seq: index, prevHash, keyId: signer.keyId, payload };
    const hash = auditEntryHash(doc);
    const signature = await signer.sign(auditSigningText(doc));
    lines.push(JSON.stringify({ seq: index, prevHash, keyId: signer.keyId, payload, hash, signature }));
    prevHash = hash;
  }

  const auditFile = join(dataDir, 'audit.jsonl');
  writeFileSync(auditFile, `${lines.join('\n')}\n`);
  return { root, auditFile, keyFile, publicFile };
}

interface RunResult {
  status: number;
  output: string;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('audit-report', () => {
  it('reports VERIFY_OK and exits 0 for an intact chain', async () => {
    const layout = await writeChain(3);
    const result = run(['--state-dir', layout.root, '--out', join(layout.root, 'out')]);

    expect(result.status).toBe(0);
    expect(result.output).toContain('VERIFY_OK — 3 entries');
    expect(result.output).toContain('seq 0..2');
  });

  it('writes a report carrying the chain ends and a re-check command', async () => {
    const layout = await writeChain(3);
    const out = join(layout.root, 'out');
    const result = run(['--state-dir', layout.root, '--out', out]);
    expect(result.status).toBe(0);

    const jsonLine = result.output.split('\n').find((line) => line.includes('json:'));
    expect(jsonLine).toBeDefined();
    const jsonPath = jsonLine?.split('json:')[1]?.trim() ?? '';
    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      count: number;
      verification: { ok: boolean };
      first: { seq: number; hash: string };
      last: { seq: number; hash: string };
      verifyCommand: string;
      entries: DecisionAuditEntry[];
    };

    expect(report.count).toBe(3);
    expect(report.verification.ok).toBe(true);
    expect(report.first.seq).toBe(0);
    expect(report.last.seq).toBe(2);
    expect(report.last.hash).not.toBe(report.first.hash);
    expect(report.verifyCommand).toContain('audit-report.mjs');
    expect(report.entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
  });

  it('fails closed when one entry is altered', async () => {
    const layout = await writeChain(3);
    const lines = readFileSync(layout.auditFile, 'utf8').trim().split('\n');
    const second = JSON.parse(lines[1] ?? '{}') as { payload: { decisionId: string } };
    second.payload.decisionId = 'dec_TAMPERED';
    lines[1] = JSON.stringify(second);
    writeFileSync(layout.auditFile, `${lines.join('\n')}\n`);

    const result = run(['--state-dir', layout.root, '--out', join(layout.root, 'out')]);
    expect(result.status).toBe(1);
    expect(result.output).toContain('VERIFY_FAILED at seq 1');
    expect(result.output).toContain('hash mismatch');
  });

  it('fails closed when an entry is removed', async () => {
    const layout = await writeChain(3);
    const lines = readFileSync(layout.auditFile, 'utf8').trim().split('\n');
    writeFileSync(layout.auditFile, `${[lines[0], lines[2]].join('\n')}\n`);

    const result = run(['--state-dir', layout.root, '--out', join(layout.root, 'out')]);
    expect(result.status).toBe(1);
    expect(result.output).toContain('VERIFY_FAILED');
    expect(result.output).toContain('seq discontinuity');
  });

  it('refuses an empty audit file instead of reporting success', async () => {
    const layout = await writeChain(1);
    writeFileSync(layout.auditFile, '');
    const result = run(['--state-dir', layout.root, '--out', join(layout.root, 'out')]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('no entries');
    expect(result.output).not.toContain('VERIFY_OK');
  });

  it('refuses to verify without a signing key', async () => {
    const layout = await writeChain(1);
    const result = run([
      '--state-dir',
      layout.root,
      '--key',
      'missing.pem',
      '--out',
      join(layout.root, 'out'),
    ]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('signing key does not exist');
    expect(result.output).not.toContain('VERIFY_OK');
  });

  it('verifies with the public key alone', async () => {
    const layout = await writeChain(2);
    const result = run([
      '--state-dir',
      layout.root,
      '--key',
      'data/rsk-public.pem',
      '--json-only',
      '--out',
      join(layout.root, 'out-public'),
    ]);

    expect(result.status).toBe(0);
    expect(result.output).toContain('VERIFY_OK — 2 entries');
  });
});

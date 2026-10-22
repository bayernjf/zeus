import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ed25519MemorySigner } from '../src/core/signing.js';
import {
  DecisionAuditCodecError,
  decodeAuditJsonl,
  decodeAuditLine,
  encodeAuditJsonl,
  encodeAuditLine,
} from '../src/core/audit/jsonl.js';
import { DecisionAuditChain } from '../src/core/audit/audit-chain.js';
import { JsonlDecisionAuditStore, DecisionAuditStoreError } from '../src/app/audit/jsonl-chain-store.js';
import type { DecisionAuditEntry } from '../src/core/audit/types.js';

const KEY_ID = 'audit-store-test';
const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zeus-decision-audit-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function sealEntries(count: number): Promise<{ signer: Ed25519MemorySigner; entries: DecisionAuditEntry[] }> {
  const signer = new Ed25519MemorySigner(KEY_ID);
  const chain = new DecisionAuditChain(signer, () => '2026-10-22T08:00:00.000Z');
  for (let i = 0; i < count; i += 1) {
    await chain.append({ kind: 'decision.created', decisionId: `dec-${i}`, data: { grade: 'D2', index: i } });
  }
  return { signer, entries: [...chain.list()] };
}

describe('decision audit JSONL codec', () => {
  it('round-trips entries through JSONL', async () => {
    const { entries } = await sealEntries(3);
    const text = encodeAuditJsonl(entries);
    expect(text.endsWith('\n')).toBe(true);
    const decoded = decodeAuditJsonl(text);
    expect(decoded).toEqual(entries);
  });

  it('encodes single lines without trailing newline', async () => {
    const { entries } = await sealEntries(1);
    expect(encodeAuditLine(entries[0] as DecisionAuditEntry)).not.toContain('\n');
  });

  it('rejects unparseable JSON with the line number', () => {
    expect(() => decodeAuditLine('{not json', 7)).toThrow(DecisionAuditCodecError);
    try {
      decodeAuditLine('{bad', 7);
    } catch (error) {
      expect((error as DecisionAuditCodecError).line).toBe(7);
    }
  });

  it('rejects structurally invalid records', () => {
    expect(() => decodeAuditLine(JSON.stringify({ seq: 0, payload: {} }))).toThrow(/seq|prevHash|keyId|hash|signature|payload/);
  });

  it('tolerates a single trailing newline but rejects an internal blank line', async () => {
    const { entries } = await sealEntries(2);
    expect(decodeAuditJsonl(`${encodeAuditLine(entries[0] as DecisionAuditEntry)}\n${encodeAuditLine(entries[1] as DecisionAuditEntry)}\n`)).toHaveLength(2);
    expect(() =>
      decodeAuditJsonl(`${encodeAuditLine(entries[0] as DecisionAuditEntry)}\n\n${encodeAuditLine(entries[1] as DecisionAuditEntry)}\n`),
    ).toThrow(/line 2/);
  });
});

describe('JsonlDecisionAuditStore (shell fs persistence)', () => {
  it('creates the trail 0600, appends, and resumes with verified history', async () => {
    const dir = makeDir();
    const path = join(dir, 'nested', 'decisions.jsonl');
    const { signer } = await sealEntries(0);
    const store = await JsonlDecisionAuditStore.open(path, signer, signer.verifier());
    await store.append({ kind: 'decision.created', decisionId: 'a', data: { grade: 'D2' } });
    await store.append({ kind: 'decision.approved', decisionId: 'a', actor: 'owner', data: { decision: 'approve' } });
    expect(store.length).toBe(2);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');

    // Reopen: the existing two entries are verified before the next append.
    const reopened = await JsonlDecisionAuditStore.open(path, signer, signer.verifier());
    expect(reopened.length).toBe(2);
    const third = await reopened.append({ kind: 'decision.completed', decisionId: 'a', data: { result: 'ok' } });
    expect(third.seq).toBe(2);
    expect(third.prevHash).toBe(reopened.list()[1]?.hash);

    const again = await JsonlDecisionAuditStore.open(path, signer, signer.verifier());
    expect(again.length).toBe(3);
    expect(again.list().map(e => e.seq)).toEqual([0, 1, 2]);
  });

  it('refuses to open a trail whose content was tampered on disk', async () => {
    const dir = makeDir();
    const path = join(dir, 'decisions.jsonl');
    const { signer, entries } = await sealEntries(2);
    const tampered = JSON.parse(JSON.stringify(entries[1])) as DecisionAuditEntry;
    tampered.payload.data = { grade: 'D3' };
    writeFileSync(
      path,
      `${encodeAuditLine(entries[0] as DecisionAuditEntry)}\n${encodeAuditLine(tampered)}\n`,
      { mode: 0o600 },
    );
    await expect(JsonlDecisionAuditStore.open(path, signer, signer.verifier())).rejects.toThrow(DecisionAuditStoreError);
    await expect(JsonlDecisionAuditStore.open(path, signer, signer.verifier())).rejects.toThrow(/seq 1/);
  });

  it('refuses to open a trail sealed by an unknown key', async () => {
    const dir = makeDir();
    const path = join(dir, 'decisions.jsonl');
    const { entries } = await sealEntries(1);
    const stranger = new Ed25519MemorySigner('other-key');
    writeFileSync(path, encodeAuditJsonl(entries), { mode: 0o600 });
    await expect(JsonlDecisionAuditStore.open(path, stranger, stranger.verifier())).rejects.toThrow(/signature/);
  });

  it('refuses to open a trail with a garbage line', async () => {
    const dir = makeDir();
    const path = join(dir, 'decisions.jsonl');
    writeFileSync(path, 'not-a-json-line\n', { mode: 0o600 });
    const signer = new Ed25519MemorySigner(KEY_ID);
    await expect(JsonlDecisionAuditStore.open(path, signer, signer.verifier())).rejects.toThrow(DecisionAuditCodecError);
  });

  it('tightens an existing world-readable trail on open', async () => {
    const dir = makeDir();
    const path = join(dir, 'decisions.jsonl');
    writeFileSync(path, '', { mode: 0o644 });
    chmodSync(path, 0o644);
    const signer = new Ed25519MemorySigner(KEY_ID);
    await JsonlDecisionAuditStore.open(path, signer, signer.verifier());
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
  });
});

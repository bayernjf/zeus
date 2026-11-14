import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  OperatorGrantError,
  OperatorGrantLedger,
  OPERATOR_GRANT_DEFAULT_TTL_MS,
  OPERATOR_GRANT_MAX_TTL_MS,
  issueOperatorWriteGrant,
  verifyOperatorWriteGrant,
} from '../src/dataDomain/grant.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { bootRuntime } from '../src/state/boot.js';
import { runtimeStats } from '../src/state/stats.js';
import type { OperatorGrantAuditEntry } from '../src/dataDomain/grant.js';
import type { MemoryEvent } from '../src/memory/types.js';

const NOW = new Date('2026-09-25T09:00:00.000Z');
const now = () => NOW;
const TOKEN = 'operator-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'zeus-operator-grants-'));
});

afterEach(async () => {
  // The snapshot persist is fire-and-forget (the write path must not block on
  // fsync), so its temp file can land while this teardown is unlinking the
  // sandbox. Retry the ENOTEMPTY instead of failing the test on that race.
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

async function dataDomainRoot(name: string, content = 'note\n'): Promise<string> {
  const root = join(sandbox, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'seed.md'), content);
  return root;
}

describe('E3.5 grant issuance (issueOperatorWriteGrant)', () => {
  const signer = new Ed25519MemorySigner('zeus-rsk-test');

  it('mints a nonce, binds the dataDomain, and time-boxes the credential', async () => {
    const grant = await issueOperatorWriteGrant({ dataDomainId: 'dataDomain-1', grantedBy: 'operator@bayjf' }, { signer, now });
    expect(grant).toMatchObject({
      kind: 'operator-write',
      dataDomainId: 'dataDomain-1',
      grantedBy: 'operator@bayjf',
      grantedAt: NOW.toISOString(),
      keyId: 'zeus-rsk-test',
    });
    // The nonce is the runtime's to mint: a caller that could choose it could
    // pre-authorize a batch of writes.
    expect(grant.nonce).toHaveLength(36);
    expect(Date.parse(grant.expiresAt)).toBe(NOW.getTime() + OPERATOR_GRANT_DEFAULT_TTL_MS);
    expect(grant.sig.length).toBeGreaterThan(40);
  });

  it('never issues the same nonce twice', async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const grant = await issueOperatorWriteGrant({ dataDomainId: 'dataDomain-1', grantedBy: 'operator' }, { signer, now });
      nonces.add(grant.nonce);
    }
    expect(nonces.size).toBe(25);
  });

  it('refuses the inputs that would make a grant mean nothing', async () => {
    await expect(issueOperatorWriteGrant({ dataDomainId: '', grantedBy: 'operator' }, { signer, now })).rejects.toBeInstanceOf(OperatorGrantError);
    await expect(issueOperatorWriteGrant({ dataDomainId: 'dataDomain-1', grantedBy: '  ' }, { signer, now })).rejects.toThrow(/grantedBy/);
    await expect(issueOperatorWriteGrant({ dataDomainId: 'dataDomain-1', grantedBy: 'operator', ttlMs: 0 }, { signer, now })).rejects.toThrow(/ttl/);
    await expect(
      issueOperatorWriteGrant({ dataDomainId: 'dataDomain-1', grantedBy: 'operator', ttlMs: OPERATOR_GRANT_MAX_TTL_MS + 1 }, { signer, now })
    ).rejects.toThrow(/ceiling/);
    await expect(issueOperatorWriteGrant({ dataDomainId: 'dataDomain-1', grantedBy: 'operator', ttlMs: Number.NaN }, { signer, now })).rejects.toThrow(/ttl/);
  });

  it('signs over every field, so editing a grant invalidates it', async () => {
    const grant = await issueOperatorWriteGrant({ dataDomainId: 'dataDomain-1', grantedBy: 'operator' }, { signer, now });
    const verifier = signer.verifier();
    expect(await verifyOperatorWriteGrant(grant, 'dataDomain-1', { now, verifier })).toEqual({ ok: true });
    for (const edited of [
      { ...grant, dataDomainId: 'dataDomain-2' },
      { ...grant, grantedBy: 'someone-else' },
      { ...grant, expiresAt: new Date(NOW.getTime() + 10 * 3600_000).toISOString() },
      { ...grant, nonce: 'swapped' },
    ]) {
      const target = edited.dataDomainId;
      expect(await verifyOperatorWriteGrant(edited, target, { now, verifier })).toEqual({ ok: false, reason: 'bad-signature' });
    }
  });
});

describe('E3.5 nonce ledger (OperatorGrantLedger)', () => {
  it('accepts a nonce once, then refuses it', () => {
    const ledger = new OperatorGrantLedger();
    expect(ledger.consume('a')).toBe(true);
    expect(ledger.consume('a')).toBe(false);
    expect(ledger.isSpent('a')).toBe(true);
    expect(ledger.size).toBe(1);
  });

  it('fires onChange once per newly consumed nonce', () => {
    let saves = 0;
    const ledger = new OperatorGrantLedger({ onChange: () => { saves += 1; } });
    ledger.consume('a');
    ledger.consume('a');
    ledger.consume('b');
    expect(saves).toBe(2);
  });

  it('fires onChange even when the accepted nonce evicts an old one', () => {
    let saves = 0;
    const ledger = new OperatorGrantLedger({ limit: 2, onChange: () => { saves += 1; } });
    ledger.consume('a');
    ledger.consume('b');
    ledger.consume('c'); // window full: accepting 'c' evicts 'a'
    // Every accepted nonce must reach disk; gating the save on "no eviction"
    // left 'c' off disk exactly when the window was full.
    expect(saves).toBe(3);
    expect(ledger.exportState()).toEqual(['b', 'c']);
  });

  it('keeps a bounded window and says which nonce it dropped', () => {
    const evicted: string[] = [];
    const ledger = new OperatorGrantLedger({ limit: 2, onEvict: nonce => evicted.push(nonce) });
    ledger.consume('a');
    ledger.consume('b');
    ledger.consume('c');
    expect(evicted).toEqual(['a']);
    expect(ledger.isSpent('a')).toBe(false);
    expect(ledger.isSpent('b')).toBe(true);
    expect(ledger.exportState()).toEqual(['b', 'c']);
  });

  it('survives a round trip through the state file', () => {
    const ledger = new OperatorGrantLedger();
    ledger.consume('a');
    ledger.consume('b');
    const restored = new OperatorGrantLedger();
    restored.importState([...ledger.exportState(), 'b', '', '  ']);
    expect(restored.consume('a')).toBe(false);
    expect(restored.consume('b')).toBe(false);
    expect(restored.consume('c')).toBe(true);
    expect(restored.size).toBe(3);
  });
});

describe('E3.5 the booted runtime authorizes enterprise writes with signatures', () => {
  // The interface makes write optional; the booted runtime always assembles an
  // FsDataDomainStore, and this says so loudly instead of papering over it with a cast.
  function writerFor(runtime: Awaited<ReturnType<typeof bootRuntime>>) {
    const store = runtime.dataDomainStore;
    if (!store || typeof store.write !== 'function') throw new Error('booted runtime has no writable dataDomain store');
    return store.write.bind(store) as NonNullable<typeof store.write>;
  }

  async function boot(stateFile: string, root: string, signer?: Ed25519MemorySigner) {
    return bootRuntime({
      stateFile,
      now,
      dataDomainRoots: [{ root, type: 'enterprise' }],
      ...(signer ? { operatorSigner: signer } : {}),
    });
  }

  it('reports signed authority and refuses a hand-authored grant', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-test');
    const root = await dataDomainRoot('ent');
    const runtime = await boot(join(sandbox, 'runtime.json'), root, signer);
    expect(runtime.operatorGrantAuthority).toBe('signed');
    expect(runtimeStats(runtime).operatorGrants).toEqual({ authority: 'signed', keyId: 'zeus-rsk-test' });
    const dataDomainId = runtime.dataDomainStore!.connections()[0]!.dataDomainId;

    // This blob used to be an authorization. It is now a claim about one.
    await expect(
      writerFor(runtime)(dataDomainId, { itemId: 'notes/x.md', data: 'sneaked\n' }, {
        kind: 'operator-write',
        dataDomainId,
        grantedBy: 'attacker',
        grantedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        nonce: 'made-up',
      })
    ).rejects.toThrow(/unsigned/);

    const grant = await issueOperatorWriteGrant({ dataDomainId, grantedBy: 'operator@bayjf', reason: 'file the report' }, { signer, now });
    await writerFor(runtime)(dataDomainId, { itemId: 'notes/x.md', data: 'authorized\n' }, grant);
    expect(await runtime.dataDomainStore!.read(dataDomainId, 'notes/x.md')).toMatchObject({ content: 'authorized\n' });
  });

  it('persists a consumed nonce the moment it is consumed, and refuses the replay after a restart', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-test');
    const root = await dataDomainRoot('ent2');
    const stateFile = join(sandbox, 'runtime2.json');
    const runtime = await boot(stateFile, root, signer);
    const dataDomainId = runtime.dataDomainStore!.connections()[0]!.dataDomainId;
    const grant = await issueOperatorWriteGrant({ dataDomainId, grantedBy: 'operator@bayjf' }, { signer, now });

    await writerFor(runtime)(dataDomainId, { itemId: 'notes/y.md', data: 'once\n' }, grant);
    // No saveState() call: consumption itself must push the nonce to disk. The
    // persist is fire-and-forget — the write path must not block on fsync — so wait
    // for the file to catch up instead of assuming one event-loop tick is enough.
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as { writeGrantNonces?: string[] };
      expect(persisted.writeGrantNonces).toContain(grant.nonce);
    });

    const restarted = await boot(stateFile, root, signer);
    await expect(writerFor(restarted)(dataDomainId, { itemId: 'notes/y.md', data: 'twice\n' }, grant))
      .rejects.toThrow(/replayed/);
    expect(runtimeStats(restarted).counts.spentWriteGrantNonces).toBe(1);
  });

  it('reports shape-only authority when no operator key is configured', async () => {
    const root = await dataDomainRoot('ent3');
    const runtime = await boot(join(sandbox, 'runtime3.json'), root);
    expect(runtime.operatorGrantAuthority).toBe('shape-only');
    expect(runtimeStats(runtime).operatorGrants).toEqual({ authority: 'shape-only', keyId: null });
    // Single-use still applies: the ledger is not conditional on having a key.
    const dataDomainId = runtime.dataDomainStore!.connections()[0]!.dataDomainId;
    const grant = {
      kind: 'operator-write' as const,
      dataDomainId,
      grantedBy: 'operator',
      grantedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: 'one-shot',
    };
    await writerFor(runtime)(dataDomainId, { itemId: 'notes/z.md', data: 'a\n' }, grant);
    await expect(writerFor(runtime)(dataDomainId, { itemId: 'notes/z.md', data: 'b\n' }, grant)).rejects.toThrow(/replayed/);
  });
});

describe('HTTP E3.5 — the write-grant face', () => {
  let app: FastifyInstance;
  let store: FsDataDomainStore;
  let signer: Ed25519MemorySigner;
  let ledger: OperatorGrantLedger;
  let issued: OperatorGrantAuditEntry[];
  let enterpriseDataDomainId: string;
  let personalDataDomainId: string;
  let readOnlyDataDomainId: string;

  beforeEach(async () => {
    signer = new Ed25519MemorySigner('zeus-rsk-test');
    ledger = new OperatorGrantLedger();
    store = new FsDataDomainStore({ now, operatorGrants: { verifier: signer.verifier(), acceptedKeyIds: [signer.keyId], ledger } });
    enterpriseDataDomainId = (await store.connect(await dataDomainRoot('http-ent'), 'enterprise', { tenant: 'acme/eng' })).dataDomainId;
    personalDataDomainId = (await store.connect(await dataDomainRoot('http-me'), 'personal')).dataDomainId;
    readOnlyDataDomainId = (await store.connect(await dataDomainRoot('http-ro'), 'enterprise', { readOnly: true })).dataDomainId;
    issued = [];

    const memoryStore = new MemoryStore(undefined, now);
    const event = (index: number): MemoryEvent => ({
      eventId: `evt-${index}`,
      dataDomainId: enterpriseDataDomainId,
      runId: `run-${index}`,
      source: { agentId: 'agent-1' },
      kind: 'observation',
      content: `finding ${index}`,
      refs: [],
      confidence: 0.6,
      occurredAt: '2026-09-25T08:00:00.000Z',
    });
    memoryStore.append(event(1));

    app = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer,
      internalToken: TOKEN,
      now,
      memoryStore,
      dataDomainStore: store,
      operatorGrantLedger: ledger,
      operatorGrantAuthority: 'signed',
      operatorGrantAudit: entry => issued.push(entry),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/dataDomain/write-grants', headers: AUTH, payload });

  it('issues a signed, time-boxed, dataDomain-bound grant and audits it', async () => {
    const res = await post({ dataDomainId: enterpriseDataDomainId, grantedBy: 'operator@bayjf', reason: 'file the diary' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { grant: Record<string, unknown>; authority: string; spentNonces: number };
    expect(body.authority).toBe('signed');
    expect(body.spentNonces).toBe(0);
    expect(body.grant).toMatchObject({ kind: 'operator-write', dataDomainId: enterpriseDataDomainId, grantedBy: 'operator@bayjf', keyId: signer.keyId });
    expect(typeof body.grant.sig).toBe('string');
    expect(Date.parse(String(body.grant.expiresAt))).toBe(NOW.getTime() + OPERATOR_GRANT_DEFAULT_TTL_MS);
    // The root path never leaves the process, grant or no grant.
    expect(res.body).not.toContain(sandbox);

    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ decision: 'operator-grant-issued', dataDomainId: enterpriseDataDomainId, grantedBy: 'operator@bayjf', keyId: signer.keyId });
  });

  it('refuses the requests that cannot produce a meaningful grant', async () => {
    expect((await post({ dataDomainId: personalDataDomainId, grantedBy: 'operator' })).statusCode).toBe(400);
    expect((await post({ dataDomainId: 'dataDomain-nope', grantedBy: 'operator' })).statusCode).toBe(404);
    expect((await post({ dataDomainId: enterpriseDataDomainId })).statusCode).toBe(400);
    expect((await post({ dataDomainId: enterpriseDataDomainId, grantedBy: 'operator', ttlSeconds: -5 })).statusCode).toBe(400);
    expect((await post({ dataDomainId: enterpriseDataDomainId, grantedBy: 'operator', ttlSeconds: 999_999 })).statusCode).toBe(400);
    expect((await post({ dataDomainId: readOnlyDataDomainId, grantedBy: 'operator' })).statusCode).toBe(409);
    const noHeader = await app.inject({ method: 'POST', url: '/api/dataDomain/write-grants', payload: { dataDomainId: enterpriseDataDomainId, grantedBy: 'operator' } });
    expect(noHeader.statusCode).toBe(401);
    expect(issued).toEqual([]);
  });

  it('the issued grant is what lets a diary write into the enterprise dataDomain land', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/api/diary/generate',
      headers: AUTH,
      payload: { dataDomainId: enterpriseDataDomainId },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'forbidden' });
    expect(refused.json().detail).toMatch(/unsigned|missing/);

    const minted = await post({ dataDomainId: enterpriseDataDomainId, grantedBy: 'operator@bayjf', ttlSeconds: 120 });
    const grant = (minted.json() as { grant: Record<string, unknown> }).grant;

    const generated = await app.inject({
      method: 'POST',
      url: '/api/diary/generate',
      headers: AUTH,
      payload: { dataDomainId: enterpriseDataDomainId, grant },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    const itemId = (generated.json() as { generated: Array<{ itemId: string }> }).generated[0]!.itemId;
    expect(await store.read(enterpriseDataDomainId, itemId)).toMatchObject({ content: expect.stringContaining('finding 1') });

    // The same credential cannot buy a second write.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/diary/generate',
      headers: AUTH,
      payload: { dataDomainId: enterpriseDataDomainId, grant },
    });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().detail).toMatch(/replayed/);
  });
});

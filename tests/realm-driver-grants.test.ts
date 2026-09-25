import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  DriverGrantError,
  DriverGrantLedger,
  DRIVER_GRANT_DEFAULT_TTL_MS,
  DRIVER_GRANT_MAX_TTL_MS,
  issueDriverWriteGrant,
  verifyDriverWriteGrant,
} from '../src/realm/grant.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { FsRealmStore } from '../src/realm/store.js';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { bootKernel } from '../src/state/boot.js';
import { kernelStats } from '../src/state/stats.js';
import type { DriverGrantAuditEntry } from '../src/realm/grant.js';
import type { MemoryEvent } from '../src/memory/types.js';

const NOW = new Date('2026-09-25T09:00:00.000Z');
const now = () => NOW;
const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'zeus-driver-grants-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function realmRoot(name: string, content = 'note\n'): Promise<string> {
  const root = join(sandbox, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'seed.md'), content);
  return root;
}

describe('E3.5 grant issuance (issueDriverWriteGrant)', () => {
  const signer = new Ed25519MemorySigner('zeus-rsk-test');

  it('mints a nonce, binds the realm, and time-boxes the credential', async () => {
    const grant = await issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver@bayjf' }, { signer, now });
    expect(grant).toMatchObject({
      kind: 'driver-write',
      realmId: 'realm-1',
      grantedBy: 'driver@bayjf',
      grantedAt: NOW.toISOString(),
      keyId: 'zeus-rsk-test',
    });
    // The nonce is the kernel's to mint: a caller that could choose it could
    // pre-authorize a batch of writes.
    expect(grant.nonce).toHaveLength(36);
    expect(Date.parse(grant.expiresAt)).toBe(NOW.getTime() + DRIVER_GRANT_DEFAULT_TTL_MS);
    expect(grant.sig.length).toBeGreaterThan(40);
  });

  it('never issues the same nonce twice', async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const grant = await issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver' }, { signer, now });
      nonces.add(grant.nonce);
    }
    expect(nonces.size).toBe(25);
  });

  it('refuses the inputs that would make a grant mean nothing', async () => {
    await expect(issueDriverWriteGrant({ realmId: '', grantedBy: 'driver' }, { signer, now })).rejects.toBeInstanceOf(DriverGrantError);
    await expect(issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: '  ' }, { signer, now })).rejects.toThrow(/grantedBy/);
    await expect(issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver', ttlMs: 0 }, { signer, now })).rejects.toThrow(/ttl/);
    await expect(
      issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver', ttlMs: DRIVER_GRANT_MAX_TTL_MS + 1 }, { signer, now })
    ).rejects.toThrow(/ceiling/);
    await expect(issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver', ttlMs: Number.NaN }, { signer, now })).rejects.toThrow(/ttl/);
  });

  it('signs over every field, so editing a grant invalidates it', async () => {
    const grant = await issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver' }, { signer, now });
    const verifier = signer.verifier();
    expect(await verifyDriverWriteGrant(grant, 'realm-1', { now, verifier })).toEqual({ ok: true });
    for (const edited of [
      { ...grant, realmId: 'realm-2' },
      { ...grant, grantedBy: 'someone-else' },
      { ...grant, expiresAt: new Date(NOW.getTime() + 10 * 3600_000).toISOString() },
      { ...grant, nonce: 'swapped' },
    ]) {
      const target = edited.realmId;
      expect(await verifyDriverWriteGrant(edited, target, { now, verifier })).toEqual({ ok: false, reason: 'bad-signature' });
    }
  });
});

describe('E3.5 nonce ledger (DriverGrantLedger)', () => {
  it('accepts a nonce once, then refuses it', () => {
    const ledger = new DriverGrantLedger();
    expect(ledger.consume('a')).toBe(true);
    expect(ledger.consume('a')).toBe(false);
    expect(ledger.isSpent('a')).toBe(true);
    expect(ledger.size).toBe(1);
  });

  it('fires onChange once per newly consumed nonce', () => {
    let saves = 0;
    const ledger = new DriverGrantLedger({ onChange: () => { saves += 1; } });
    ledger.consume('a');
    ledger.consume('a');
    ledger.consume('b');
    expect(saves).toBe(2);
  });

  it('keeps a bounded window and says which nonce it dropped', () => {
    const evicted: string[] = [];
    const ledger = new DriverGrantLedger({ limit: 2, onEvict: nonce => evicted.push(nonce) });
    ledger.consume('a');
    ledger.consume('b');
    ledger.consume('c');
    expect(evicted).toEqual(['a']);
    expect(ledger.isSpent('a')).toBe(false);
    expect(ledger.isSpent('b')).toBe(true);
    expect(ledger.exportState()).toEqual(['b', 'c']);
  });

  it('survives a round trip through the state file', () => {
    const ledger = new DriverGrantLedger();
    ledger.consume('a');
    ledger.consume('b');
    const restored = new DriverGrantLedger();
    restored.importState([...ledger.exportState(), 'b', '', '  ']);
    expect(restored.consume('a')).toBe(false);
    expect(restored.consume('b')).toBe(false);
    expect(restored.consume('c')).toBe(true);
    expect(restored.size).toBe(3);
  });
});

describe('E3.5 the booted kernel authorizes enterprise writes with signatures', () => {
  // The interface makes write optional; the booted kernel always assembles an
  // FsRealmStore, and this says so loudly instead of papering over it with a cast.
  function writerFor(kernel: Awaited<ReturnType<typeof bootKernel>>) {
    const store = kernel.realmStore;
    if (!store || typeof store.write !== 'function') throw new Error('booted kernel has no writable realm store');
    return store.write.bind(store) as NonNullable<typeof store.write>;
  }

  async function boot(stateFile: string, root: string, signer?: Ed25519MemorySigner) {
    return bootKernel({
      stateFile,
      now,
      realmRoots: [{ root, type: 'enterprise' }],
      ...(signer ? { driverSigner: signer } : {}),
    });
  }

  it('reports signed authority and refuses a hand-authored grant', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-test');
    const root = await realmRoot('ent');
    const kernel = await boot(join(sandbox, 'kernel.json'), root, signer);
    expect(kernel.driverGrantAuthority).toBe('signed');
    expect(kernelStats(kernel).driverGrants).toEqual({ authority: 'signed', keyId: 'zeus-rsk-test' });
    const realmId = kernel.realmStore!.connections()[0].realmId;

    // This blob used to be an authorization. It is now a claim about one.
    await expect(
      writerFor(kernel)(realmId, { itemId: 'notes/x.md', data: 'sneaked\n' }, {
        kind: 'driver-write',
        realmId,
        grantedBy: 'attacker',
        grantedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        nonce: 'made-up',
      })
    ).rejects.toThrow(/unsigned/);

    const grant = await issueDriverWriteGrant({ realmId, grantedBy: 'driver@bayjf', reason: 'file the report' }, { signer, now });
    await writerFor(kernel)(realmId, { itemId: 'notes/x.md', data: 'authorized\n' }, grant);
    expect(await kernel.realmStore!.read(realmId, 'notes/x.md')).toMatchObject({ content: 'authorized\n' });
  });

  it('persists a consumed nonce the moment it is consumed, and refuses the replay after a restart', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-test');
    const root = await realmRoot('ent2');
    const stateFile = join(sandbox, 'kernel2.json');
    const kernel = await boot(stateFile, root, signer);
    const realmId = kernel.realmStore!.connections()[0].realmId;
    const grant = await issueDriverWriteGrant({ realmId, grantedBy: 'driver@bayjf' }, { signer, now });

    await writerFor(kernel)(realmId, { itemId: 'notes/y.md', data: 'once\n' }, grant);
    // No saveState() call: consumption itself must push the nonce to disk.
    await new Promise(resolve => setImmediate(resolve));
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as { writeGrantNonces?: string[] };
    expect(persisted.writeGrantNonces).toContain(grant.nonce);

    const restarted = await boot(stateFile, root, signer);
    await expect(writerFor(restarted)(realmId, { itemId: 'notes/y.md', data: 'twice\n' }, grant))
      .rejects.toThrow(/replayed/);
    expect(kernelStats(restarted).counts.spentWriteGrantNonces).toBe(1);
  });

  it('reports shape-only authority when no driver key is configured', async () => {
    const root = await realmRoot('ent3');
    const kernel = await boot(join(sandbox, 'kernel3.json'), root);
    expect(kernel.driverGrantAuthority).toBe('shape-only');
    expect(kernelStats(kernel).driverGrants).toEqual({ authority: 'shape-only', keyId: null });
    // Single-use still applies: the ledger is not conditional on having a key.
    const realmId = kernel.realmStore!.connections()[0].realmId;
    const grant = {
      kind: 'driver-write' as const,
      realmId,
      grantedBy: 'driver',
      grantedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      nonce: 'one-shot',
    };
    await writerFor(kernel)(realmId, { itemId: 'notes/z.md', data: 'a\n' }, grant);
    await expect(writerFor(kernel)(realmId, { itemId: 'notes/z.md', data: 'b\n' }, grant)).rejects.toThrow(/replayed/);
  });
});

describe('HTTP E3.5 — the write-grant face', () => {
  let app: FastifyInstance;
  let store: FsRealmStore;
  let signer: Ed25519MemorySigner;
  let ledger: DriverGrantLedger;
  let issued: DriverGrantAuditEntry[];
  let enterpriseRealmId: string;
  let personalRealmId: string;
  let readOnlyRealmId: string;

  beforeEach(async () => {
    signer = new Ed25519MemorySigner('zeus-rsk-test');
    ledger = new DriverGrantLedger();
    store = new FsRealmStore({ now, driverGrants: { verifier: signer.verifier(), acceptedKeyIds: [signer.keyId], ledger } });
    enterpriseRealmId = (await store.connect(await realmRoot('http-ent'), 'enterprise', { tenant: 'acme/eng' })).realmId;
    personalRealmId = (await store.connect(await realmRoot('http-me'), 'personal')).realmId;
    readOnlyRealmId = (await store.connect(await realmRoot('http-ro'), 'enterprise', { readOnly: true })).realmId;
    issued = [];

    const memoryStore = new MemoryStore(undefined, now);
    const event = (index: number): MemoryEvent => ({
      eventId: `evt-${index}`,
      realmId: enterpriseRealmId,
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
      registry: new VassalRegistry(),
      signer,
      internalToken: TOKEN,
      now,
      memoryStore,
      realmStore: store,
      driverGrantLedger: ledger,
      driverGrantAuthority: 'signed',
      driverGrantAudit: entry => issued.push(entry),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/realm/write-grants', headers: AUTH, payload });

  it('issues a signed, time-boxed, realm-bound grant and audits it', async () => {
    const res = await post({ realmId: enterpriseRealmId, grantedBy: 'driver@bayjf', reason: 'file the diary' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { grant: Record<string, unknown>; authority: string; spentNonces: number };
    expect(body.authority).toBe('signed');
    expect(body.spentNonces).toBe(0);
    expect(body.grant).toMatchObject({ kind: 'driver-write', realmId: enterpriseRealmId, grantedBy: 'driver@bayjf', keyId: signer.keyId });
    expect(typeof body.grant.sig).toBe('string');
    expect(Date.parse(String(body.grant.expiresAt))).toBe(NOW.getTime() + DRIVER_GRANT_DEFAULT_TTL_MS);
    // The root path never leaves the process, grant or no grant.
    expect(res.body).not.toContain(sandbox);

    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ decision: 'driver-grant-issued', realmId: enterpriseRealmId, grantedBy: 'driver@bayjf', keyId: signer.keyId });
  });

  it('refuses the requests that cannot produce a meaningful grant', async () => {
    expect((await post({ realmId: personalRealmId, grantedBy: 'driver' })).statusCode).toBe(400);
    expect((await post({ realmId: 'realm-nope', grantedBy: 'driver' })).statusCode).toBe(404);
    expect((await post({ realmId: enterpriseRealmId })).statusCode).toBe(400);
    expect((await post({ realmId: enterpriseRealmId, grantedBy: 'driver', ttlSeconds: -5 })).statusCode).toBe(400);
    expect((await post({ realmId: enterpriseRealmId, grantedBy: 'driver', ttlSeconds: 999_999 })).statusCode).toBe(400);
    expect((await post({ realmId: readOnlyRealmId, grantedBy: 'driver' })).statusCode).toBe(409);
    const noHeader = await app.inject({ method: 'POST', url: '/api/realm/write-grants', payload: { realmId: enterpriseRealmId, grantedBy: 'driver' } });
    expect(noHeader.statusCode).toBe(401);
    expect(issued).toEqual([]);
  });

  it('the issued grant is what lets a diary write into the enterprise realm land', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/api/diary/generate',
      headers: AUTH,
      payload: { realmId: enterpriseRealmId },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'forbidden' });
    expect(refused.json().detail).toMatch(/unsigned|missing/);

    const minted = await post({ realmId: enterpriseRealmId, grantedBy: 'driver@bayjf', ttlSeconds: 120 });
    const grant = (minted.json() as { grant: Record<string, unknown> }).grant;

    const generated = await app.inject({
      method: 'POST',
      url: '/api/diary/generate',
      headers: AUTH,
      payload: { realmId: enterpriseRealmId, grant },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    const itemId = (generated.json() as { generated: Array<{ itemId: string }> }).generated[0].itemId;
    expect(await store.read(enterpriseRealmId, itemId)).toMatchObject({ content: expect.stringContaining('finding 1') });

    // The same credential cannot buy a second write.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/diary/generate',
      headers: AUTH,
      payload: { realmId: enterpriseRealmId, grant },
    });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().detail).toMatch(/replayed/);
  });
});

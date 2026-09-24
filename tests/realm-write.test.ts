import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import { verifyDriverWriteGrant } from '../src/realm/grant.js';
import {
  InvalidItemIdError,
  RealmNotConnectedError,
  UnauthorizedRealmWriteError,
  UnsupportedWriteError,
} from '../src/realm/types.js';
import type { DriverWriteGrant, RealmWriteAuditEntry } from '../src/index.js';

describe('E3.5 FsRealmStore.write (personal realm)', () => {
  let sandbox: string;
  let root: string;
  let symlinksSupported = true;

  beforeEach(() => {
    symlinksSupported = true;
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-realm-write-'));
    root = join(sandbox, 'realm');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'existing.md'), 'original\n');
    writeFileSync(join(sandbox, 'outside.md'), 'outside\n');
    try {
      symlinkSync('../outside.md', join(root, 'notes', 'link.md'));
    } catch {
      symlinksSupported = false;
    }
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function connected(store: FsRealmStore, opts: { readOnly?: boolean } = {}) {
    const manifest = await store.connect(root, 'personal', opts);
    return manifest;
  }

  it('writes a string to a minted itemId under writes/ and reads it back verbatim', async () => {
    const store = new FsRealmStore();
    const manifest = await connected(store);
    const { itemId } = await store.write(manifest.realmId, { data: 'hello write\n' });
    expect(itemId).toMatch(/^writes\/.*\.md$/);
    const back = await store.read(manifest.realmId, itemId);
    expect(back.content).toBe('hello write\n');
  });

  it('writes to an explicit itemId and overwrites it on a second write', async () => {
    const store = new FsRealmStore();
    const manifest = await connected(store);
    const r1 = await store.write(manifest.realmId, { itemId: 'notes/new.md', data: 'v1\n' });
    expect(r1.itemId).toBe('notes/new.md');
    await store.write(manifest.realmId, { itemId: 'notes/new.md', data: 'v2\n' });
    const back = await store.read(manifest.realmId, 'notes/new.md');
    expect(back.content).toBe('v2\n');
  });

  it('serializes an object payload as pretty JSON and round-trips it', async () => {
    const store = new FsRealmStore();
    const manifest = await connected(store);
    const { itemId } = await store.write(manifest.realmId, { data: { ok: true, n: 3 } });
    expect(itemId.endsWith('.json')).toBe(true);
    const back = await store.read(manifest.realmId, itemId);
    expect(JSON.parse(back.content)).toEqual({ ok: true, n: 3 });
  });

  it('refuses writes when the realm was connected read-only', async () => {
    const store = new FsRealmStore();
    const manifest = await connected(store, { readOnly: true });
    await expect(store.write(manifest.realmId, { itemId: 'x.md', data: 'd' })).rejects.toBeInstanceOf(
      UnauthorizedRealmWriteError,
    );
  });

  it.each(['../escape.md', '/abs/x.md', 'a/../b.md', 'a//b.md', 'a\\b.md'])(
    'rejects path-traversal / unsafe itemId %j',
    async (itemId) => {
      const store = new FsRealmStore();
      const manifest = await connected(store);
      await expect(store.write(manifest.realmId, { itemId, data: 'd' })).rejects.toBeInstanceOf(InvalidItemIdError);
    },
  );

  it('rejects non-text extension and oversized payloads', async () => {
    const store = new FsRealmStore();
    const manifest = await connected(store);
    await expect(store.write(manifest.realmId, { itemId: 'bin.dat', data: 'd' })).rejects.toBeInstanceOf(
      UnsupportedWriteError,
    );
    const big = 'a'.repeat(1024 * 1024 + 1);
    await expect(store.write(manifest.realmId, { itemId: 'big.md', data: big })).rejects.toBeInstanceOf(
      UnsupportedWriteError,
    );
  });

  it('rejects non-serializable payload kinds and tag persistence requests', async () => {
    const store = new FsRealmStore();
    const manifest = await connected(store);
    await expect(store.write(manifest.realmId, { itemId: 'f.md', data: undefined })).rejects.toBeInstanceOf(
      UnsupportedWriteError,
    );
    await expect(
      store.write(manifest.realmId, { itemId: 't.md', data: 'd', tags: ['x'] }),
    ).rejects.toBeInstanceOf(UnsupportedWriteError);
  });

  it('refuses to write through a symlink that escapes the root', async () => {
    if (!symlinksSupported) return;
    const store = new FsRealmStore();
    const manifest = await connected(store);
    await expect(
      store.write(manifest.realmId, { itemId: 'notes/link.md', data: 'pwn\n' }),
    ).rejects.toBeInstanceOf(InvalidItemIdError);
    expect(readdirSync(join(root, '..')).includes('outside.md')).toBe(true);
  });

  it('refreshes manifest digest/itemCount, search and entries after write', async () => {
    const store = new FsRealmStore();
    const before = await connected(store);
    const beforeDigest = before.contentDigest;
    const beforeCount = before.itemCount;
    await store.write(before.realmId, { itemId: 'notes/fresh.md', data: 'uniquemarker zeus\n' });

    const after = await store.manifest(before.realmId);
    expect(after.itemCount).toBe(beforeCount + 1);
    expect(after.contentDigest).not.toBe(beforeDigest);

    const hits = await store.search(before.realmId, { text: 'uniquemarker' });
    expect(hits.some(h => h.itemId === 'notes/fresh.md')).toBe(true);
    const entries = await store.entries(before.realmId);
    expect(entries.some(e => e.itemId === 'notes/fresh.md')).toBe(true);
  });

  it('emits one audit entry per accepted write (none on rejection)', async () => {
    const audit: RealmWriteAuditEntry[] = [];
    const store = new FsRealmStore({ audit: e => audit.push(e) });
    const manifest = await connected(store);
    await store.write(manifest.realmId, { itemId: 'notes/a.md', data: 'x' });
    await expect(
      store.write(manifest.realmId, { itemId: 'bin.dat', data: 'x' }),
    ).rejects.toBeInstanceOf(UnsupportedWriteError);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ realmId: manifest.realmId, itemId: 'notes/a.md' });
    expect(audit[0].bytes).toBeGreaterThan(0);
  });

  it('leaves no temp files behind after an atomic write', async () => {
    const store = new FsRealmStore();
    const manifest = await connected(store);
    await store.write(manifest.realmId, { itemId: 'notes/atomic.md', data: 'ok\n' });
    const notes = readdirSync(join(root, 'notes'));
    expect(notes.some(n => n.includes('.zeus-tmp-'))).toBe(false);
    expect(existsSync(join(root, 'notes', 'atomic.md'))).toBe(true);
  });

  it('requires connect before write', async () => {
    const store = new FsRealmStore();
    await expect(store.write('realm-unknown', { itemId: 'x.md', data: 'd' })).rejects.toBeInstanceOf(
      RealmNotConnectedError,
    );
  });
});


describe('E3.5 driver write grant gate (verifyDriverWriteGrant)', () => {
  const base = (over: Partial<DriverWriteGrant> = {}): DriverWriteGrant => ({
    kind: 'driver-write',
    realmId: 'realm-1',
    grantedBy: 'driver-alice',
    grantedAt: '2026-09-24T00:00:00.000Z',
    nonce: 'nonce-1',
    ...over,
  });
  const fixedNow = () => new Date('2026-09-24T12:00:00.000Z');

  it('rejects a missing grant', () => {
    expect(verifyDriverWriteGrant(undefined, 'realm-1', fixedNow)).toEqual({ ok: false, reason: 'missing' });
  });

  it('accepts a well-formed grant bound to the realm', () => {
    expect(verifyDriverWriteGrant(base(), 'realm-1', fixedNow)).toEqual({ ok: true });
  });

  it('rejects malformed grants (wrong kind, empty identity, bad dates, empty nonce)', () => {
    expect(verifyDriverWriteGrant(base({ kind: 'other' as DriverWriteGrant['kind'] }), 'realm-1', fixedNow)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyDriverWriteGrant(base({ grantedBy: '' }), 'realm-1', fixedNow)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyDriverWriteGrant(base({ grantedAt: 'not-a-date' }), 'realm-1', fixedNow)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyDriverWriteGrant(base({ nonce: '' }), 'realm-1', fixedNow)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a grant minted for another realm', () => {
    expect(verifyDriverWriteGrant(base({ realmId: 'realm-other' }), 'realm-1', fixedNow)).toEqual({
      ok: false,
      reason: 'wrong-realm',
    });
  });

  it('rejects an expired grant but accepts one still inside its window', () => {
    const expired = base({ expiresAt: '2026-09-24T09:00:00.000Z' });
    expect(verifyDriverWriteGrant(expired, 'realm-1', fixedNow)).toEqual({ ok: false, reason: 'expired' });
    const fresh = base({ expiresAt: '2026-09-24T18:00:00.000Z' });
    expect(verifyDriverWriteGrant(fresh, 'realm-1', fixedNow)).toEqual({ ok: true });
  });
});

describe('E3.5 enterprise realm writes through a real store', () => {
  let sandbox: string;
  let root: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-realm-ent-'));
    root = join(sandbox, 'realm');
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function grant(realmId: string, overrides: Partial<DriverWriteGrant> = {}): DriverWriteGrant {
    return {
      kind: 'driver-write',
      realmId,
      grantedBy: 'driver@bayjf',
      grantedAt: '2026-09-24T10:00:00.000Z',
      // The store verifies against the wall clock, so a "still valid" fixture
      // grant has to stay in the future whenever the suite runs.
      expiresAt: '2099-01-01T00:00:00.000Z',
      nonce: 'nonce-1',
      ...overrides,
    };
  }

  it('refuses an enterprise write with no grant at all', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'enterprise');
    await expect(store.write(manifest.realmId, { data: 'from the personal side\n' }))
      .rejects.toThrow(/enterprise write requires a valid driver grant \(missing\)/);
  });

  it('accepts a valid driver grant, writes, and records who authorized it', async () => {
    const written: RealmWriteAuditEntry[] = [];
    const store = new FsRealmStore({ audit: entry => written.push(entry) });
    const manifest = await store.connect(root, 'enterprise');
    const { itemId } = await store.write(manifest.realmId, { data: 'escalation brief\n' }, grant(manifest.realmId));

    expect(await store.read(manifest.realmId, itemId)).toMatchObject({ content: 'escalation brief\n' });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ realmId: manifest.realmId, itemId, grantedBy: 'driver@bayjf' });
    // the write is visible to the snapshot the Vault map and search read from
    expect((await store.manifest(manifest.realmId)).itemCount).toBe(1);
  });

  it('refuses a grant bound to another realm, an expired grant and a malformed one', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'enterprise');
    const other = { ...grant('realm-someone-else') };
    await expect(store.write(manifest.realmId, { data: 'x\n' }, other))
      .rejects.toThrow(/wrong-realm/);
    await expect(store.write(manifest.realmId, { data: 'x\n' }, grant(manifest.realmId, { expiresAt: '2020-01-01T00:00:00.000Z' })))
      .rejects.toThrow(/expired/);
    const malformed = { ...grant(manifest.realmId), grantedBy: '' };
    await expect(store.write(manifest.realmId, { data: 'x\n' }, malformed))
      .rejects.toThrow(/malformed/);
  });

  it('a read-only enterprise connection stays read-only even with a grant', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'enterprise', { readOnly: true });
    await expect(store.write(manifest.realmId, { data: 'x\n' }, grant(manifest.realmId)))
      .rejects.toBeInstanceOf(UnauthorizedRealmWriteError);
  });

  it('personal realms still need no grant, so the two domains do not blur', async () => {
    const personalRoot = join(sandbox, 'personal');
    mkdirSync(personalRoot, { recursive: true });
    const store = new FsRealmStore();
    const personal = await store.connect(personalRoot, 'personal');
    await expect(store.write(personal.realmId, { data: 'fine\n' })).resolves.toMatchObject({ itemId: /^writes\// });
  });
});

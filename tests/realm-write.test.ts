import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import { verifyDriverWriteGrant, issueDriverWriteGrant, DriverGrantLedger, DriverGrantError } from '../src/realm/grant.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
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
    expiresAt: '2026-09-24T18:00:00.000Z',
    nonce: 'nonce-1',
    ...over,
  });
  const fixedNow = () => new Date('2026-09-24T12:00:00.000Z');

  it('rejects a missing grant', async () => {
    expect(await verifyDriverWriteGrant(undefined, 'realm-1', { now: fixedNow })).toEqual({ ok: false, reason: 'missing' });
  });

  it('accepts a well-formed grant bound to the realm', async () => {
    expect(await verifyDriverWriteGrant(base(), 'realm-1', { now: fixedNow })).toEqual({ ok: true });
  });

  it('rejects malformed grants (wrong kind, empty identity, bad dates, empty nonce)', async () => {
    expect(await verifyDriverWriteGrant(base({ kind: 'other' as DriverWriteGrant['kind'] }), 'realm-1', { now: fixedNow })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyDriverWriteGrant(base({ grantedBy: '' }), 'realm-1', { now: fixedNow })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyDriverWriteGrant(base({ grantedAt: 'not-a-date' }), 'realm-1', { now: fixedNow })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyDriverWriteGrant(base({ nonce: '' }), 'realm-1', { now: fixedNow })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a grant minted for another realm', async () => {
    expect(await verifyDriverWriteGrant(base({ realmId: 'realm-other' }), 'realm-1', { now: fixedNow })).toEqual({
      ok: false,
      reason: 'wrong-realm',
    });
  });

  it('rejects an expired grant but accepts one still inside its window', async () => {
    const expired = base({ expiresAt: '2026-09-24T09:00:00.000Z' });
    expect(await verifyDriverWriteGrant(expired, 'realm-1', { now: fixedNow })).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyDriverWriteGrant(base(), 'realm-1', { now: fixedNow })).toEqual({ ok: true });
  });

  it('refuses an open-ended grant even when nothing else is wrong', async () => {
    // A write credential with no expiry is a standing permission, and standing
    // permissions are E6.4's DomainGrant - a different, revocable object.
    const { expiresAt: _expiresAt, ...forever } = base();
    expect(await verifyDriverWriteGrant(forever, 'realm-1', { now: fixedNow })).toEqual({ ok: false, reason: 'no-expiry' });
  });

  it('checks expiry against the injected clock, not the wall clock', async () => {
    const grant = base({ expiresAt: '2026-09-24T13:00:00.000Z' });
    // Inside the window at the fixture's noon, expired by the real wall clock
    // (2026-09-25) - which is the difference between a testable gate and one that
    // can only be satisfied by a date in 2099.
    expect(await verifyDriverWriteGrant(grant, 'realm-1', { now: fixedNow })).toEqual({ ok: true });
    expect(await verifyDriverWriteGrant(grant, 'realm-1')).toEqual({ ok: false, reason: 'expired' });
  });

  describe('with a driver trust anchor', () => {
    const signer = new Ed25519MemorySigner('driver-key-1');
    const verifier = signer.verifier();

    it('accepts a grant the driver key signed', async () => {
      const grant = await issueDriverWriteGrant(
        { realmId: 'realm-1', grantedBy: 'driver-alice' },
        { signer, now: fixedNow }
      );
      expect(await verifyDriverWriteGrant(grant, 'realm-1', { now: fixedNow, verifier, acceptedKeyIds: ['driver-key-1'] })).toEqual({ ok: true });
    });

    it('rejects a hand-authored grant that merely has the right shape', async () => {
      const decision = await verifyDriverWriteGrant(base(), 'realm-1', { now: fixedNow, verifier });
      expect(decision).toEqual({ ok: false, reason: 'unsigned' });
    });

    it('rejects a grant signed by a key this kernel does not accept', async () => {
      const stranger = new Ed25519MemorySigner('rogue-key');
      const grant = await issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver-alice' }, { signer: stranger, now: fixedNow });
      expect(await verifyDriverWriteGrant(grant, 'realm-1', { now: fixedNow, verifier, acceptedKeyIds: ['driver-key-1'] })).toEqual({
        ok: false,
        reason: 'unknown-key',
      });
    });

    it('rejects a signed grant whose fields were edited afterwards', async () => {
      const grant = await issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver-alice' }, { signer, now: fixedNow });
      // The classic escalation: take a one-realm grant and point it at another.
      const edited = { ...grant, realmId: 'realm-2' };
      expect(await verifyDriverWriteGrant(edited, 'realm-2', { now: fixedNow, verifier })).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('consumes a nonce once and refuses the second attempt', async () => {
      const ledger = new DriverGrantLedger();
      const grant = await issueDriverWriteGrant({ realmId: 'realm-1', grantedBy: 'driver-alice' }, { signer, now: fixedNow });
      expect(await verifyDriverWriteGrant(grant, 'realm-1', { now: fixedNow, verifier, ledger })).toEqual({ ok: true });
      expect(await verifyDriverWriteGrant(grant, 'realm-1', { now: fixedNow, verifier, ledger })).toEqual({
        ok: false,
        reason: 'replayed',
      });
    });
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

  // The store now runs on an injected clock, so a "still valid" fixture grant is
  // expressed relative to THAT clock instead of a date in 2099.
  const clock = () => new Date('2026-09-24T10:00:00.000Z');

  function grant(realmId: string, overrides: Partial<DriverWriteGrant> = {}): DriverWriteGrant {
    return {
      kind: 'driver-write',
      realmId,
      grantedBy: 'driver@bayjf',
      grantedAt: '2026-09-24T10:00:00.000Z',
      expiresAt: '2026-09-24T10:05:00.000Z',
      nonce: 'nonce-1',
      ...overrides,
    };
  }

  it('refuses an enterprise write with no grant at all', async () => {
    const store = new FsRealmStore({ now: clock });
    const manifest = await store.connect(root, 'enterprise');
    await expect(store.write(manifest.realmId, { data: 'from the personal side\n' }))
      .rejects.toThrow(/enterprise write requires a valid driver grant \(missing\)/);
  });

  it('accepts a valid driver grant, writes, and records who authorized it', async () => {
    const written: RealmWriteAuditEntry[] = [];
    const store = new FsRealmStore({ now: clock, audit: entry => written.push(entry) });
    const manifest = await store.connect(root, 'enterprise');
    const { itemId } = await store.write(manifest.realmId, { data: 'escalation brief\n' }, grant(manifest.realmId));

    expect(await store.read(manifest.realmId, itemId)).toMatchObject({ content: 'escalation brief\n' });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ realmId: manifest.realmId, itemId, grantedBy: 'driver@bayjf', realmType: 'enterprise' });
    // the write is visible to the snapshot the Vault map and search read from
    expect((await store.manifest(manifest.realmId)).itemCount).toBe(1);
  });

  it('refuses a grant bound to another realm, an expired grant and a malformed one', async () => {
    const store = new FsRealmStore({ now: clock });
    const manifest = await store.connect(root, 'enterprise');
    await expect(store.write(manifest.realmId, { data: 'x\n' }, grant('realm-someone-else')))
      .rejects.toThrow(/wrong-realm/);
    await expect(store.write(manifest.realmId, { data: 'x\n' }, grant(manifest.realmId, { expiresAt: '2026-09-24T09:00:00.000Z' })))
      .rejects.toThrow(/expired/);
    await expect(store.write(manifest.realmId, { data: 'x\n' }, { ...grant(manifest.realmId), grantedBy: '' }))
      .rejects.toThrow(/malformed/);
  });

  it('mints the write timestamp from the injected clock, not the wall clock', async () => {
    const store = new FsRealmStore({ now: clock });
    const manifest = await store.connect(root, 'personal');
    const { itemId } = await store.write(manifest.realmId, { data: 'stamped\n' });
    // itemId is derived from the clock, which is what makes a deterministic
    // fixture possible at all.
    expect(itemId).toMatch(/^writes\/2026-09-24T10-00-00/);
  });

  it('a read-only enterprise connection stays read-only even with a grant', async () => {
    const store = new FsRealmStore({ now: clock });
    const manifest = await store.connect(root, 'enterprise', { readOnly: true });
    await expect(store.write(manifest.realmId, { data: 'x\n' }, grant(manifest.realmId)))
      .rejects.toBeInstanceOf(UnauthorizedRealmWriteError);
  });

  it('personal realms still need no grant, so the two domains do not blur', async () => {
    const personalRoot = join(sandbox, 'personal');
    mkdirSync(personalRoot, { recursive: true });
    const store = new FsRealmStore({ now: clock });
    const personal = await store.connect(personalRoot, 'personal');
    await expect(store.write(personal.realmId, { data: 'fine\n' })).resolves.toMatchObject({ itemId: /^writes\// });
  });

  describe('when the store has a driver trust anchor', () => {
    const signer = new Ed25519MemorySigner('driver-key-1');

    function anchored(ledger: DriverGrantLedger = new DriverGrantLedger()) {
      return new FsRealmStore({
        now: clock,
        driverGrants: { verifier: signer.verifier(), acceptedKeyIds: ['driver-key-1'], ledger },
      });
    }

    it('refuses the shape-correct blob that used to be enough', async () => {
      const store = anchored();
      const manifest = await store.connect(root, 'enterprise');
      await expect(store.write(manifest.realmId, { data: 'x\n' }, grant(manifest.realmId)))
        .rejects.toThrow(/driver grant \(unsigned\)/);
    });

    it('accepts a signed grant and refuses the same nonce on the next write', async () => {
      const store = anchored();
      const manifest = await store.connect(root, 'enterprise');
      const once = await issueDriverWriteGrant(
        { realmId: manifest.realmId, grantedBy: 'driver@bayjf', ttlMs: 60_000 },
        { signer, now: clock }
      );
      await expect(store.write(manifest.realmId, { data: 'first\n' }, once)).resolves.toMatchObject({ itemId: /^writes\// });
      await expect(store.write(manifest.realmId, { data: 'second\n' }, once))
        .rejects.toThrow(/driver grant \(replayed\)/);
    });

    it('refuses a grant signed for a different realm even when the signature is valid', async () => {
      const store = anchored();
      const manifest = await store.connect(root, 'enterprise');
      const forged = await issueDriverWriteGrant({ realmId: 'realm-elsewhere', grantedBy: 'driver@bayjf' }, { signer, now: clock });
      await expect(store.write(manifest.realmId, { data: 'x\n' }, forged)).rejects.toThrow(/wrong-realm/);
    });

    it('a consumed nonce survives a restart, so the replayed write is still refused', async () => {
      const ledger = new DriverGrantLedger();
      const store = anchored(ledger);
      const manifest = await store.connect(root, 'enterprise');
      const grant = await issueDriverWriteGrant({ realmId: manifest.realmId, grantedBy: 'driver@bayjf' }, { signer, now: clock });
      await store.write(manifest.realmId, { data: 'x\n' }, grant);

      // What the kernel state file carries is exactly this list.
      const afterRestart = new DriverGrantLedger();
      afterRestart.importState(ledger.exportState());
      const restarted = anchored(afterRestart);
      await restarted.connect(root, 'enterprise');
      await expect(restarted.write(manifest.realmId, { data: 'again\n' }, grant)).rejects.toThrow(/replayed/);
    });
  });
});

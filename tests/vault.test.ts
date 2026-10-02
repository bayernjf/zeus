import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsRealmStore } from '../src/realm/store.js';
import { sha256Hex } from '../src/util/crypto.js';
import { inventoryFromRealm } from '../src/vault/inventory.js';
import { buildVault } from '../src/vault/map.js';
import { restoreDryRun } from '../src/vault/restore.js';
import { liveSourceFor } from '../src/vault/inventory.js';
import {
  FsRestoreSink,
  openBundle,
  openMap,
  packFull,
  restoreFromBundle,
  sealMap,
} from '../src/vault/bundle.js';
import {
  VaultBundleMismatchError,
  VaultDecryptError,
  VaultFormatError,
  type SealedEnvelope,
  type TreasureMap,
} from '../src/vault/types.js';
import { open as openEnvelope, seal as sealEnvelope } from '../src/vault/cipher.js';

const SECRET_A = '# Alpha\nunique-secret-token-AAA\n';
const SECRET_B = 'Bravo content BBB\n';

let root: string;
let store: FsRealmStore;
let realmId: string;
let map: TreasureMap;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zeus-vault-'));
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'a.md'), SECRET_A);
  await writeFile(join(root, 'sub', 'b.txt'), SECRET_B);
  store = new FsRealmStore();
  const manifest = await store.connect(root, 'personal');
  realmId = manifest.realmId;
  map = await buildVault(inventoryFromRealm(store, realmId));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function flipBase64(value: string): string {
  // Flip the first (always significant, never padding) base64 character.
  return (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
}

describe('buildVault: map references, never content', () => {
  it('records one sorted mark per item with correct per-item digest', () => {
    expect(map.marks.map(m => m.itemId)).toEqual(['a.md', 'sub/b.txt']);
    expect(map.marks[0]!.digest).toBe(sha256Hex(SECRET_A));
    expect(map.marks[1]!.digest).toBe(sha256Hex(SECRET_B));
    expect(map.contentDigest).toBe(
      sha256Hex(
        ['a.md', 'sub/b.txt']
          .map(id => `${id}\0${sha256Hex(id === 'a.md' ? SECRET_A : SECRET_B)}\n`)
          .sort()
          .join('')
      )
    );
  });

  it('red line: serialized map contains no treasure content', () => {
    const serialized = JSON.stringify(map);
    expect(serialized).not.toContain('unique-secret-token-AAA');
    expect(serialized).not.toContain('Bravo content BBB');
  });
});

describe('seal/open: authenticated encryption with separated key', () => {
  it('round-trips the map and keeps no key or plaintext in the envelope', () => {
    const sealed = sealMap(map, 'passphrase');
    expect(sealed.format).toBe('zeus-treasure-map');
    expect(JSON.stringify(sealed)).not.toContain('passphrase');
    expect(openMap(sealed, 'passphrase')).toEqual(map);
  });

  it('rejects a wrong passphrase', async () => {
    const sealed = sealMap(map, 'passphrase');
    expect(() => openMap(sealed, 'wrong')).toThrow(VaultDecryptError);
  });

  it.each(['ciphertext', 'iv', 'tag', 'salt'] as const)('rejects a tampered %s', field => {
    const sealed: SealedEnvelope = { ...sealMap(map, 'passphrase'), [field]: flipBase64(sealMap(map, 'passphrase')[field]) };
    expect(() => openMap(sealed, 'passphrase')).toThrow(VaultDecryptError);
  });

  it('accepts a raw 32-byte key (KMS-style, no KDF)', () => {
    const rawKey = Buffer.alloc(32, 7);
    const sealed = sealMap(map, rawKey);
    expect(sealed.kdf).toBe('none');
    expect(openMap(sealed, rawKey)).toEqual(map);
    expect(() => openMap(sealed, Buffer.alloc(32, 8))).toThrow(VaultDecryptError);
  });
});

describe('L0 in-place restore and drift detection', () => {
  it('verifies an untouched realm as fully recoverable', async () => {
    const report = await restoreDryRun(map, liveSourceFor(new FsRealmStore()));
    expect(report.rootReachable).toBe(true);
    expect(report.recoverable).toBe(true);
    expect(report.ok).toHaveLength(2);
    expect(report.contentDigestMatch).toBe(true);
  });

  it('detects a changed file', async () => {
    await writeFile(join(root, 'a.md'), '# Alpha CHANGED\n');
    const report = await restoreDryRun(map, liveSourceFor(new FsRealmStore()));
    expect(report.changed).toHaveLength(1);
    expect(report.changed[0]!.itemId).toBe('a.md');
    expect(report.recoverable).toBe(false);
    expect(report.contentDigestMatch).toBe(false);
  });

  it('detects a missing file', async () => {
    await rm(join(root, 'a.md'));
    const report = await restoreDryRun(map, liveSourceFor(new FsRealmStore()));
    expect(report.missing).toEqual(['a.md']);
    expect(report.recoverable).toBe(false);
  });

  it('detects an unexpected new file', async () => {
    await writeFile(join(root, 'c.md'), 'new file\n');
    const report = await restoreDryRun(map, liveSourceFor(new FsRealmStore()));
    expect(report.unexpected).toEqual(['c.md']);
    expect(report.recoverable).toBe(true); // added files do not lose the mapped marks
  });

  it('reports an unreachable root and advises a bundle when mounted', async () => {
    const ghost: TreasureMap = { ...map, source: { ...map.source, root: join(root, 'does-not-exist') } };
    const report = await restoreDryRun(ghost, liveSourceFor(new FsRealmStore()));
    expect(report.rootReachable).toBe(false);
    expect(report.recoverable).toBe(false);
    expect(report.suggestion).toBe('reconnect-or-provide-bundle');
  });
});

describe('L1 full bundle: pack and portable restore', () => {
  it('packs map + bundle and round-trips the bundle', async () => {
    const packed = await packFull(inventoryFromRealm(store, realmId), 'pw');
    expect(packed.map.bundle?.digest).toBe(packed.map.contentDigest);
    const bundle = openBundle(packed.sealedBundle, 'pw');
    expect(bundle.items.map(i => i.itemId)).toEqual(expect.arrayContaining(['a.md', 'sub/b.txt']));
    expect(openMap(packed.sealedMap, 'pw')).toEqual(packed.map);
  });

  it('restores after the original directory is wiped', async () => {
    const packed = await packFull(inventoryFromRealm(store, realmId), 'pw');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    const report = await restoreFromBundle(packed.map, packed.sealedBundle, root, 'pw');
    expect(report.recoverable).toBe(true);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(SECRET_A);
    expect(await readFile(join(root, 'sub', 'b.txt'), 'utf8')).toBe(SECRET_B);
  });

  it('restores into a brand-new location on another "machine"', async () => {
    const packed = await packFull(inventoryFromRealm(store, realmId), 'pw');
    const target = await mkdtemp(join(tmpdir(), 'zeus-vault-target-'));
    try {
      const report = await restoreFromBundle(packed.map, packed.sealedBundle, target, 'pw');
      expect(report.recoverable).toBe(true);
      expect(await readFile(join(target, 'sub', 'b.txt'), 'utf8')).toBe(SECRET_B);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('rejects a bundle that belongs to a different map (swapped bundle)', async () => {
    const packed = await packFull(inventoryFromRealm(store, realmId), 'pw');
    const otherRoot = await mkdtemp(join(tmpdir(), 'zeus-vault-other-'));
    try {
      await writeFile(join(otherRoot, 'x.md'), 'a wholly different realm\n');
      const otherStore = new FsRealmStore();
      const otherManifest = await otherStore.connect(otherRoot, 'personal');
      const otherPacked = await packFull(inventoryFromRealm(otherStore, otherManifest.realmId), 'pw');
      await expect(
        restoreFromBundle(packed.map, otherPacked.sealedBundle, root, 'pw')
      ).rejects.toThrow(VaultBundleMismatchError);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects a tampered bundle', async () => {
    const packed = await packFull(inventoryFromRealm(store, realmId), 'pw');
    const tampered: SealedEnvelope = { ...packed.sealedBundle, tag: flipBase64(packed.sealedBundle.tag) };
    expect(() => openBundle(tampered, 'pw')).toThrow(VaultDecryptError);
  });
});

describe('restore sink hardening', () => {
  it('refuses itemIds that escape the target root', async () => {
    const sink = new FsRestoreSink();
    await expect(
      sink.writeItem(root, { itemId: '../evil.txt', content: 'x', modifiedAt: new Date().toISOString() })
    ).rejects.toThrow(VaultFormatError);
    await expect(
      sink.writeItem(root, { itemId: '/abs/evil.txt', content: 'x', modifiedAt: new Date().toISOString() })
    ).rejects.toThrow(VaultFormatError);
  });

  it('refuses to build a tree through a symlinked parent that leaves the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'zeus-vault-outside-'));
    try {
      await symlink(outside, join(root, 'linked'));
      const sink = new FsRestoreSink();
      // `linked/...` is a legal itemId, so only the resolved-parent check stands
      // between a hostile bundle and a tree written outside the target root.
      await expect(
        sink.writeItem(root, { itemId: 'linked/deep/new.md', content: 'x', modifiedAt: new Date().toISOString() })
      ).rejects.toThrow(VaultFormatError);
      expect(existsSync(join(outside, 'deep'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('replaces a symlinked item path instead of writing through it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'zeus-vault-victim-'));
    const victim = join(outside, 'victim.md');
    try {
      await writeFile(victim, 'do not touch me\n');
      await symlink(victim, join(root, 'planted.md'));
      const sink = new FsRestoreSink();
      await sink.writeItem(root, { itemId: 'planted.md', content: 'restored\n', modifiedAt: new Date().toISOString() });
      expect((await lstat(join(root, 'planted.md'))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(root, 'planted.md'), 'utf8')).toBe('restored\n');
      expect(await readFile(victim, 'utf8')).toBe('do not touch me\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('sealed envelope: the scrypt cost travels with the envelope', () => {
  it('records the cost it sealed with, and still opens one that predates the field', () => {
    const plaintext = JSON.stringify(map);
    const sealed = sealEnvelope(plaintext, 'zeus-treasure-map', 'passphrase');
    expect(sealed.kdfParams).toEqual({ N: 131_072, r: 8, p: 1 });
    expect(openEnvelope(sealed, 'passphrase')).toBe(plaintext);
    // A raw key skips the KDF, so there is no cost to record.
    expect(sealEnvelope(plaintext, 'zeus-treasure-map', Buffer.alloc(32, 7)).kdfParams).toBeUndefined();

    // A backup written before the field existed was sealed at Node's default
    // cost. It must keep opening - that is the whole reason the cost is carried
    // forward instead of hard-coded: raising N must not orphan old backups.
    const legacy = sealAtLegacyCost(plaintext);
    expect(legacy.kdfParams).toBeUndefined();
    expect(openEnvelope(legacy, 'passphrase')).toBe(plaintext);
  });

  it('refuses a cost it should not be asked to pay', () => {
    const sealed = sealEnvelope('x', 'zeus-treasure-map', 'passphrase');
    for (const kdfParams of [
      { N: 3, r: 8, p: 1 }, // not a power of two
      { N: 2 ** 21, r: 8, p: 1 }, // above the accepted ceiling
      { N: 131_072, r: 0, p: 1 }, // r must be at least 1
      { N: 131_072.5, r: 8, p: 1 }, // not an integer
    ]) {
      expect(() => openEnvelope({ ...sealed, kdfParams }, 'passphrase')).toThrow(VaultFormatError);
    }
  });
});

/**
 * Seal exactly the way this tool did before it recorded `kdfParams`:
 * `scryptSync` with Node's default cost (N=2^14, r=8, p=1).
 */
function sealAtLegacyCost(plaintext: string): SealedEnvelope {
  const salt = randomBytes(16);
  const key = scryptSync('passphrase', salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    format: 'zeus-treasure-map',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

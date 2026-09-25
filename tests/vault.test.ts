import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    expect(map.marks[0].digest).toBe(sha256Hex(SECRET_A));
    expect(map.marks[1].digest).toBe(sha256Hex(SECRET_B));
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
    expect(report.changed[0].itemId).toBe('a.md');
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
});

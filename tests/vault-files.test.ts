import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import { assertMap, buildVault } from '../src/vault/map.js';
import { fileLiveSource, inventoryFromFiles, inventoryFromRealm, liveSourceFor, realmLiveSource } from '../src/vault/inventory.js';
import { restoreDryRun } from '../src/vault/restore.js';
import { openBundle, openMap, packFull, restoreFromBundle } from '../src/vault/bundle.js';
import { seal } from '../src/vault/cipher.js';
import { MAP_FORMAT, VAULT_VERSION, type TreasureMap } from '../src/vault/types.js';
import { VaultError } from '../src/vault/types.js';
import { sha256Hex } from '../src/util/crypto.js';
import { runVaultCli } from '../src/vault/cli.js';
import { bootKernel } from '../src/state/boot.js';
import { kernelStats } from '../src/state/stats.js';

const KEY = 'correct horse';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const now = () => NOW;

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'zeus-vault-files-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('E3.6 regression: a tenant-scoped realm map verifies against a mounted kernel', () => {
  it('keeps the scope in the map and no longer reports a false unreachable', async () => {
    const root = join(sandbox, 'eng');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'charter.md'), 'how we ship\n');

    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'enterprise', { tenant: 'acme/eng' });
    const map = await buildVault(inventoryFromRealm(store, manifest.realmId));

    // Before this change the map dropped the tenant entirely, and re-connecting
    // without it against an already-scoped store was swallowed as "root
    // unreachable" - the recovery tool crying wolf about a healthy corpus.
    expect(map.source).toEqual({ kind: 'realm', realmId: manifest.realmId, type: 'enterprise', root: manifest.root, tenant: { org: 'acme', department: 'eng' } });

    const mounted = new FsRealmStore();
    await mounted.connect(root, 'enterprise', { tenant: 'acme/eng' });
    const report = await restoreDryRun(map, liveSourceFor(mounted));
    expect(report).toMatchObject({ sourceKind: 'realm', rootReachable: true, recoverable: true, contentDigestMatch: true });
    expect(report.unreachableReason).toBeUndefined();
  });

  it('still reports unreachability, now with the reason', async () => {
    const root = join(sandbox, 'gone');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), 'a\n');
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'personal');
    const map = await buildVault(inventoryFromRealm(store, manifest.realmId));
    const missing = { ...map, source: { ...map.source, root: join(sandbox, 'not-there') } };
    const report = await restoreDryRun(missing, liveSourceFor(new FsRealmStore()));
    expect(report.rootReachable).toBe(false);
    expect(report.unreachableReason).toMatch(/not accessible|no such file/);
    expect(report.recoverable).toBe(false);
  });
});

describe('#13 files source: backing up what no Realm covers', () => {
  async function corpus() {
    const root = join(sandbox, 'data');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'kernel.json'), JSON.stringify({ version: 1, registry: [] }, null, 2));
    await writeFile(join(root, 'notes.md'), 'the one file I keep by hand\n');
    await writeFile(join(root, 'audit.jsonl'), '{"secret":"never back me up"}\n');
    return root;
  }

  it('draws a map over an explicit whitelist and keeps content out of it', async () => {
    const root = await corpus();
    const map = await buildVault(inventoryFromFiles({ root, files: ['kernel.json', 'notes.md'] }), { now });
    expect(map.source).toMatchObject({ kind: 'files', files: ['kernel.json', 'notes.md'] });
    expect(map.marks.map(mark => mark.itemId)).toEqual(['kernel.json', 'notes.md']);
    const serialized = JSON.stringify(map);
    expect(serialized).not.toContain('the one file I keep by hand');
    expect(serialized).toContain('files');
  });

  it('treats the whitelist as the whole universe: unlisted files are neither missing nor unexpected', async () => {
    const root = await corpus();
    const inventory = inventoryFromFiles({ root, files: ['kernel.json'] });
    const map = await buildVault(inventory, { now });
    const report = await restoreDryRun(map, fileLiveSource());
    expect(report).toMatchObject({ sourceKind: 'files', recoverable: true, unexpected: [], missing: [] });
  });

  it('detects drift and deletion inside the whitelist', async () => {
    const root = await corpus();
    const map = await buildVault(inventoryFromFiles({ root, files: ['kernel.json', 'notes.md'] }), { now });
    await writeFile(join(root, 'notes.md'), 'silently edited\n');
    await rm(join(root, 'kernel.json'));
    const report = await restoreDryRun(map, fileLiveSource());
    expect(report.changed.map(entry => entry.itemId)).toEqual(['notes.md']);
    expect(report.missing).toEqual(['kernel.json']);
    expect(report.recoverable).toBe(false);
    expect(report.suggestion).toBe('reconnect-or-provide-bundle');
  });

  it('refuses a whitelist that cannot be honored faithfully', async () => {
    const root = await corpus();
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    await writeFile(join(sandbox, 'outside.json'), 'elsewhere\n');
    await symlink(join(sandbox, 'outside.json'), join(root, 'link.json'));
    await mkdir(join(root, 'adir'));

    await expect(inventoryFromFiles({ root, files: ['absent.json'] }).entries()).rejects.toThrow(/missing/);
    await expect(inventoryFromFiles({ root, files: ['/etc/passwd'] }).entries()).rejects.toThrow(/root-relative/);
    await expect(inventoryFromFiles({ root, files: ['../escape.md'] }).entries()).rejects.toThrow(/root-relative|escapes/);
    await expect(inventoryFromFiles({ root, files: ['blob.bin'] }).entries()).rejects.toThrow(/binary/);
    await expect(inventoryFromFiles({ root, files: ['link.json'] }).entries()).rejects.toThrow(/symlink/);
    await expect(inventoryFromFiles({ root, files: ['adir'] }).entries()).rejects.toThrow(/not a regular file/);
    await expect(inventoryFromFiles({ root, files: ['kernel.json'], maxBytes: 8 }).entries()).rejects.toThrow(/exceeds/);
    expect(() => inventoryFromFiles({ root, files: [] })).toThrow(VaultError);
  });

  it('holds the line on the verification path too: an unsafe name is never drift', async () => {
    const root = await corpus();
    const map = await buildVault(inventoryFromFiles({ root, files: ['kernel.json'] }), { now });
    // A hostile or hand-edited map that names ../secret.md must not be tolerated
    // into a quiet `missing` - tolerance is only for files that really are gone.
    const hostile = { ...map, source: { ...map.source, files: ['../secret.md'] } };
    const report = await restoreDryRun(hostile, fileLiveSource());
    expect(report.rootReachable).toBe(false);
    expect(report.unreachableReason).toMatch(/root-relative POSIX path/);
    const absolute = { ...map, source: { ...map.source, files: ['/etc/passwd'] } };
    await expect(fileLiveSource()(absolute.source)).rejects.toThrow(/root-relative POSIX path/);
  });

  it('packs and restores a files bundle into a fresh location', async () => {
    const root = await corpus();
    const packed = await packFull(inventoryFromFiles({ root, files: ['kernel.json', 'notes.md'] }), KEY, { now });
    const target = join(sandbox, 'rebuilt');
    await mkdir(target, { recursive: true });
    const report = await restoreFromBundle(packed.map, packed.sealedBundle, target, KEY);
    expect(report).toMatchObject({ sourceKind: 'files', rootReachable: true, recoverable: true, contentDigestMatch: true });
    expect(await readFile(join(target, 'notes.md'), 'utf8')).toBe('the one file I keep by hand\n');
    expect(JSON.parse(await readFile(join(target, 'kernel.json'), 'utf8'))).toEqual({ version: 1, registry: [] });
    // The unlisted audit file is not dragged along.
    expect(await exists(join(target, 'audit.jsonl'))).toBe(false);
  });
});

describe('#13 the kernel state file survives a destroy-and-restore drill', () => {
  it('restores a state file the map says is there, and the kernel boots from it', async () => {
    const data = join(sandbox, 'data');
    await mkdir(data, { recursive: true });
    const realmRoot = join(sandbox, 'realm');
    await mkdir(realmRoot, { recursive: true });
    await writeFile(join(realmRoot, 'a.md'), 'mine\n');
    const stateFile = join(data, 'kernel.json');

    const first = await bootKernel({ stateFile, now, realmRoots: [realmRoot] });
    await first.saveState();
    const original = await readFile(stateFile, 'utf8');
    const originalDigest = sha256Hex(original);
    // The state file carries memory/roster/org/commissions - and sits outside
    // every connected Realm, i.e. precisely what the map could not reach before.
    expect(JSON.parse(original)).toHaveProperty('commissions');
    expect(first.restoredFromSnapshot).toBe(false);

    const built = await runVaultCli(
      ['backup', '--files-root', data, '--files', 'kernel.json', '--out-dir', join(sandbox, 'bundle'), '--name', 'state'],
      { env: { ZEUS_VAULT_PASSPHRASE: KEY }, now },
    );
    expect(built.code, built.stderr).toBe(0);

    const checked = await runVaultCli(
      ['check', '--map', join(sandbox, 'bundle', 'state.map.json')],
      { env: { ZEUS_VAULT_PASSPHRASE: KEY }, now },
    );
    expect(checked.code, checked.stdout + checked.stderr).toBe(0);

    await rm(stateFile);
    const lost = await runVaultCli(
      ['check', '--map', join(sandbox, 'bundle', 'state.map.json')],
      { env: { ZEUS_VAULT_PASSPHRASE: KEY }, now },
    );
    expect(lost.code).toBe(2);

    const restoredDir = join(sandbox, 'rebuilt');
    await mkdir(restoredDir, { recursive: true });
    const restored = await runVaultCli(
      ['restore', '--map', join(sandbox, 'bundle', 'state.map.json'), '--bundle', join(sandbox, 'bundle', 'state.bundle.json'), '--target', restoredDir],
      { env: { ZEUS_VAULT_PASSPHRASE: KEY }, now },
    );
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    expect(sha256Hex(await readFile(join(restoredDir, 'kernel.json'), 'utf8'))).toBe(originalDigest);

    // Booting from the restored file is the point of restoring it.
    const revived = await bootKernel({ stateFile: join(restoredDir, 'kernel.json'), now, realmRoots: [] });
    expect(revived.restoredFromSnapshot).toBe(true);
    expect(kernelStats(revived).counts.realms).toBe(1);
  });
});

describe('#13 v1 maps still open', () => {
  const v1 = (root: string) => ({
    format: MAP_FORMAT,
    version: 1,
    createdAt: '2026-09-23T00:00:00.000Z',
    realm: { realmId: 'realm-abc', type: 'personal', root, itemCount: 1 },
    marks: [{ itemId: 'a.md', digest: 'deadbeef', modifiedAt: '2026-09-23T00:00:00.000Z', bytes: 2 }],
    contentDigest: 'cafe',
  });

  it('normalizes the realm descriptor into a source', () => {
    const normalized = assertMap(v1('/somewhere'));
    expect(normalized.version).toBe(VAULT_VERSION);
    expect(normalized.source).toEqual({ kind: 'realm', realmId: 'realm-abc', type: 'personal', root: '/somewhere' });
    expect(normalized.marks).toHaveLength(1);
  });

  it('opens a sealed v1 envelope through the same door as v2', async () => {
    const root = join(sandbox, 'old');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.md'), 'ok\n');
    const sealed = seal(JSON.stringify(v1(root)), MAP_FORMAT, KEY);
    const opened = openMap(sealed, KEY);
    expect(opened.source.kind).toBe('realm');
    const report = await restoreDryRun(opened, realmLiveSource(new FsRealmStore()));
    // The digests cannot match (the v1 fixture is synthetic), but the source
    // resolves and the mark is checked against real content - which is all
    // "a v1 map still opens" has to mean.
    expect(report.rootReachable).toBe(true);
    expect(report.changed.map(entry => entry.itemId)).toEqual(['a.md']);
    expect(report.contentDigestMatch).toBe(false);
    expect(() => openMap(seal(JSON.stringify({ format: MAP_FORMAT, version: 99 }), MAP_FORMAT, KEY), KEY)).toThrow(/unsupported map version/);
  });

  it('keeps bundle validation on the source shape', async () => {
    const root = await corpus2();
    const packed = await packFull(inventoryFromFiles({ root, files: ['k.json'] }), KEY, { now });
    const bundle = openBundle(packed.sealedBundle, KEY);
    expect(bundle.source.kind).toBe('files');
    const tampered = { ...packed.map, source: { kind: 'nonsense' } };
    await expect(restoreFromBundle(assertMapLoose(tampered), packed.sealedBundle, join(sandbox, 'x'), KEY)).rejects.toThrow(/unknown map source kind/);
  });
});

async function corpus2() {
  const root = join(sandbox, 'c2');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'k.json'), '{"a":1}\n');
  return root;
}

function assertMapLoose(value: unknown): TreasureMap {
  return value as TreasureMap;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

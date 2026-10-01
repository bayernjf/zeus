import { mkdir, realpath, utimes } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ensureDirInsideRoot, isInsideRoot, writeFileAtomic } from './fs.js';
import { digestManifest } from '../realm/digest.js';
import { FsRealmStore } from '../realm/store.js';
import { open, seal, type VaultKey } from './cipher.js';
import { assertSource, buildVault, parseMap } from './map.js';
import { liveSourceFor } from './inventory.js';
import { restoreDryRun } from './restore.js';
import {
  BUNDLE_FORMAT,
  MAP_FORMAT,
  VAULT_VERSION,
  type BundleRef,
  type FullBundle,
  type SealedEnvelope,
  type RestoreSink,
  type TreasureMap,
  type VaultInventory,
  VaultBundleMismatchError,
  VaultFormatError,
} from './types.js';

export type PackedFull = {
  map: TreasureMap;
  sealedMap: SealedEnvelope;
  sealedBundle: SealedEnvelope;
};

/** Seal a map (convenience wrapper). */
export function sealMap(map: TreasureMap, key: VaultKey): SealedEnvelope {
  return seal(JSON.stringify(map), MAP_FORMAT, key);
}

/** Open and validate a sealed map. */
export function openMap(envelope: SealedEnvelope, key: VaultKey): TreasureMap {
  return parseMap(open(envelope, key));
}

/**
 * Pack a full, portable backup (L1): draw the map, bundle every item's content,
 * seal both with the same key, and mount the bundle reference on the map. The
 * bundle digest equals the whole-realm fingerprint, binding map and bundle.
 */
export async function packFull(inventory: VaultInventory, key: VaultKey, opts: { now?: () => Date } = {}): Promise<PackedFull> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const source = await inventory.describe();
  const entries = await inventory.entries();

  const bundle: FullBundle = {
    format: BUNDLE_FORMAT,
    version: VAULT_VERSION,
    source,
    items: entries.map(entry => ({ itemId: entry.itemId, content: entry.content, modifiedAt: entry.modifiedAt })),
  };
  const sealedBundle = seal(JSON.stringify(bundle), BUNDLE_FORMAT, key);
  const bundleDigest = digestManifest(entries.map(entry => ({ itemId: entry.itemId, content: entry.content })));
  const bundleRef: BundleRef = { strategy: 'full', bundleId: bundleDigest.slice(0, 16), digest: bundleDigest, createdAt: now };

  const map = await buildVault(inventory, { now: opts.now, bundle: bundleRef });
  const sealedMap = sealMap(map, key);
  return { map, sealedMap, sealedBundle };
}

/** Open and validate a sealed full bundle. */
export function openBundle(envelope: SealedEnvelope, key: VaultKey): FullBundle {
  const plaintext = open(envelope, key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new VaultFormatError('full bundle is not valid JSON');
  }
  return assertBundle(parsed);
}

function assertBundle(value: unknown): FullBundle {
  if (!value || typeof value !== 'object') throw new VaultFormatError('bundle is not an object');
  const bundle = value as Partial<FullBundle>;
  if (bundle.format !== BUNDLE_FORMAT) throw new VaultFormatError(`not a full bundle: ${String(bundle.format)}`);
  if (bundle.version !== VAULT_VERSION) throw new VaultFormatError(`unsupported bundle version: ${String(bundle.version)}`);
  bundle.source = assertSource(bundle.source);
  if (!Array.isArray(bundle.items)) throw new VaultFormatError('bundle items must be an array');
  for (const item of bundle.items) {
    if (!item || typeof item.itemId !== 'string' || typeof item.content !== 'string') {
      throw new VaultFormatError('bundle contains an invalid item');
    }
  }
  return bundle as FullBundle;
}

/**
 * Restore treasure from a full bundle into a target location (L1): verify the
 * bundle matches the map reference, write every item through the sink, then
 * reconnect the target and re-verify all marks. Returns the verification report.
 */
export async function restoreFromBundle(
  map: TreasureMap,
  sealedBundle: SealedEnvelope,
  targetRoot: string,
  key: VaultKey,
  sink: RestoreSink = new FsRestoreSink()
) {
  const bundle = openBundle(sealedBundle, key);
  // Validate the map's own source before writing anything: a restore that
  // dispatches on a malformed descriptor would either fail halfway through
  // writing or write to a target the map never named.
  const source = assertSource(map.source);
  const recomputed = digestManifest(bundle.items.map(item => ({ itemId: item.itemId, content: item.content })));
  if (!map.bundle || recomputed !== map.bundle.digest) {
    throw new VaultBundleMismatchError('full bundle does not match the reference mounted on the map');
  }

  for (const item of bundle.items) {
    assertSafeRestorePath(item.itemId);
    await sink.writeItem(targetRoot, item);
  }

  const verifyMap: TreasureMap = { ...map, source: { ...source, root: targetRoot } };
  const verifyStore = new FsRealmStore();
  return restoreDryRun(verifyMap, liveSourceFor(verifyStore));
}

function assertSafeRestorePath(itemId: string): void {
  if (!itemId || itemId.startsWith('/') || itemId.includes('\\') || itemId.split('/').includes('..')) {
    throw new VaultFormatError(`unsafe itemId for restore: ${String(itemId)}`);
  }
}

/**
 * Filesystem restore sink: create parent dirs, publish the item atomically,
 * restore mtime.
 *
 * Every path decision is made on resolved paths: the target root is resolved
 * once, the parent chain is verified inside it before it is created, and the
 * item is published by rename so an existing symlink at the item path is
 * replaced instead of followed.
 */
export class FsRestoreSink implements RestoreSink {
  async writeItem(targetRoot: string, item: { itemId: string; content: string; modifiedAt: string }): Promise<void> {
    assertSafeRestorePath(item.itemId);
    const absRoot = resolve(targetRoot);
    await mkdir(absRoot, { recursive: true });
    const root = await realpath(absRoot);
    const abs = join(root, item.itemId);
    if (!isInsideRoot(root, abs)) {
      throw new VaultFormatError(`restore item escapes the target root: ${item.itemId}`);
    }
    const realParent = await ensureDirInsideRoot(root, dirname(abs), `restore target for ${item.itemId}`);
    const target = join(realParent, basename(abs));
    if (!isInsideRoot(root, target)) {
      throw new VaultFormatError(`restore item resolves outside the target root: ${item.itemId}`);
    }
    await writeFileAtomic(target, item.content);
    const mtimeSec = Date.parse(item.modifiedAt) / 1000;
    if (!Number.isNaN(mtimeSec)) await utimes(target, mtimeSec, mtimeSec);
  }
}

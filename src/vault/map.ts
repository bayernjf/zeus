import { digestManifest } from '../realm/digest.js';
import { sha256Hex } from '../util/crypto.js';
import {
  MAP_FORMAT,
  VAULT_VERSION,
  type BundleRef,
  type MapMark,
  type TreasureMap,
  type VaultInventory,
  VaultFormatError,
} from './types.js';

export type BuildMapOptions = {
  now?: () => Date;
  bundle?: BundleRef;
};

/** Draw a treasure map from an inventory: marks carry fingerprints, never content. */
export async function buildVault(inventory: VaultInventory, opts: BuildMapOptions = {}): Promise<TreasureMap> {
  const { realmId, type, root } = await inventory.describe();
  const entries = await inventory.entries();
  const marks: MapMark[] = marksFrom(entries);
  const contentDigest = digestManifest(entries.map(entry => ({ itemId: entry.itemId, content: entry.content })));
  return {
    format: MAP_FORMAT,
    version: VAULT_VERSION,
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    realm: { realmId, type, root, itemCount: entries.length },
    marks,
    contentDigest,
    ...(opts.bundle ? { bundle: opts.bundle } : {}),
  };
}

function marksFrom(entries: Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }>): MapMark[] {
  return entries
    .map(entry => ({
      itemId: entry.itemId,
      digest: sha256Hex(entry.content),
      modifiedAt: entry.modifiedAt,
      bytes: entry.bytes,
    }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/** Validate the shape of an opened map object. */
export function assertMap(value: unknown): TreasureMap {
  if (!value || typeof value !== 'object') throw new VaultFormatError('map is not an object');
  const map = value as Partial<TreasureMap>;
  if (map.format !== MAP_FORMAT) throw new VaultFormatError(`not a treasure map: ${String(map.format)}`);
  if (map.version !== VAULT_VERSION) throw new VaultFormatError(`unsupported map version: ${String(map.version)}`);
  if (
    !map.realm ||
    typeof map.realm.realmId !== 'string' ||
    typeof map.realm.root !== 'string' ||
    typeof map.realm.type !== 'string'
  ) {
    throw new VaultFormatError('map realm descriptor is incomplete');
  }
  if (!Array.isArray(map.marks)) throw new VaultFormatError('map marks must be an array');
  for (const mark of map.marks) {
    if (!mark || typeof mark.itemId !== 'string' || typeof mark.digest !== 'string') {
      throw new VaultFormatError('map contains an invalid mark');
    }
  }
  if (typeof map.contentDigest !== 'string') throw new VaultFormatError('map contentDigest is missing');
  return map as TreasureMap;
}

/** Parse and validate an opened (decrypted) map plaintext. */
export function parseMap(plaintext: string): TreasureMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new VaultFormatError('map is not valid JSON');
  }
  return assertMap(parsed);
}

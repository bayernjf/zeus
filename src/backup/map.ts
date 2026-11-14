import { digestManifest } from '../dataDomain/digest.js';
import { sha256Hex } from '../util/crypto.js';
import {
  MAP_FORMAT,
  BACKUP_VERSION,
  type BundleRef,
  type MapMark,
  type MapSource,
  type TreasureMap,
  type BackupInventory,
  BackupFormatError,
} from './types.js';

export type BuildMapOptions = {
  now?: () => Date;
  bundle?: BundleRef;
};

/** Draw a treasure map from an inventory: marks carry fingerprints, never content. */
export async function buildBackup(inventory: BackupInventory, opts: BuildMapOptions = {}): Promise<TreasureMap> {
  const source = await inventory.describe();
  const entries = await inventory.entries();
  const marks: MapMark[] = marksFrom(entries);
  const contentDigest = digestManifest(entries.map(entry => ({ itemId: entry.itemId, content: entry.content })));
  return {
    format: MAP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    source,
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

/**
 * Validate an opened map and normalize it to the current version.
 *
 * v1 maps baked the source into a `dataDomain` descriptor; they are rewritten into
 * `source` on read rather than rejected, because a sealed map is exactly the
 * kind of artifact people keep for years. A v1 enterprise map has no recorded
 * tenant scope, so the normalized source has none either - the caller then
 * verifies against an unscoped mount, which is what the map genuinely says.
 */
export function assertMap(value: unknown): TreasureMap {
  if (!value || typeof value !== 'object') throw new BackupFormatError('map is not an object');
  const map = value as Partial<TreasureMap> & {
    dataDomain?: { dataDomainId?: unknown; type?: unknown; root?: unknown; itemCount?: unknown };
  };
  if (map.format !== MAP_FORMAT) throw new BackupFormatError(`not a treasure map: ${String(map.format)}`);
  const version = Number(map.version);
  if (version !== BACKUP_VERSION && version !== 1) {
    throw new BackupFormatError(`unsupported map version: ${String(map.version)}`);
  }

  const source = version === 1 ? sourceFromV1DataDomain(map.dataDomain) : assertSource(map.source);
  if (!Array.isArray(map.marks)) throw new BackupFormatError('map marks must be an array');
  for (const mark of map.marks) {
    if (!mark || typeof mark.itemId !== 'string' || typeof mark.digest !== 'string') {
      throw new BackupFormatError('map contains an invalid mark');
    }
  }
  if (typeof map.contentDigest !== 'string') throw new BackupFormatError('map contentDigest is missing');

  return {
    format: MAP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: typeof map.createdAt === 'string' ? map.createdAt : '',
    source,
    marks: map.marks,
    contentDigest: map.contentDigest,
    ...(map.bundle ? { bundle: map.bundle } : {}),
  };
}

function sourceFromV1DataDomain(dataDomain: unknown): MapSource {
  const legacy = dataDomain as { dataDomainId?: unknown; type?: unknown; root?: unknown } | undefined;
  if (
    !legacy ||
    typeof legacy.dataDomainId !== 'string' ||
    typeof legacy.root !== 'string' ||
    (legacy.type !== 'personal' && legacy.type !== 'enterprise')
  ) {
    throw new BackupFormatError('v1 map dataDomain descriptor is incomplete');
  }
  return { kind: 'dataDomain', dataDomainId: legacy.dataDomainId, type: legacy.type, root: legacy.root };
}

export function assertSource(value: unknown): MapSource {
  if (!value || typeof value !== 'object') throw new BackupFormatError('map source is missing');
  const source = value as Partial<MapSource> & { files?: unknown; tenant?: unknown };
  if (source.kind === 'dataDomain') {
    if (typeof source.dataDomainId !== 'string' || typeof source.root !== 'string') {
      throw new BackupFormatError('dataDomain source descriptor is incomplete');
    }
    if (source.type !== 'personal' && source.type !== 'enterprise') {
      throw new BackupFormatError(`dataDomain source has an unknown type: ${String(source.type)}`);
    }
    const tenant = source.tenant as { org?: unknown; department?: unknown; member?: unknown } | undefined;
    return {
      kind: 'dataDomain',
      dataDomainId: source.dataDomainId,
      type: source.type,
      root: source.root,
      ...(tenant && typeof tenant.org === 'string'
        ? {
            tenant: {
              org: tenant.org,
              ...(typeof tenant.department === 'string' ? { department: tenant.department } : {}),
              ...(typeof tenant.member === 'string' ? { member: tenant.member } : {}),
            },
          }
        : {}),
    };
  }
  if (source.kind === 'files') {
    if (typeof source.root !== 'string' || !Array.isArray(source.files) || source.files.length === 0) {
      throw new BackupFormatError('files source needs a root and a non-empty whitelist');
    }
    const files = source.files.filter((name): name is string => typeof name === 'string' && name.length > 0);
    if (files.length !== source.files.length) throw new BackupFormatError('files source holds a non-string entry');
    return {
      kind: 'files',
      label: typeof source.label === 'string' && source.label ? source.label : files.join(','),
      root: source.root,
      files,
    };
  }
  throw new BackupFormatError(`unknown map source kind: ${String((source as { kind?: unknown }).kind)}`);
}

/** Parse and validate an opened (decrypted) map plaintext. */
export function parseMap(plaintext: string): TreasureMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new BackupFormatError('map is not valid JSON');
  }
  return assertMap(parsed);
}

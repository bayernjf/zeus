import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RealmStore } from '../realm/types.js';
import {
  VaultError,
  VaultUnreadableError,
  type LiveSource,
  type MapSource,
  type VaultInventory,
} from './types.js';

/** Default ceiling for one whitelisted file (the kernel state file is small;
 *  an unbounded read into a backup would be its own incident). */
export const DEFAULT_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** Adapt a connected Realm into the inventory port the map drawer consumes. */
export function inventoryFromRealm(store: RealmStore, realmId: string): VaultInventory {
  return {
    async describe(): Promise<MapSource> {
      const manifest = await store.manifest(realmId);
      return {
        kind: 'realm',
        realmId: manifest.realmId,
        type: manifest.type,
        root: manifest.root,
        ...(manifest.tenant ? { tenant: manifest.tenant } : {}),
      };
    },
    async entries() {
      return store.entries(realmId);
    },
  };
}

export type FilesInventoryOptions = {
  /** Directory the whitelisted files are resolved under. */
  root: string;
  /** Root-relative POSIX paths. Named one by one - never a directory walk. */
  files: string[];
  label?: string;
  maxBytes?: number;
};

type FilesSource = Extract<MapSource, { kind: 'files' }>;

/**
 * Inventory over an explicit file whitelist - the shape needed to back up
 * `kernel.json`, which lives outside every connected Realm.
 *
 * A named file that is missing, escapes the root, is a symlink or is binary
 * throws instead of being skipped: a backup that quietly drops the one file you
 * asked for is worse than no backup, because it reports success.
 */
export function inventoryFromFiles(options: FilesInventoryOptions): VaultInventory {
  const root = resolve(options.root);
  const files = options.files.map(name => name.trim()).filter(Boolean);
  if (files.length === 0) throw new VaultError('a files inventory needs at least one whitelisted file');
  const maxBytes = options.maxBytes ?? DEFAULT_FILE_MAX_BYTES;
  const source: FilesSource = {
    kind: 'files',
    label: options.label?.trim() || basename(root),
    root,
    files,
  };

  return {
    async describe() {
      return structuredClone(source);
    },
    async entries() {
      return readWhitelist(source, maxBytes, false);
    },
  };
}

/**
 * Read every whitelisted file. A named file that cannot be read faithfully
 * throws `VaultUnreadableError`, and an unsafe whitelist entry (absolute,
 * escaping) throws a plain `VaultError` - the latter is never tolerable, because
 * a map that names `/etc/passwd` is a hostile map, not a drifted one.
 */
async function readWhitelist(source: FilesSource, maxBytes: number, tolerateUnreadable: boolean) {
  const absRoot = resolve(source.root);
  // Containment must be judged against the RESOLVED root: a directory reached
  // through a symlink (/var -> /private/var on macOS, a mounted data dir on a
  // server) realpaths to a different prefix than its own files, so comparing
  // resolved files to an unresolved root made every file look like an escape.
  const realRoot = await realpath(absRoot).catch(() => absRoot);
  const listed: Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }> = [];
  for (const name of source.files) {
    try {
      listed.push(await readWhitelistedFile(realRoot, name, maxBytes));
    } catch (error) {
      if (!tolerateUnreadable || !(error instanceof VaultUnreadableError)) throw error;
    }
  }
  return listed;
}

async function readWhitelistedFile(realRoot: string, name: string, maxBytes: number) {
  assertSafeRelativePath(name);
  const abs = resolve(realRoot, name);
  if (!isInsideRoot(realRoot, abs)) throw new VaultError(`whitelisted file escapes the root: ${name}`);
  let link;
  try {
    link = await lstat(abs);
  } catch {
    throw new VaultUnreadableError(`whitelisted file is missing: ${name}`);
  }
  if (link.isSymbolicLink()) throw new VaultUnreadableError(`symlinked file is not backed up: ${name}`);
  if (!link.isFile()) throw new VaultUnreadableError(`not a regular file: ${name}`);
  if (link.size > maxBytes) {
    throw new VaultUnreadableError(`file exceeds the ${maxBytes}-byte backup limit: ${name}`);
  }
  const real = await realpath(abs);
  if (!isInsideRoot(realRoot, real)) throw new VaultError(`file resolves outside the root: ${name}`);
  const buffer = await readFile(real);
  // Binary content would be mangled by utf-8 round-tripping, so refuse it
  // instead of producing a backup that cannot be restored faithfully.
  if (buffer.includes(0)) throw new VaultUnreadableError(`binary file is outside the scope of a text backup: ${name}`);
  return {
    itemId: toPosix(relative(realRoot, real)),
    content: buffer.toString('utf8'),
    modifiedAt: link.mtime.toISOString(),
    bytes: buffer.byteLength,
  };
}

/** Live-source resolver for a realm map: reconnect with the map's own scope. */
export function realmLiveSource(store: RealmStore): LiveSource {
  return async source => {
    if (source.kind !== 'realm') throw new VaultError(`this map needs a file source, not a realm: ${source.kind}`);
    const manifest = await store.connect(source.root, source.type, source.tenant ? { tenant: source.tenant } : {});
    return store.entries(manifest.realmId);
  };
}

/**
 * Live-source resolver for a files map: re-read the same whitelist, but treat a
 * file that has vanished or become unreadable as absent from the live view so
 * L0 reports it as `missing` drift. Reporting the whole source as unreachable
 * would send the operator to the wrong command - exit 3 ("go mount something")
 * when the truth is "your state file is gone, restore it from the bundle".
 */
export function fileLiveSource(): LiveSource {
  return async source => {
    if (source.kind !== 'files') throw new VaultError(`this map needs a realm source, not files: ${source.kind}`);
    return readWhitelist(source, DEFAULT_FILE_MAX_BYTES, true);
  };
}

/** Pick the resolver that matches the map's own source kind. */
export function liveSourceFor(store: RealmStore): LiveSource {
  const realm = realmLiveSource(store);
  const files = fileLiveSource();
  return source => (source.kind === 'realm' ? realm(source) : files(source));
}

function assertSafeRelativePath(name: string): void {
  if (!name || isAbsolute(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw new VaultError(`whitelisted file must be a root-relative POSIX path: ${name}`);
  }
}

function isInsideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toPosix(pathName: string): string {
  return pathName.split(sep).join('/');
}

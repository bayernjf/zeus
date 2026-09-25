import type { RealmType } from '../a2a/types.js';
import type { TenantScope } from '../realm/types.js';

export const MAP_FORMAT = 'zeus-treasure-map' as const;
export const BUNDLE_FORMAT = 'zeus-full-bundle' as const;
/** v2 replaced the baked-in `realm` descriptor with `source`, so a map can
 *  cover the kernel state file - the one thing users can lose and the treasure
 *  map could not previously reach. v1 maps are normalized on read (§ map.ts). */
export const VAULT_VERSION = 2 as const;

/**
 * Where the treasure lives. A Realm is one kind; an explicit file whitelist is
 * the other, because `kernel.json` (roster, memory facts, connector declarations,
 * org establishment) sits OUTSIDE every connected Realm and was therefore
 * unbackupable by the tool whose whole promise is "备份是第一公民".
 *
 * The files kind carries a whitelist, never a directory walk: pointing it at
 * `./data` would sweep up an unbounded `audit.jsonl` and leftover `.tmp` files.
 */
export type MapSource =
  | {
      kind: 'realm';
      realmId: string;
      type: RealmType;
      /** Absolute realpath; sealed inside the map, never printed. */
      root: string;
      /** E3.6 scope, kept so re-opening the map can re-establish the SAME mount. */
      tenant?: TenantScope;
    }
  | {
      kind: 'files';
      /** Human label for reports (defaults to the root's basename). */
      label: string;
      /** Absolute directory the whitelisted files live under. */
      root: string;
      /** Root-relative POSIX paths, named one by one. */
      files: string[];
    };

/** One treasure mark: where the treasure is and its fingerprint. Never the content. */
export type MapMark = {
  itemId: string;
  digest: string;
  modifiedAt: string;
  bytes: number;
};

/** Reference to a mounted full backup bundle. */
export type BundleRef = {
  strategy: 'full';
  bundleId: string;
  digest: string;
  createdAt: string;
};

/** The treasure map: references only, no inlined treasure content. */
export type TreasureMap = {
  format: typeof MAP_FORMAT;
  version: typeof VAULT_VERSION;
  createdAt: string;
  source: MapSource;
  marks: MapMark[];
  /** Whole-source fingerprint, same algorithm as RealmManifest.contentDigest. */
  contentDigest: string;
  bundle?: BundleRef;
};

/** Authenticated encryption envelope shared by maps and full bundles. */
export type SealedEnvelope = {
  alg: 'aes-256-gcm';
  kdf: 'scrypt' | 'none';
  format: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export type BundleItem = {
  itemId: string;
  content: string;
  modifiedAt: string;
};

/** Full backup bundle plaintext; only exists across the seal/open boundary. */
export type FullBundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof VAULT_VERSION;
  source: MapSource;
  items: BundleItem[];
};

/** Result of an in-place verification / restore plan. */
export type RestoreReport = {
  /** Identifier of the source that was checked (realmId, or `files:<label>`). */
  sourceId: string;
  sourceKind: MapSource['kind'];
  rootReachable: boolean;
  /** Why the source could not be read. A recovery tool that only says
   *  "unreachable" pushes the operator to guess; the mount-scope mismatch that
   *  made this bug possible was exactly such a guess. */
  unreachableReason?: string;
  contentDigestMatch: boolean;
  total: number;
  ok: string[];
  changed: Array<{ itemId: string; expectedDigest: string; actualDigest: string }>;
  missing: string[];
  unexpected: string[];
  /** Lifeline: every mark is present on disk with a matching fingerprint. */
  recoverable: boolean;
  /** Suggested next action, if any. */
  suggestion?: 'restore-from-bundle' | 'reconnect-or-provide-bundle';
};

/** Source of enumerable entries for drawing a map. */
export interface VaultInventory {
  describe(): Promise<MapSource>;
  entries(): Promise<Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }>>;
}

/**
 * The live view of a source at check/restore time. L0 used to take a
 * `RealmStore` directly, which hard-wired the recovery protocol to one source
 * kind - and reconnected without the map's tenant scope, so verifying a
 * tenant-scoped enterprise realm against a running kernel reported the treasure
 * as missing.
 */
export type LiveSource = (source: MapSource) => Promise<Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }>>;

/** Writable target used to rebuild treasure from a full bundle. */
export interface RestoreSink {
  writeItem(targetRoot: string, item: { itemId: string; content: string; modifiedAt: string }): Promise<void>;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/** Decryption / authentication failure (wrong key or tampered envelope). */
export class VaultDecryptError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultDecryptError';
  }
}

/** Malformed map / bundle / envelope. */
export class VaultFormatError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultFormatError';
  }
}

/** Full bundle does not match the reference mounted on the map. */
export class VaultBundleMismatchError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultBundleMismatchError';
  }
}

/**
 * A whitelisted file is present in name but cannot be read faithfully right now
 * (deleted, replaced by a symlink or a directory, turned binary, too large).
 *
 * The distinction matters because the two callers want opposite behavior: backup
 * must REFUSE (a silent drop yields a "successful" backup missing the one file
 * you asked for), while L0 verification must report it as `missing` drift - not
 * as an unreachable source.
 */
export class VaultUnreadableError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultUnreadableError';
  }
}

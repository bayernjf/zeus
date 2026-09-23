import type { RealmType } from '../a2a/types.js';

export const MAP_FORMAT = 'zeus-treasure-map' as const;
export const BUNDLE_FORMAT = 'zeus-full-bundle' as const;
export const VAULT_VERSION = 1 as const;

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
  realm: {
    realmId: string;
    type: RealmType;
    /** Absolute realpath; the map is sealed at rest and opened to reconnect. */
    root: string;
    itemCount: number;
  };
  marks: MapMark[];
  /** Whole-realm fingerprint, same algorithm as RealmManifest.contentDigest. */
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
  realm: { realmId: string; type: RealmType };
  items: BundleItem[];
};

/** Result of an in-place verification / restore plan. */
export type RestoreReport = {
  realmId: string;
  rootReachable: boolean;
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
  describe(): Promise<{ realmId: string; type: RealmType; root: string }>;
  entries(): Promise<Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }>>;
}

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

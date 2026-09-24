import type { RealmType } from '../a2a/types.js';

export type { RealmType };

export type RealmBackupStrategy = 'none' | 'manifest-only' | 'full';

export type RealmBackupState = {
  strategy: RealmBackupStrategy;
  lastVerifiedAt?: string;
};

export type RealmManifest = {
  realmId: string;
  type: RealmType;
  /** Absolute realpath of the root. Held in-process only; the future MCP
   *  exposure layer MUST omit this field before serializing to clients. */
  root: string;
  createdAt: string;
  contentDigest: string;
  /** Number of managed text items captured at connect time. */
  itemCount: number;
  skipped?: Array<{ itemId: string; reason: string }>;
  backup: RealmBackupState;
};

export type RealmHit = {
  itemId: string;
  tags: string[];
  snippet: string;
  modifiedAt: string;
};

export type SearchQuery = {
  text?: string;
  /** Not supported in P0 — a non-empty value raises UnsupportedQueryError. */
  tags?: string[];
  since?: string;
  limit?: number;
};

export type RealmItem = {
  itemId: string;
  content: string;
  modifiedAt: string;
  bytes: number;
};

/** Read-only enumeration row for every managed entry at connect time.
 *  Carries full content; used by the Vault to draw maps / build full bundles. */
export type RealmEntrySnapshot = {
  itemId: string;
  content: string;
  modifiedAt: string;
  bytes: number;
};

/** Payload for a Realm write (design-realm.md §2 contract). */
export type RealmWriteItem = {
  /** Root-relative POSIX path; when omitted the store mints an itemId under writes/. */
  itemId?: string;
  /** String written verbatim; other JSON-compatible values are serialized as JSON. */
  data: unknown;
  /** Not persisted by the P0 filesystem backend; a non-empty value is rejected. */
  tags?: string[];
};

export type RealmWriteResult = {
  itemId: string;
};

/**
 * Driver authorization credential required for writes into an ENTERPRISE realm
 * (design-realm.md §3: personal→enterprise needs explicit driver authorization).
 * The library verifies shape/realm/expiry; the MCP/HTTP layer injects a signed
 * grant after authenticating the driver (signature/transport are a P1 concern).
 */
export type DriverWriteGrant = {
  kind: 'driver-write';
  realmId: string;
  /** Driver identity authorizing the write. */
  grantedBy: string;
  reason?: string;
  grantedAt: string;
  expiresAt?: string;
  nonce: string;
};

export type GrantVerification =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'wrong-realm' | 'expired' };

export interface RealmStore {
  connect(root: string, type: RealmType, opts?: { readOnly?: boolean }): Promise<RealmManifest>;
  manifest(realmId: string): Promise<RealmManifest>;
  search(realmId: string, query: SearchQuery): Promise<RealmHit[]>;
  read(realmId: string, itemId: string): Promise<RealmItem>;
  /** G4: connect-time parameters of every connected realm, for persistence. */
  connections(): RealmConnection[];
  /** Read-only enumeration of every managed entry from the connect snapshot
   *  (with full content), powering Vault map drawing and full bundles. */
  entries(realmId: string): Promise<RealmEntrySnapshot[]>;
  /**
   * E3.5 write path. Personal realms allow writes by default; a realm
   * connected readOnly refuses them. Enterprise writes require a valid
   * DriverWriteGrant (third argument). Writes stay inside the same path /
   * text-extension / size guards as reads and are applied atomically.
   */
  write?(
    realmId: string,
    item: RealmWriteItem,
    grant?: DriverWriteGrant,
  ): Promise<RealmWriteResult>;
}

/** G4: everything needed to reconnect a realm after restart. The search index
 *  is rebuilt on reconnect, so only the connect parameters are persisted. */
export type RealmConnection = {
  root: string;
  realmId: string;
  type: RealmType;
  readOnly: boolean;
};

export class RealmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealmError';
  }
}

/** Invariant 2: connect before use. */
export class RealmNotConnectedError extends RealmError {
  constructor(message: string) {
    super(message);
    this.name = 'RealmNotConnectedError';
  }
}

/** itemId must stay inside the realm root (path-traversal / symlink escape). */
export class InvalidItemIdError extends RealmError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidItemIdError';
  }
}

/** Query capability not available in P0 (e.g. tag search). */
export class UnsupportedQueryError extends RealmError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedQueryError';
  }
}

/** E3.5: an enterprise-realm write lacks a valid driver grant, or a read-only
 *  realm was asked to write. */
export class UnauthorizedRealmWriteError extends RealmError {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedRealmWriteError';
  }
}

/** E3.5: a write asks for a capability the P0 filesystem backend cannot honor
 *  (e.g. persisting tags, non-text payloads/paths). */
export class UnsupportedWriteError extends RealmError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWriteError';
  }
}

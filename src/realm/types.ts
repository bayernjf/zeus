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

export interface RealmStore {
  connect(root: string, type: RealmType, opts?: { readOnly?: boolean }): Promise<RealmManifest>;
  manifest(realmId: string): Promise<RealmManifest>;
  search(realmId: string, query: SearchQuery): Promise<RealmHit[]>;
  read(realmId: string, itemId: string): Promise<RealmItem>;
}

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

/** P0 supports personal realms only; enterprise is P1. */
export class UnsupportedRealmTypeError extends RealmError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRealmTypeError';
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

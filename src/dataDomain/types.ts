import type { DataDomainType } from '../a2a/types.js';

export type { DataDomainType };

export type DataDomainBackupStrategy = 'none' | 'manifest-only' | 'full';

/**
 * E3.6: position in the enterprise hierarchy. Only enterprise dataDomains carry
 * one; the personal domain is deliberately NOT expressible as a tenant so that
 * the personal/enterprise diode has a type-level witness.
 */
export type TenantScope = {
  org: string;
  department?: string;
  member?: string;
};

/** Who is asking. `operator` is the human data sovereign and is never tenant-gated. */
export type DataDomainActor =
  | { kind: 'operator'; id: string }
  | { kind: 'executor'; id: string; tenant?: TenantScope }
  | { kind: 'agent'; id: string; tenant?: TenantScope };

export type DataDomainAccess = 'read' | 'write';

export type DataDomainBackupState = {
  strategy: DataDomainBackupStrategy;
  lastVerifiedAt?: string;
};

export type DataDomainManifest = {
  dataDomainId: string;
  type: DataDomainType;
  /** E3.6: enterprise dataDomains are scoped to a position in the org hierarchy.
   *  Personal dataDomains never carry one (design-dataDomain §8.1). */
  tenant?: TenantScope;
  /** Absolute realpath of the root. Held in-process only; the future MCP
   *  exposure layer MUST omit this field before serializing to clients. */
  root: string;
  createdAt: string;
  contentDigest: string;
  /** Number of managed text items captured at connect time. */
  itemCount: number;
  skipped?: Array<{ itemId: string; reason: string }>;
  backup: DataDomainBackupState;
};

export type DataDomainHit = {
  itemId: string;
  tags: string[];
  snippet: string;
  modifiedAt: string;
  /**
   * DataDomain the hit was read from. Set on runtime-resolved hits (the search
   * backend knows the dataDomainId it searched); absent on caller-asserted hits,
   * which arrive without a dataDomain binding. The dataDomain-scoped content gate
   * (design-guardrails §5) treats a missing dataDomainId as unverifiable and
   * refuses rather than guessing a dataDomain.
   */
  dataDomainId?: string;
};

export type SearchQuery = {
  text?: string;
  /** Not supported in P0 — a non-empty value raises UnsupportedQueryError. */
  tags?: string[];
  since?: string;
  limit?: number;
};

export type DataDomainItem = {
  itemId: string;
  content: string;
  modifiedAt: string;
  bytes: number;
};

/** Read-only enumeration row for every managed entry at connect time.
 *  Carries full content; used by the Backup to draw maps / build full bundles. */
export type DataDomainEntrySnapshot = {
  itemId: string;
  content: string;
  modifiedAt: string;
  bytes: number;
};

/** Payload for a DataDomain write (design-dataDomain.md §2 contract). */
export type DataDomainWriteItem = {
  /** Root-relative POSIX path; when omitted the store mints an itemId under writes/. */
  itemId?: string;
  /** String written verbatim; other JSON-compatible values are serialized as JSON. */
  data: unknown;
  /** Not persisted by the P0 filesystem backend; a non-empty value is rejected. */
  tags?: string[];
};

export type DataDomainWriteResult = {
  itemId: string;
};

/**
 * Operator authorization credential required for writes into an ENTERPRISE dataDomain
 * (design-dataDomain.md §3: personal→enterprise needs explicit operator authorization).
 * The library verifies shape/dataDomain/expiry; the MCP/HTTP layer injects a signed
 * grant after authenticating the operator (signature/transport are a P1 concern).
 */
/**
 * E3.5 write credential. Issued and signed by `issueOperatorWriteGrant`
 * (`src/dataDomain/grant.ts`): the runtime mints the nonce, stamps the times and
 * signs, so a caller can neither replay an old grant nor invent one.
 */
export type OperatorWriteGrant = {
  kind: 'operator-write';
  dataDomainId: string;
  /** Operator identity authorizing the write. */
  grantedBy: string;
  reason?: string;
  grantedAt: string;
  /** Always set on issued grants; a write credential without an expiry is not a credential. */
  expiresAt?: string;
  nonce: string;
  /** Signing key id, present on a signed grant. */
  keyId?: string;
  /** Ed25519 (base64url) over the canonical grant minus `sig`. */
  sig?: string;
};

/** A grant as produced by `issueOperatorWriteGrant`: signed and time-boxed. */
export type SignedOperatorWriteGrant = OperatorWriteGrant & { keyId: string; sig: string; expiresAt: string };

export type GrantVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'malformed'
        | 'wrong-dataDomain'
        | 'expired'
        /** Issued grants always expire; an open-ended one is refused even where a trust anchor is not configured. */
        | 'no-expiry'
        /** No signature at all: an unsigned blob is a claim, not an authorization. */
        | 'unsigned'
        /** Signed by a key this runtime does not accept as a operator key. */
        | 'unknown-key'
        | 'bad-signature'
        /** Already consumed by an earlier write. */
        | 'replayed';
    };

/**
 * E6.4: an explicit, revocable authorization to cross a DATA DOMAIN boundary
 * (design-dataDomain §8.3). Two things it is NOT:
 *  - it never loosens the enterprise tenant hierarchy (that is structural);
 *  - it is not the E3.5 write credential — a operator still signs a
 *    OperatorWriteGrant for a specific enterprise write. This one says "this
 *    subject may touch that domain at all", the other says "this write is
 *    authorized".
 * Direction is one-way: personal -> enterprise only. Enterprise -> personal has
 * no grant shape, because there is no code path that could produce one.
 */
export type DomainGrant = {
  kind: 'domain-access';
  grantId: string;
  /** Subject identifier: a executor name, an agent id, or a department id. */
  subject: string;
  /** DataDomain the subject wants to reach; must be an enterprise dataDomain. */
  dataDomainId: string;
  access: DataDomainAccess;
  grantedBy: string;
  reason?: string;
  grantedAt: string;
  expiresAt?: string;
  nonce: string;
};

export type DomainDecision =
  | { ok: true; via: 'same-domain' | 'tenant-hierarchy' | 'grant'; grantId?: string }
  | {
      ok: false;
      reason:
        | 'unknown-dataDomain'
        | 'dataDomain-type-mismatch'
        | 'enterprise-to-personal'
        | 'tenant-out-of-scope'
        | 'no-grant'
        | 'grant-expired'
        | 'access-not-granted'
        | 'read-only';
      detail: string;
    };

export interface DataDomainStore {
  connect(
    root: string,
    type: DataDomainType,
    opts?: { readOnly?: boolean; tenant?: string | TenantScope },
  ): Promise<DataDomainManifest>;
  manifest(dataDomainId: string): Promise<DataDomainManifest>;
  search(dataDomainId: string, query: SearchQuery): Promise<DataDomainHit[]>;
  read(dataDomainId: string, itemId: string): Promise<DataDomainItem>;
  /** G4: connect-time parameters of every connected dataDomain, for persistence. */
  connections(): DataDomainConnection[];
  /**
   * deferred #17: tear down a mounted dataDomain at runtime. Removes it from the
   * in-memory mount tables so the next snapshot no longer persists it. This is
   * the explicit path that previously forced an operator to hand-edit
   * runtime.json (or drop state) to remove a dataDomain.
   */
  disconnect(dataDomainId: string): Promise<void>;
  /**
   * deferred #17: re-scope an enterprise dataDomain's tenant. Compare-swap: `from`
   * must match the currently mounted tenant, otherwise the call is refused as
   * drift (so a stale `from` can never silently move a boundary). Updates the
   * in-memory manifest; persistence follows on the next snapshot save.
   */
  retargetTenant(dataDomainId: string, from: string | TenantScope, to: string | TenantScope): Promise<void>;
  /** Read-only enumeration of every managed entry from the connect snapshot
   *  (with full content), powering Backup map drawing and full bundles. */
  entries(dataDomainId: string): Promise<DataDomainEntrySnapshot[]>;
  /**
   * E3.5 write path. Personal dataDomains allow writes by default; a dataDomain
   * connected readOnly refuses them. Enterprise writes require a valid
   * OperatorWriteGrant (third argument). Writes stay inside the same path /
   * text-extension / size guards as reads and are applied atomically.
   */
  write?(
    dataDomainId: string,
    item: DataDomainWriteItem,
    grant?: OperatorWriteGrant,
  ): Promise<DataDomainWriteResult>;
}

/** G4: everything needed to reconnect a dataDomain after restart. The search index
 *  is rebuilt on reconnect, so only the connect parameters are persisted. */
export type DataDomainConnection = {
  root: string;
  dataDomainId: string;
  type: DataDomainType;
  readOnly: boolean;
  /** E3.6: carried so a restart restores the tenant boundary, not just the mount. */
  tenant?: TenantScope;
};

export class DataDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataDomainError';
  }
}

/** Invariant 2: connect before use. */
export class DataDomainNotConnectedError extends DataDomainError {
  constructor(message: string) {
    super(message);
    this.name = 'DataDomainNotConnectedError';
  }
}

/** itemId must stay inside the dataDomain root (path-traversal / symlink escape). */
export class InvalidItemIdError extends DataDomainError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidItemIdError';
  }
}

/** Query capability not available in P0 (e.g. tag search). */
export class UnsupportedQueryError extends DataDomainError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedQueryError';
  }
}

/** E3.5: an enterprise-dataDomain write lacks a valid operator grant, or a read-only
 *  dataDomain was asked to write. */
export class UnauthorizedDataDomainWriteError extends DataDomainError {
  /**
   * Machine-readable refusal reason (grant-missing / grant-bad-signature / ...,
   * or dataDomain-read-only). Every face that has to report a refusal reads this
   * instead of parsing the message: a prose message is for humans, and the
   * reason is what a client branches on.
   */
  readonly reason: string;
  constructor(message: string, reason = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedDataDomainWriteError';
    this.reason = reason;
  }
}

/** E3.5: a write asks for a capability the P0 filesystem backend cannot honor
 *  (e.g. persisting tags, non-text payloads/paths). */
export class UnsupportedWriteError extends DataDomainError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWriteError';
  }
}

import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestManifest, sha256Hex } from './digest.js';
import { verifyOperatorWriteGrant, type OperatorGrantLedger } from './grant.js';
import { formatTenant, normalizeTenant, tenantKey } from './tenant.js';
import type { RosterVerifier } from '../registry/signing.js';
import type { OperatorWriteGrant, DataDomainConnection, DataDomainEntrySnapshot, DataDomainHit, DataDomainItem, DataDomainManifest, DataDomainStore, DataDomainType, TenantScope, DataDomainWriteItem, DataDomainWriteResult, SearchQuery } from './types.js';
import {
  InvalidItemIdError,
  DataDomainError,
  DataDomainNotConnectedError,
  UnauthorizedDataDomainWriteError,
  UnsupportedQueryError,
  UnsupportedWriteError,
} from './types.js';

/** Audit record for one accepted write (rejected writes throw before this). */
export type DataDomainWriteAuditEntry = {
  dataDomainId: string;
  /** The dataDomain's real type, so the trail cannot mislabel a personal write as an authorized one. */
  dataDomainType: DataDomainType;
  itemId: string;
  bytes: number;
  at: string;
  /** Set when an enterprise write was authorized by a operator grant. */
  grantedBy?: string;
};

export type FsDataDomainStoreOptions = {
  /** Receives one entry per successful write (E3.5 audit trail). */
  audit?: (entry: DataDomainWriteAuditEntry) => void;
  /**
   * Injected clock. It exists because expiry is a security check: with the wall
   * clock hardcoded, a test could only ever write `expiresAt: 2099-...` and the
   * "expired grant is refused" path was untestable - so it was unverified.
   */
  now?: () => Date;
  /**
   * Operator authority for enterprise writes (deferred #14). With a verifier, a
   * grant must carry a signature by an accepted operator key and its nonce is
   * consumed; without one, only shape/binding/expiry are checked - which is why
   * the runtime warns when it boots a writable enterprise dataDomain with no verifier.
   */
  operatorGrants?: OperatorGrantAuthority;
  /**
   * Upper bounds on the connect-time snapshot. The scan holds every managed
   * item's full text in memory for the lifetime of the mount, so an unbounded
   * walk lets one large directory tree decide the runtime's memory footprint.
   * Truncation is recorded in `manifest.skipped` rather than passed off as a
   * complete snapshot.
   */
  scanLimits?: { maxItems?: number; maxTotalBytes?: number };
};

export type OperatorGrantAuthority = {
  verifier?: RosterVerifier;
  acceptedKeyIds?: string[];
  ledger?: OperatorGrantLedger;
};

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.org', '.rst',
  '.json', '.jsonl', '.csv', '.yaml', '.yml', '.toml', '.xml', '.html', '.css',
  '.ts', '.js', '.mjs', '.cjs', '.py', '.go', '.java', '.rs', '.c', '.h', '.cpp', '.sh', '.sql', '.log',
]);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MAX_SCAN_ITEMS = 5_000;
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024; // 256 MiB

type ScannedItem = { itemId: string; content: string; modifiedAt: string };
type Skipped = { itemId: string; reason: string };

type StoredDataDomain = {
  dataDomainId: string;
  type: DataDomainType;
  root: string;
  readOnly: boolean;
  manifest: DataDomainManifest;
  /** Connect-time snapshot powering search; read() always hits disk fresh. */
  items: ScannedItem[];
};

/**
 * Filesystem DataDomain store (design-dataDomain.md §5): in-process, personal and
 * enterprise dataDomains. Search runs over the connect-time snapshot (index
 * semantics, consistent with contentDigest); read() reads disk live (the
 * recovery protocol must return current bytes). Writes are E3.5: personal by
 * default, enterprise only behind a operator grant. No transport — the MCP face
 * wraps this (design-dataDomain §6.1).
 */
export class FsDataDomainStore implements DataDomainStore {
  private dataDomains = new Map<string, StoredDataDomain>();
  private roots = new Map<string, string>(); // realpath root -> dataDomainId

  constructor(private readonly options: FsDataDomainStoreOptions = {}) {}

  /** Every timestamp this store produces or compares goes through here, so a
   *  deployment (and a test) can put the write gate on a controlled clock. */
  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  async connect(
    root: string,
    type: DataDomainType,
    opts: { readOnly?: boolean; tenant?: string | TenantScope } = {},
  ): Promise<DataDomainManifest> {
    // E3.6: only the enterprise domain has tenants. Refusing the combination
    // rather than ignoring it keeps "personal dataDomain" a type-level statement.
    const tenant = normalizeTenant(opts.tenant);
    if (tenant && type !== 'enterprise') {
      throw new DataDomainError(`a tenant scope belongs to an enterprise dataDomain, not '${type}': ${formatTenant(tenant)}`);
    }
    let absRoot: string;
    try {
      absRoot = await realpath(root);
    } catch (error) {
      throw new DataDomainError(`dataDomain root not accessible: ${root} (${(error as Error).message})`);
    }
    const rootStat = await stat(absRoot);
    if (!rootStat.isDirectory()) throw new DataDomainError(`dataDomain root is not a directory: ${root}`);

    const existingId = this.roots.get(absRoot);
    const dataDomainId = existingId ?? `dataDomain-${sha256Hex(absRoot).slice(0, 16)}`;
    const previous = existingId ? this.dataDomains.get(existingId) : undefined;
    if (previous && previous.type !== type) {
      // The type is a boundary: a personal dataDomain is writable by default, while
      // the enterprise domain is gated by a operator grant. Letting a reconnect
      // switch the label would silently drop the gate (dataDomain §8.1).
      throw new DataDomainError(
        `reconnecting ${absRoot} would change its dataDomain type (${previous.type} -> ${type}); disconnect is not offered in this build`,
      );
    }
    if (previous && tenantKey(previous.manifest.tenant) !== tenantKey(tenant)) {
      throw new DataDomainError(
        `reconnecting ${absRoot} would change its tenant scope (${formatTenant(previous.manifest.tenant) || '(none)'} -> ${formatTenant(tenant) || '(none)'}); disconnect is not offered in this build`,
      );
    }

    const { items, skipped } = await this.scan(absRoot);
    const manifest: DataDomainManifest = {
      dataDomainId,
      type,
      ...(tenant ? { tenant } : {}),
      root: absRoot,
      createdAt: previous?.manifest.createdAt ?? new Date().toISOString(),
      contentDigest: digestManifest(items.map(item => ({ itemId: item.itemId, content: item.content }))),
      itemCount: items.length,
      ...(skipped.length ? { skipped } : {}),
      // P0 has no backup executor; read-only personal dataDomains start at 'none'.
      backup: { strategy: 'none' },
    };

    // readOnly only tightens: a dataDomain mounted read-only stays read-only across
    // every reconnect. Otherwise a later caller that omits the flag (the backup
    // live-source path, or a boot restore) would silently upgrade a snapshot's
    // read-only mount to writable.
    const readOnly = (previous?.readOnly ?? false) || (opts.readOnly ?? false);
    this.roots.set(absRoot, dataDomainId);
    this.dataDomains.set(dataDomainId, { dataDomainId, type, root: absRoot, readOnly, manifest, items });
    return structuredClone(manifest);
  }

  async manifest(dataDomainId: string): Promise<DataDomainManifest> {
    return structuredClone(this.requireDataDomain(dataDomainId).manifest);
  }

  async search(dataDomainId: string, query: SearchQuery): Promise<DataDomainHit[]> {
    const stored = this.requireDataDomain(dataDomainId);
    if (query.tags && query.tags.length > 0) {
      throw new UnsupportedQueryError('tag search is not supported in P0 (filesystem scan backend)');
    }
    let sinceMs: number | undefined;
    if (query.since !== undefined) {
      sinceMs = Date.parse(query.since);
      if (Number.isNaN(sinceMs)) throw new UnsupportedQueryError(`invalid since date: ${query.since}`);
    }
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const terms = (query.text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);

    const hits: DataDomainHit[] = [];
    for (const item of stored.items) {
      const modifiedMs = Date.parse(item.modifiedAt);
      if (sinceMs !== undefined && modifiedMs < sinceMs) continue;
      if (terms.length > 0) {
        const haystack = item.content.toLowerCase();
        if (!terms.every(term => haystack.includes(term))) continue;
      }
      hits.push({ itemId: item.itemId, tags: [], snippet: snippetFor(item.content, terms), modifiedAt: item.modifiedAt, dataDomainId });
    }
    hits.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
    return hits.slice(0, limit);
  }

  async read(dataDomainId: string, itemId: string): Promise<DataDomainItem> {
    const stored = this.requireDataDomain(dataDomainId);
    assertSafeItemId(itemId);
    const abs = resolve(stored.root, itemId);
    if (!isInsideRoot(stored.root, abs)) {
      throw new InvalidItemIdError(`itemId escapes the dataDomain root: ${itemId}`);
    }
    let st;
    try {
      st = await lstat(abs);
    } catch {
      throw new InvalidItemIdError(`item not found: ${itemId}`);
    }
    if (st.isSymbolicLink()) throw new InvalidItemIdError(`symlink reads are refused in P0: ${itemId}`);
    if (!st.isFile()) throw new InvalidItemIdError(`not a regular file: ${itemId}`);
    if (st.size > MAX_FILE_BYTES) throw new InvalidItemIdError(`item exceeds ${MAX_FILE_BYTES}-byte limit: ${itemId}`);
    if (!TEXT_EXTENSIONS.has(extname(itemId).toLowerCase())) {
      throw new InvalidItemIdError(`unsupported file type: ${itemId}`);
    }
    // Realpath check defeats symlinked parent directories escaping the root.
    const real = await realpath(abs);
    if (!isInsideRoot(stored.root, real)) {
      throw new InvalidItemIdError(`itemId resolves outside the dataDomain root: ${itemId}`);
    }
    const content = await readFile(abs, 'utf8');
    return { itemId: toPosix(relative(stored.root, real)), content, modifiedAt: st.mtime.toISOString(), bytes: Buffer.byteLength(content, 'utf8') };
  }

  connections(): DataDomainConnection[] {
    return [...this.dataDomains.values()].map(stored => ({
      root: stored.root,
      dataDomainId: stored.dataDomainId,
      type: stored.type,
      readOnly: stored.readOnly,
      ...(stored.manifest.tenant ? { tenant: stored.manifest.tenant } : {}),
    }));
  }

  async disconnect(dataDomainId: string): Promise<void> {
    const stored = this.dataDomains.get(dataDomainId);
    if (!stored) throw new DataDomainNotConnectedError(`dataDomain not connected: ${dataDomainId} (connect before use)`);
    this.roots.delete(stored.root);
    this.dataDomains.delete(dataDomainId);
  }

  async retargetTenant(dataDomainId: string, from: string | TenantScope, to: string | TenantScope): Promise<void> {
    const stored = this.requireDataDomain(dataDomainId);
    if (stored.type !== 'enterprise') {
      throw new DataDomainError(`only an enterprise dataDomain carries a tenant scope, not '${stored.type}': ${dataDomainId}`);
    }
    const fromScope = normalizeTenant(from);
    const toScope = normalizeTenant(to);
    if (!fromScope || !toScope) {
      throw new DataDomainError('retarget requires both a "from" and a "to" tenant scope');
    }
    if (tenantKey(stored.manifest.tenant) !== tenantKey(fromScope)) {
      throw new DataDomainError(
        `tenant drift: dataDomain ${dataDomainId} is at '${formatTenant(stored.manifest.tenant)}', not '${formatTenant(fromScope)}'; retarget aborted (compare-swap)`,
      );
    }
    stored.manifest = { ...stored.manifest, tenant: toScope };
  }

  async entries(dataDomainId: string): Promise<DataDomainEntrySnapshot[]> {
    const stored = this.requireDataDomain(dataDomainId);
    return stored.items.map(item => ({
      itemId: item.itemId,
      content: item.content,
      modifiedAt: item.modifiedAt,
      bytes: Buffer.byteLength(item.content, 'utf8'),
    }));
  }

  /**
   * E3.5 write (design-dataDomain.md §2/§3). Personal dataDomains allow writes by
   * default; readOnly dataDomains refuse; enterprise dataDomains require a valid operator
   * grant. Payload is text or JSON-serializable, lands at a whitelisted
   * text-extension path inside the root, is written atomically (tmp+rename),
   * and the connect snapshot + contentDigest are refreshed so search and the
   * Backup map see the new content immediately.
   */
  async write(dataDomainId: string, item: DataDomainWriteItem, grant?: OperatorWriteGrant): Promise<DataDomainWriteResult> {
    const stored = this.requireDataDomain(dataDomainId);
    if (stored.readOnly) {
      throw new UnauthorizedDataDomainWriteError(
        `dataDomain was connected read-only; write refused: ${dataDomainId}`,
        'dataDomain-read-only',
      );
    }
    if (item.tags && item.tags.length > 0) {
      throw new UnsupportedWriteError('tags are not persisted by the P0 filesystem backend (tag-capable backend is P1)');
    }

    const { text, itemId } = prepareWrite(item, () => this.now());
    assertSafeItemId(itemId);
    if (!TEXT_EXTENSIONS.has(extname(itemId).toLowerCase())) {
      throw new UnsupportedWriteError(`unsupported file type for write: ${itemId}`);
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new UnsupportedWriteError(`payload exceeds ${MAX_FILE_BYTES}-byte limit: ${itemId}`);
    }

    const abs = resolve(stored.root, itemId);
    if (!isInsideRoot(stored.root, abs)) {
      throw new InvalidItemIdError(`itemId escapes the dataDomain root: ${itemId}`);
    }
    // Refuse an existing symlink / directory target and verify realpath.
    try {
      const existing = await lstat(abs);
      if (existing.isSymbolicLink()) throw new InvalidItemIdError(`symlink writes are refused: ${itemId}`);
      if (!existing.isFile()) throw new InvalidItemIdError(`target exists and is not a regular file: ${itemId}`);
      const realTarget = await realpath(abs);
      if (!isInsideRoot(stored.root, realTarget)) {
        throw new InvalidItemIdError(`itemId resolves outside the dataDomain root: ${itemId}`);
      }
    } catch (error) {
      if (error instanceof InvalidItemIdError) throw error;
      // ENOENT → new file, that is expected.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // Everything above this line is shape/size/path validation, and it runs
    // BEFORE the enterprise grant is consumed: a write that cannot be honored
    // must not burn the single-use operator authorization it arrived with.
    if (stored.type === 'enterprise') {
      const verification = await verifyOperatorWriteGrant(grant, dataDomainId, {
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.operatorGrants ?? {}),
      });
      if (!verification.ok) {
        throw new UnauthorizedDataDomainWriteError(
          `enterprise write requires a valid operator grant (${verification.reason}): ${dataDomainId}`,
          `grant-${verification.reason}`,
        );
      }
    }

    const parent = dirname(abs);
    const realParent = await prepareParentDir(stored.root, parent, itemId);

    // Atomic write: exclusive temp file in the same directory, then rename.
    const tmp = join(realParent, `.${basename(abs)}.zeus-tmp-${randomUUID().slice(0, 8)}`);
    // Owner-only: a dataDomain can hold personal or enterprise data, so the temp
    // file (and the inode the rename publishes) must never be group/world
    // readable, even under a permissive umask.
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await rename(tmp, abs);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }

    const finalStat = await lstat(abs);
    const modifiedAt = finalStat.mtime.toISOString();

    // Refresh the connect-time snapshot and manifest digest for consistency.
    const snapshot: ScannedItem = { itemId, content: text, modifiedAt };
    const existingIndex = stored.items.findIndex(candidate => candidate.itemId === itemId);
    if (existingIndex >= 0) stored.items[existingIndex] = snapshot;
    else stored.items.push(snapshot);
    stored.manifest = {
      ...stored.manifest,
      contentDigest: digestManifest(stored.items.map(candidate => ({ itemId: candidate.itemId, content: candidate.content }))),
      itemCount: stored.items.length,
    };

    this.options.audit?.({
      dataDomainId,
      dataDomainType: stored.type,
      itemId,
      bytes,
      at: modifiedAt,
      ...(grant ? { grantedBy: grant.grantedBy } : {}),
    });
    return { itemId };
  }

  private requireDataDomain(dataDomainId: string): StoredDataDomain {
    const stored = this.dataDomains.get(dataDomainId);
    if (!stored) throw new DataDomainNotConnectedError(`dataDomain not connected: ${dataDomainId} (connect before use)`);
    return stored;
  }

  private async scan(root: string): Promise<{ items: ScannedItem[]; skipped: Skipped[] }> {
    const items: ScannedItem[] = [];
    const skipped: Skipped[] = [];
    const maxItems = this.options.scanLimits?.maxItems ?? DEFAULT_MAX_SCAN_ITEMS;
    const maxBytes = this.options.scanLimits?.maxTotalBytes ?? DEFAULT_MAX_SCAN_BYTES;
    let totalBytes = 0;
    let stopped = false;

    const walk = async (dir: string, relDir: string): Promise<void> => {
      if (stopped) return;
      // A dataDomain whose snapshot is cut short must say so: a silent partial index
      // reads exactly like a small dataDomain, and search would quietly miss content.
      const stop = (bound: string): void => {
        stopped = true;
        skipped.push({
          itemId: relDir || '.',
          reason: `scan stopped at the ${bound} bound (${items.length} items, ${totalBytes} bytes); snapshot is truncated and the rest of the dataDomain is not indexed`,
        });
      };
      const dirents = await readdir(dir, { withFileTypes: true });
      for (const dirent of dirents) {
        if (stopped) return;
        const itemId = posix.join(relDir, dirent.name);
        if (dirent.isSymbolicLink()) {
          skipped.push({ itemId, reason: 'symlink skipped (P0 does not follow links)' });
          continue;
        }
        if (dirent.isDirectory()) {
          if (dirent.name.startsWith('.') || EXCLUDED_DIR_NAMES.has(dirent.name)) continue;
          await walk(join(dir, dirent.name), itemId);
        } else if (dirent.isFile()) {
          if (dirent.name.startsWith('.')) {
            skipped.push({ itemId, reason: 'hidden file skipped' });
            continue;
          }
          const ext = extname(dirent.name).toLowerCase();
          if (!TEXT_EXTENSIONS.has(ext)) {
            skipped.push({ itemId, reason: `unsupported extension '${ext || '<none>'}'` });
            continue;
          }
          const abs = join(dir, dirent.name);
          const st = await lstat(abs);
          if (st.size > MAX_FILE_BYTES) {
            skipped.push({ itemId, reason: `size ${st.size} exceeds ${MAX_FILE_BYTES} bytes` });
            continue;
          }
          if (items.length >= maxItems) {
            stop('item-count');
            return;
          }
          if (totalBytes + st.size > maxBytes) {
            stop('total-size');
            return;
          }
          const content = await readFile(abs, 'utf8');
          totalBytes += st.size;
          items.push({ itemId, content, modifiedAt: st.mtime.toISOString() });
        }
      }
    };

    await walk(root, '');
    return { items, skipped };
  }
}

function serializePayload(data: unknown): { text: string; ext: string } {
  if (typeof data === 'string') return { text: data, ext: '.md' };
  if (data === null || typeof data === 'number' || typeof data === 'boolean') {
    return { text: String(data), ext: '.txt' };
  }
  if (typeof data === 'object') {
    try {
      return { text: `${JSON.stringify(data, null, 2)}
`, ext: '.json' };
    } catch {
      throw new UnsupportedWriteError('write payload is not JSON-serializable');
    }
  }
  throw new UnsupportedWriteError(`unsupported write payload kind: ${typeof data}`);
}

function mintItemId(ext: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return posix.join('writes', `${stamp}-${randomUUID().slice(0, 8)}${ext}`);
}

function prepareWrite(item: DataDomainWriteItem, clock: () => Date): { text: string; itemId: string } {
  const { text, ext } = serializePayload(item.data);
  const itemId = item.itemId ?? mintItemId(ext, clock());
  return { text, itemId };
}

function assertSafeItemId(itemId: string): void {
  if (!itemId || isAbsolute(itemId) || itemId.startsWith('/') || itemId.includes('\\')) {
    throw new InvalidItemIdError(`itemId must be a root-relative POSIX path: ${String(itemId)}`);
  }
  const parts = itemId.split('/');
  if (parts.includes('..') || parts.includes('')) {
    throw new InvalidItemIdError(`unsafe itemId (traversal or empty segment): ${itemId}`);
  }
}

/**
 * Verify the directory a write lands in resolves inside the root, then create
 * it. Order matters: `mkdir({recursive:true})` walks through symlinked
 * ancestors, so a check placed after the mkdir would be preceded by the very
 * directory creation it is meant to prevent - a symlinked directory inside the
 * root would get a tree built outside it before the guard ever ran. The deepest
 * ancestor that already exists is therefore resolved and checked first.
 */
async function prepareParentDir(root: string, parent: string, itemId: string): Promise<string> {
  let existing = parent;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const up = dirname(existing);
      if (up === existing) throw new InvalidItemIdError(`no dataDomain-root ancestor for: ${itemId}`);
      existing = up;
    }
  }
  if (!isInsideRoot(root, await realpath(existing))) {
    throw new InvalidItemIdError(`target directory resolves outside the dataDomain root: ${itemId}`);
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const realParent = await realpath(parent);
  if (!isInsideRoot(root, realParent)) {
    throw new InvalidItemIdError(`target directory resolves outside the dataDomain root: ${itemId}`);
  }
  return realParent;
}

function isInsideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toPosix(pathName: string): string {
  return pathName.split(sep).join('/');
}

function snippetFor(content: string, terms: string[]): string {
  const lines = content.split(/\r?\n/);
  if (terms.length === 0) return (lines.find(line => line.trim().length > 0) ?? '').slice(0, 200);
  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i]!.toLowerCase();
    if (terms.some(term => lower.includes(term))) {
      const line = lines[i]!.trim();
      return line.length > 200 ? `${line.slice(0, 200)}…` : line;
    }
  }
  return '';
}

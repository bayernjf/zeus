import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { digestManifest, sha256Hex } from './digest.js';
import type { RealmHit, RealmItem, RealmManifest, RealmStore, RealmType, SearchQuery } from './types.js';
import {
  InvalidItemIdError,
  RealmError,
  RealmNotConnectedError,
  UnsupportedQueryError,
  UnsupportedRealmTypeError,
} from './types.js';

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.org', '.rst',
  '.json', '.jsonl', '.csv', '.yaml', '.yml', '.toml', '.xml', '.html', '.css',
  '.ts', '.js', '.mjs', '.cjs', '.py', '.go', '.java', '.rs', '.c', '.h', '.cpp', '.sh', '.sql', '.log',
]);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ScannedItem = { itemId: string; content: string; modifiedAt: string };
type Skipped = { itemId: string; reason: string };

type StoredRealm = {
  realmId: string;
  type: 'personal';
  root: string;
  readOnly: boolean;
  manifest: RealmManifest;
  /** Connect-time snapshot powering search; read() always hits disk fresh. */
  items: ScannedItem[];
};

/**
 * P0 Realm store (design-realm.md §5): in-process, read-only, personal realms.
 * Search runs over the connect-time snapshot (index semantics, consistent
 * with contentDigest); read() reads disk live (recovery protocol must return
 * current bytes). No transport — P1 wraps this as an MCP server.
 */
export class FsRealmStore implements RealmStore {
  private realms = new Map<string, StoredRealm>();
  private roots = new Map<string, string>(); // realpath root -> realmId

  async connect(root: string, type: RealmType, opts: { readOnly?: boolean } = {}): Promise<RealmManifest> {
    if (type !== 'personal') {
      throw new UnsupportedRealmTypeError(`realm type '${type}' is P1; P0 supports personal realms only`);
    }
    let absRoot: string;
    try {
      absRoot = await realpath(root);
    } catch (error) {
      throw new RealmError(`realm root not accessible: ${root} (${(error as Error).message})`);
    }
    const rootStat = await stat(absRoot);
    if (!rootStat.isDirectory()) throw new RealmError(`realm root is not a directory: ${root}`);

    const existingId = this.roots.get(absRoot);
    const realmId = existingId ?? `realm-${sha256Hex(absRoot).slice(0, 16)}`;
    const previous = existingId ? this.realms.get(existingId) : undefined;

    const { items, skipped } = await this.scan(absRoot);
    const manifest: RealmManifest = {
      realmId,
      type,
      root: absRoot,
      createdAt: previous?.manifest.createdAt ?? new Date().toISOString(),
      contentDigest: digestManifest(items.map(item => ({ itemId: item.itemId, content: item.content }))),
      itemCount: items.length,
      ...(skipped.length ? { skipped } : {}),
      // P0 has no backup executor; read-only personal realms start at 'none'.
      backup: { strategy: 'none' },
    };

    this.roots.set(absRoot, realmId);
    this.realms.set(realmId, { realmId, type: 'personal', root: absRoot, readOnly: opts.readOnly ?? false, manifest, items });
    return structuredClone(manifest);
  }

  async manifest(realmId: string): Promise<RealmManifest> {
    return structuredClone(this.requireRealm(realmId).manifest);
  }

  async search(realmId: string, query: SearchQuery): Promise<RealmHit[]> {
    const stored = this.requireRealm(realmId);
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

    const hits: RealmHit[] = [];
    for (const item of stored.items) {
      const modifiedMs = Date.parse(item.modifiedAt);
      if (sinceMs !== undefined && modifiedMs < sinceMs) continue;
      if (terms.length > 0) {
        const haystack = item.content.toLowerCase();
        if (!terms.every(term => haystack.includes(term))) continue;
      }
      hits.push({ itemId: item.itemId, tags: [], snippet: snippetFor(item.content, terms), modifiedAt: item.modifiedAt });
    }
    hits.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
    return hits.slice(0, limit);
  }

  async read(realmId: string, itemId: string): Promise<RealmItem> {
    const stored = this.requireRealm(realmId);
    assertSafeItemId(itemId);
    const abs = resolve(stored.root, itemId);
    if (!isInsideRoot(stored.root, abs)) {
      throw new InvalidItemIdError(`itemId escapes the realm root: ${itemId}`);
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
      throw new InvalidItemIdError(`itemId resolves outside the realm root: ${itemId}`);
    }
    const content = await readFile(abs, 'utf8');
    return { itemId: toPosix(relative(stored.root, real)), content, modifiedAt: st.mtime.toISOString(), bytes: Buffer.byteLength(content, 'utf8') };
  }

  private requireRealm(realmId: string): StoredRealm {
    const stored = this.realms.get(realmId);
    if (!stored) throw new RealmNotConnectedError(`realm not connected: ${realmId} (connect before use)`);
    return stored;
  }

  private async scan(root: string): Promise<{ items: ScannedItem[]; skipped: Skipped[] }> {
    const items: ScannedItem[] = [];
    const skipped: Skipped[] = [];

    const walk = async (dir: string, relDir: string): Promise<void> => {
      const dirents = await readdir(dir, { withFileTypes: true });
      for (const dirent of dirents) {
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
          const content = await readFile(abs, 'utf8');
          items.push({ itemId, content, modifiedAt: st.mtime.toISOString() });
        }
      }
    };

    await walk(root, '');
    return { items, skipped };
  }
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
    const lower = lines[i].toLowerCase();
    if (terms.some(term => lower.includes(term))) {
      const line = lines[i].trim();
      return line.length > 200 ? `${line.slice(0, 200)}…` : line;
    }
  }
  return '';
}

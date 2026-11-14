import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import {
  InvalidItemIdError,
  DataDomainError,
  DataDomainNotConnectedError,
  UnsupportedQueryError,
} from '../src/dataDomain/types.js';

describe('FsDataDomainStore P0', () => {
  let sandbox: string;
  let root: string;
  // Windows denies symlink creation without admin rights or Developer Mode;
  // when unavailable the fixture omits link.md and symlink-specific assertions
  // degrade (the security boundary stays covered on CI / capable platforms).
  let symlinksSupported = true;

  beforeEach(() => {
    symlinksSupported = true;
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-dataDomain-'));
    root = join(sandbox, 'dataDomain');
    mkdirSync(join(root, 'notes'), { recursive: true });
    mkdirSync(join(root, 'code'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'notes', 'diary.md'), '# Diary\nhello world\nsecret project zeus\n');
    writeFileSync(join(root, 'notes', 'todo.txt'), 'buy milk\n');
    writeFileSync(join(root, 'code', 'app.ts'), 'const x = 1;\n');
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, 'big.md'), Buffer.alloc(1024 * 1024 + 1, 0x61));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n');
    // symlink escaping the root
    writeFileSync(join(sandbox, 'outside.md'), 'outside secret\n');
    try {
      symlinkSync('../outside.md', join(root, 'link.md'));
    } catch {
      symlinksSupported = false;
    }
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('connects a personal dataDomain: stable id, manifest baseline, managed items and skip list', async () => {
    const store = new FsDataDomainStore();
    const manifest = await store.connect(root, 'personal');

    expect(manifest.type).toBe('personal');
    expect(manifest.root).toBe(realpathSync(root)); // connect stores the resolved realpath
    expect(manifest.itemCount).toBe(3);
    expect(manifest.backup.strategy).toBe('none');
    expect(manifest.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    const expectedSkipped = symlinksSupported ? ['big.md', 'image.png', 'link.md'] : ['big.md', 'image.png'];
    expect(manifest.skipped?.map(s => s.itemId).sort()).toEqual(expectedSkipped);
    const skipReasons = Object.fromEntries(manifest.skipped!.map(s => [s.itemId, s.reason]));
    expect(skipReasons['image.png']).toContain('extension');
    expect(skipReasons['big.md']).toContain('exceeds');
    if (symlinksSupported) expect(skipReasons['link.md']).toContain('symlink');

    // idempotent reconnect: same dataDomainId and createdAt, fresh digest
    const again = await store.connect(root, 'personal');
    expect(again.dataDomainId).toBe(manifest.dataDomainId);
    expect(again.createdAt).toBe(manifest.createdAt);
    expect(again.contentDigest).toBe(manifest.contentDigest);

    // dataDomainId derives from the realpath and is stable across store instances
    const otherStore = new FsDataDomainStore();
    const otherManifest = await otherStore.connect(root, 'personal');
    expect(otherManifest.dataDomainId).toBe(manifest.dataDomainId);
  });

  it('bounds the snapshot and says so instead of silently indexing a partial dataDomain', async () => {
    const store = new FsDataDomainStore({ scanLimits: { maxItems: 2 } });
    const manifest = await store.connect(root, 'personal');
    expect(manifest.itemCount).toBe(2);
    expect(manifest.skipped?.some(s => s.reason.includes('scan stopped at the item-count bound'))).toBe(true);
    // The partial snapshot is what search sees, and the truncation is visible
    // rather than being mistaken for a small dataDomain.
    expect(await store.search(manifest.dataDomainId, {})).toHaveLength(2);

    const byteBound = new FsDataDomainStore({ scanLimits: { maxTotalBytes: 1 } });
    const truncated = await byteBound.connect(root, 'personal');
    expect(truncated.itemCount).toBe(0);
    expect(truncated.skipped?.some(s => s.reason.includes('total-size bound'))).toBe(true);
  });

  it('connects an enterprise dataDomain and refuses a root that does not exist', async () => {
    const store = new FsDataDomainStore();
    const enterprise = await store.connect(root, 'enterprise');
    expect(enterprise.type).toBe('enterprise');
    // the type is what the store remembers, not what it assumed at connect time
    expect(store.connections().find(c => c.dataDomainId === enterprise.dataDomainId)?.type).toBe('enterprise');

    await expect(store.connect(join(sandbox, 'nope'), 'personal')).rejects.toBeInstanceOf(DataDomainError);
  });

  it('digest changes when content changes after reconnect', async () => {
    const store = new FsDataDomainStore();
    const before = await store.connect(root, 'personal');
    appendFileSync(join(root, 'notes', 'diary.md'), 'a new line\n');
    const after = await store.connect(root, 'personal');
    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(after.dataDomainId).toBe(before.dataDomainId);
  });

  it('refuses a reconnect that would relabel a mounted dataDomain type', async () => {
    const store = new FsDataDomainStore();
    const personal = await store.connect(root, 'personal');
    await expect(store.connect(root, 'enterprise')).rejects.toThrow(/would change its dataDomain type/);
    // The mount is untouched: a refused reconnect must not have mutated it.
    expect(store.connections().find(c => c.dataDomainId === personal.dataDomainId)?.type).toBe('personal');

    const enterpriseStore = new FsDataDomainStore();
    await enterpriseStore.connect(root, 'enterprise');
    await expect(enterpriseStore.connect(root, 'personal')).rejects.toThrow(/would change its dataDomain type/);
  });

  it('keeps a read-only mount read-only across reconnects that omit the flag', async () => {
    const store = new FsDataDomainStore();
    const manifest = await store.connect(root, 'personal', { readOnly: true });
    // A later reconnect with no flag (backup live-source, boot restore) must not
    // silently promote the mount back to writable.
    await store.connect(root, 'personal');
    expect(store.connections().find(c => c.dataDomainId === manifest.dataDomainId)?.readOnly).toBe(true);
    await expect(store.write(manifest.dataDomainId, { data: 'x', itemId: 'notes/new.md' })).rejects.toThrow(
      /connected read-only/,
    );
  });

  it('enforces connect-before-use (invariant 2)', async () => {
    const store = new FsDataDomainStore();
    await expect(store.manifest('dataDomain-ghost')).rejects.toBeInstanceOf(DataDomainNotConnectedError);
    await expect(store.search('dataDomain-ghost', { text: 'x' })).rejects.toBeInstanceOf(DataDomainNotConnectedError);
    await expect(store.read('dataDomain-ghost', 'notes/diary.md')).rejects.toBeInstanceOf(DataDomainNotConnectedError);
  });

  it('searches the connect snapshot: case-insensitive AND terms, snippets, since, limit', async () => {
    const store = new FsDataDomainStore();
    const manifest = await store.connect(root, 'personal');

    const secret = await store.search(manifest.dataDomainId, { text: 'SECRET' });
    expect(secret.map(h => h.itemId)).toEqual(['notes/diary.md']);
    expect(secret[0]!.snippet).toContain('secret project zeus');
    expect(secret[0]!.tags).toEqual([]);

    const both = await store.search(manifest.dataDomainId, { text: 'secret zeus' });
    expect(both).toHaveLength(1);
    const missingOne = await store.search(manifest.dataDomainId, { text: 'secret nonexistent' });
    expect(missingOne).toHaveLength(0);

    const future = await store.search(manifest.dataDomainId, { text: '', since: new Date(Date.now() + 60_000).toISOString() });
    expect(future).toHaveLength(0);
    const past = await store.search(manifest.dataDomainId, { since: new Date(0).toISOString() });
    expect(past).toHaveLength(3);

    const limited = await store.search(manifest.dataDomainId, { limit: 1 });
    expect(limited).toHaveLength(1);

    await expect(store.search(manifest.dataDomainId, { tags: ['diary'] })).rejects.toBeInstanceOf(UnsupportedQueryError);
  });

  it('never indexes excluded directories or non-text files (invariant 1 boundary)', async () => {
    const store = new FsDataDomainStore();
    const manifest = await store.connect(root, 'personal');
    const gitContent = await store.search(manifest.dataDomainId, { text: 'refs/heads' });
    const depContent = await store.search(manifest.dataDomainId, { text: 'module.exports' });
    const binary = await store.search(manifest.dataDomainId, { text: 'PNG' });
    expect(gitContent).toHaveLength(0);
    expect(depContent).toHaveLength(0);
    expect(binary).toHaveLength(0);
  });

  it('read() hits disk live while search() stays on the connect snapshot', async () => {
    const store = new FsDataDomainStore();
    const manifest = await store.connect(root, 'personal');

    appendFileSync(join(root, 'notes', 'diary.md'), 'freshmarker-after-connect\n');
    const item = await store.read(manifest.dataDomainId, 'notes/diary.md');
    expect(item.content).toContain('freshmarker-after-connect');
    expect(item.itemId).toBe('notes/diary.md');
    expect(item.bytes).toBe(Buffer.byteLength(item.content, 'utf8'));

    // snapshot search does not see the post-connect edit until reconnect
    const stale = await store.search(manifest.dataDomainId, { text: 'freshmarker-after-connect' });
    expect(stale).toHaveLength(0);
    await store.connect(root, 'personal');
    const fresh = await store.search(manifest.dataDomainId, { text: 'freshmarker-after-connect' });
    expect(fresh).toHaveLength(1);
  });

  it('read() refuses path traversal, absolute paths, symlinks and unsupported types', async () => {
    const store = new FsDataDomainStore();
    const manifest = await store.connect(root, 'personal');

    await expect(store.read(manifest.dataDomainId, '../outside.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.dataDomainId, 'notes/../../outside.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.dataDomainId, join(root, 'notes', 'diary.md'))).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.dataDomainId, 'notes\\..\\..\\outside.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.dataDomainId, 'notes//diary.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    if (symlinksSupported) {
      await expect(store.read(manifest.dataDomainId, 'link.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    }
    await expect(store.read(manifest.dataDomainId, 'image.png')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.dataDomainId, 'notes/missing.md')).rejects.toBeInstanceOf(InvalidItemIdError);

    // a legitimate read still works after all the refused attempts
    const ok = await store.read(manifest.dataDomainId, 'notes/todo.txt');
    expect(ok.content).toContain('buy milk');
  });
});

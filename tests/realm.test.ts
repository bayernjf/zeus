import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import {
  InvalidItemIdError,
  RealmError,
  RealmNotConnectedError,
  UnsupportedQueryError,
  UnsupportedRealmTypeError,
} from '../src/realm/types.js';

describe('FsRealmStore P0', () => {
  let sandbox: string;
  let root: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-realm-'));
    root = join(sandbox, 'realm');
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
    symlinkSync('../outside.md', join(root, 'link.md'));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('connects a personal realm: stable id, manifest baseline, managed items and skip list', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'personal');

    expect(manifest.type).toBe('personal');
    expect(manifest.root).toBe(realpathSync(root)); // connect stores the resolved realpath
    expect(manifest.itemCount).toBe(3);
    expect(manifest.backup.strategy).toBe('none');
    expect(manifest.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.skipped?.map(s => s.itemId).sort()).toEqual(['big.md', 'image.png', 'link.md']);
    const skipReasons = Object.fromEntries(manifest.skipped!.map(s => [s.itemId, s.reason]));
    expect(skipReasons['image.png']).toContain('extension');
    expect(skipReasons['big.md']).toContain('exceeds');
    expect(skipReasons['link.md']).toContain('symlink');

    // idempotent reconnect: same realmId and createdAt, fresh digest
    const again = await store.connect(root, 'personal');
    expect(again.realmId).toBe(manifest.realmId);
    expect(again.createdAt).toBe(manifest.createdAt);
    expect(again.contentDigest).toBe(manifest.contentDigest);

    // realmId derives from the realpath and is stable across store instances
    const otherStore = new FsRealmStore();
    const otherManifest = await otherStore.connect(root, 'personal');
    expect(otherManifest.realmId).toBe(manifest.realmId);
  });

  it('refuses enterprise realms and non-existent roots (P0 scope)', async () => {
    const store = new FsRealmStore();
    await expect(store.connect(root, 'enterprise')).rejects.toBeInstanceOf(UnsupportedRealmTypeError);
    await expect(store.connect(join(sandbox, 'nope'), 'personal')).rejects.toBeInstanceOf(RealmError);
  });

  it('digest changes when content changes after reconnect', async () => {
    const store = new FsRealmStore();
    const before = await store.connect(root, 'personal');
    appendFileSync(join(root, 'notes', 'diary.md'), 'a new line\n');
    const after = await store.connect(root, 'personal');
    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(after.realmId).toBe(before.realmId);
  });

  it('enforces connect-before-use (invariant 2)', async () => {
    const store = new FsRealmStore();
    await expect(store.manifest('realm-ghost')).rejects.toBeInstanceOf(RealmNotConnectedError);
    await expect(store.search('realm-ghost', { text: 'x' })).rejects.toBeInstanceOf(RealmNotConnectedError);
    await expect(store.read('realm-ghost', 'notes/diary.md')).rejects.toBeInstanceOf(RealmNotConnectedError);
  });

  it('searches the connect snapshot: case-insensitive AND terms, snippets, since, limit', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'personal');

    const secret = await store.search(manifest.realmId, { text: 'SECRET' });
    expect(secret.map(h => h.itemId)).toEqual(['notes/diary.md']);
    expect(secret[0].snippet).toContain('secret project zeus');
    expect(secret[0].tags).toEqual([]);

    const both = await store.search(manifest.realmId, { text: 'secret zeus' });
    expect(both).toHaveLength(1);
    const missingOne = await store.search(manifest.realmId, { text: 'secret nonexistent' });
    expect(missingOne).toHaveLength(0);

    const future = await store.search(manifest.realmId, { text: '', since: new Date(Date.now() + 60_000).toISOString() });
    expect(future).toHaveLength(0);
    const past = await store.search(manifest.realmId, { since: new Date(0).toISOString() });
    expect(past).toHaveLength(3);

    const limited = await store.search(manifest.realmId, { limit: 1 });
    expect(limited).toHaveLength(1);

    await expect(store.search(manifest.realmId, { tags: ['diary'] })).rejects.toBeInstanceOf(UnsupportedQueryError);
  });

  it('never indexes excluded directories or non-text files (invariant 1 boundary)', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'personal');
    const gitContent = await store.search(manifest.realmId, { text: 'refs/heads' });
    const depContent = await store.search(manifest.realmId, { text: 'module.exports' });
    const binary = await store.search(manifest.realmId, { text: 'PNG' });
    expect(gitContent).toHaveLength(0);
    expect(depContent).toHaveLength(0);
    expect(binary).toHaveLength(0);
  });

  it('read() hits disk live while search() stays on the connect snapshot', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'personal');

    appendFileSync(join(root, 'notes', 'diary.md'), 'freshmarker-after-connect\n');
    const item = await store.read(manifest.realmId, 'notes/diary.md');
    expect(item.content).toContain('freshmarker-after-connect');
    expect(item.itemId).toBe('notes/diary.md');
    expect(item.bytes).toBe(Buffer.byteLength(item.content, 'utf8'));

    // snapshot search does not see the post-connect edit until reconnect
    const stale = await store.search(manifest.realmId, { text: 'freshmarker-after-connect' });
    expect(stale).toHaveLength(0);
    await store.connect(root, 'personal');
    const fresh = await store.search(manifest.realmId, { text: 'freshmarker-after-connect' });
    expect(fresh).toHaveLength(1);
  });

  it('read() refuses path traversal, absolute paths, symlinks and unsupported types', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(root, 'personal');

    await expect(store.read(manifest.realmId, '../outside.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.realmId, 'notes/../../outside.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.realmId, join(root, 'notes', 'diary.md'))).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.realmId, 'notes\\..\\..\\outside.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.realmId, 'notes//diary.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.realmId, 'link.md')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.realmId, 'image.png')).rejects.toBeInstanceOf(InvalidItemIdError);
    await expect(store.read(manifest.realmId, 'notes/missing.md')).rejects.toBeInstanceOf(InvalidItemIdError);

    // a legitimate read still works after all the refused attempts
    const ok = await store.read(manifest.realmId, 'notes/todo.txt');
    expect(ok.content).toContain('buy milk');
  });
});

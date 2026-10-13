import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertPublishedInsideRoot, writeFileAtomic } from '../src/vault/fs.js';
import { VaultFormatError } from '../src/vault/types.js';

let sandbox: string;
let root: string;

beforeEach(async () => {
  // macOS publishes tmpdir under a /var -> /private/var symlink; resolve it so
  // the fixture matches the production contract (roots are always realpath'd).
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'zeus-vfs-')));
  root = join(sandbox, 'root');
  await mkdir(root, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('publishes owner-only bytes and leaves no temp file behind', async () => {
    const file = join(root, 'sealed.json');
    await writeFileAtomic(file, '{"v":1}\n');
    await expect(readFile(file, 'utf8')).resolves.toBe('{"v":1}\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['sealed.json']);
  });

  it('overwrites a previously published file atomically', async () => {
    const file = join(root, 'sealed.json');
    await writeFileAtomic(file, 'old');
    await writeFileAtomic(file, 'new');
    await expect(readFile(file, 'utf8')).resolves.toBe('new');
    expect(await readdir(root)).toEqual(['sealed.json']);
  });
});

describe('assertPublishedInsideRoot', () => {
  it('accepts a regular file inside the root', async () => {
    const file = join(root, 'kernel.json');
    await writeFile(file, '{}');
    await expect(assertPublishedInsideRoot(root, file, 'restore item kernel.json')).resolves.toBeUndefined();
  });

  it('rejects when the published entry is a symlink', async () => {
    await writeFile(join(sandbox, 'outside.json'), 'outside');
    const file = join(root, 'link.json');
    await symlink(join(sandbox, 'outside.json'), file);
    await expect(assertPublishedInsideRoot(root, file, 'restore item link.json')).rejects.toBeInstanceOf(VaultFormatError);
  });

  it('rejects when the published entry is a directory', async () => {
    const dir = join(root, 'adir');
    await mkdir(dir);
    await expect(assertPublishedInsideRoot(root, dir, 'restore item adir')).rejects.toBeInstanceOf(VaultFormatError);
  });

  it('rejects a path that resolves outside the root', async () => {
    const outside = join(sandbox, 'outside.json');
    await writeFile(outside, 'outside');
    await expect(assertPublishedInsideRoot(root, outside, 'restore item outside.json')).rejects.toBeInstanceOf(VaultFormatError);
  });
});

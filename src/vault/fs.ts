import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { VaultFormatError } from './types.js';

/** Is `abs` inside `root` (or root itself)? Both must already be resolved absolute paths. */
export function isInsideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve and verify the directory an artifact lands in, then create it.
 *
 * The order is the point: `mkdir({recursive:true})` walks through symlinked
 * ancestors, so creating first and checking afterwards lets a symlink inside the
 * target root have a tree built outside it before the guard ever runs. The
 * deepest ancestor that already exists is therefore resolved and checked first.
 */
export async function ensureDirInsideRoot(root: string, parent: string, label: string): Promise<string> {
  let existing = parent;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const up = dirname(existing);
      if (up === existing) throw new VaultFormatError(`no existing ancestor for ${label}`);
      existing = up;
    }
  }
  if (!isInsideRoot(root, await realpath(existing))) {
    throw new VaultFormatError(`${label} resolves outside the target root`);
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const real = await realpath(parent);
  if (!isInsideRoot(root, real)) throw new VaultFormatError(`${label} resolves outside the target root`);
  return real;
}

/**
 * Publish a file atomically: an exclusive temp file in the same directory, then
 * a rename over the target. A plain `writeFile` truncates the target first, so a
 * process that dies mid-write leaves a half-written envelope behind - and for a
 * backup artifact that is the one file the operator cannot regenerate. The file
 * fsync makes the rename publish bytes that are actually on disk; the directory
 * fsync afterwards makes the rename itself survive a power loss (same contract
 * as KernelStateStore.save).
 *
 * Because the publish is a rename, a pre-existing symlink at the target path is
 * replaced rather than followed: the write can never land somewhere the caller
 * did not name.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const dir = dirname(filePath);
  const tmp = join(dir, `.${basename(filePath)}.zeus-tmp-${randomUUID().slice(0, 8)}`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  const dirHandle = await open(dir, 'r');
  try {
    await dirHandle.sync();
  } catch (error) {
    // Windows cannot fsync a directory handle (EPERM): the directory-fsync
    // durability contract is not expressible there, and NTFS journaling covers
    // the rename. Swallowing EPERM on win32 keeps every atomic-publish path
    // working on Windows while preserving the POSIX guarantee elsewhere.
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  } finally {
    await dirHandle.close();
  }
}

/**
 * Fail-closed revalidation immediately after a publish inside `root`: the
 * directory entry the rename produced must still be a non-symlinked regular
 * file whose resolved path stays inside `root`. The containment checks before a
 * restore write describe the tree before the syscall; this one describes the
 * entry that now exists, so a directory component swapped in the residual
 * check-to-rename window is reported instead of silently restoring outside the
 * target root.
 */
export async function assertPublishedInsideRoot(root: string, filePath: string, label: string): Promise<void> {
  const published = await lstat(filePath);
  if (published.isSymbolicLink() || !published.isFile()) {
    throw new VaultFormatError(`${label} did not publish as a regular file inside the target root`);
  }
  if (!isInsideRoot(root, await realpath(filePath))) {
    throw new VaultFormatError(`${label} resolves outside the target root after publish`);
  }
}

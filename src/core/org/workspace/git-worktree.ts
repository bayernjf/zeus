/**
 * F1.2 default workspace manager: one `git worktree` per task under
 * <root>/<orgId>/<taskId>, created from an allow-listed base repo.
 *
 * Security posture is fail-closed: the base repo is resolved through
 * realpathSync and must sit under one of `allowedRepos`; anything else throws
 * before a directory is created. The worktree target is additionally checked
 * to stay inside <root> so an odd organization/task id cannot escape it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import {
  type AcquiredWorkspace,
  type WorkspaceManager,
  type WorkspaceRequest,
  WorkspaceError,
} from './manager.js';

export interface GitWorktreeManagerOptions {
  /** Root under which <orgId>/<taskId> directories are created. */
  root: string;
  /** Absolute repo roots a task may branch worktrees from. */
  allowedRepos: string[];
}

export class GitWorktreeManager implements WorkspaceManager {
  private readonly root: string;
  private readonly allowedRepos: string[];
  private readonly repoByPath = new Map<string, string>();

  constructor(options: GitWorktreeManagerOptions) {
    // Resolve roots through realpath so macOS /var → /private/var symlinks do
    // not make an allow-listed repo look foreign at acquire time.
    this.root = realpathSync(resolve(options.root));
    this.allowedRepos = options.allowedRepos.map(repo => {
      try {
        return realpathSync(resolve(repo));
      } catch {
        return resolve(repo);
      }
    });
  }

  acquire(request: WorkspaceRequest): AcquiredWorkspace {
    const repo = this.assertAllowedRepo(request.baseRepo);
    const target = resolve(this.root, request.organizationId, request.taskId);
    if (!this.insideRoot(target)) {
      throw new WorkspaceError(`workspace path escapes root: ${target}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    this.git(repo, ['worktree', 'add', '--detach', target, request.baseRef ?? 'HEAD']);
    this.repoByPath.set(target, repo);
    return { path: target };
  }

  archive(path: string): string {
    if (!existsSync(path)) throw new WorkspaceError(`workspace not found: ${path}`);
    const artifact = `${path}.tar.gz`;
    execFileSync('tar', ['-czf', artifact, '-C', dirname(path), basename(path)], { stdio: 'pipe' });
    this.release(path);
    return artifact;
  }

  release(path: string): void {
    const repo = this.repoByPath.get(path);
    try {
      this.git(repo ?? path, ['worktree', 'remove', '--force', path]);
    } catch {
      // A worktree registry can be stale (process killed mid-run); fall back to
      // removing the directory so the task does not leak disk.
      rmSync(path, { recursive: true, force: true });
    }
    if (repo) {
      try {
        this.git(repo, ['worktree', 'prune']);
      } catch {
        // prune is housekeeping only; never fail a settlement over it.
      }
    }
    this.repoByPath.delete(path);
  }

  /** Realpath the repo, enforce the allow-list, and require a git checkout. */
  private assertAllowedRepo(baseRepo: string): string {
    let real: string;
    try {
      real = realpathSync(resolve(baseRepo));
    } catch {
      throw new WorkspaceError(`base repo does not exist: ${baseRepo}`);
    }
    const allowed = this.allowedRepos.some(
      root => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep),
    );
    if (!allowed) throw new WorkspaceError(`base repo outside allowed roots: ${baseRepo}`);
    try {
      this.git(real, ['rev-parse', '--git-dir']);
    } catch {
      throw new WorkspaceError(`base repo is not a git checkout: ${baseRepo}`);
    }
    return real;
  }

  private insideRoot(path: string): boolean {
    return path === this.root || path.startsWith(this.root + sep);
  }

  private git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  }
}

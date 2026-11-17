/**
 * F1.2 workspace isolation contract. A task may run inside an isolated
 * directory (today: a git worktree) so its writes never touch the base repo
 * checkout; settlement archives or discards it according to policy.
 *
 * The manager is synchronous on purpose: acquire runs during claim (one git
 * invocation per task) and archive/discard run at settlement, both low
 * frequency relative to task execution, so blocking that single dispatch call
 * is cheaper than threading an async boundary through the state machine.
 */
export interface WorkspaceRequest {
  organizationId: string;
  taskId: string;
  baseRepo: string;
  baseRef?: string;
}

export interface AcquiredWorkspace {
  /** Absolute path of the isolated directory. */
  path: string;
}

export type WorkspacePolicy = 'archive' | 'discard';

export interface WorkspaceManager {
  /** Create the isolated workspace; throws when the repo is not allowed. */
  acquire(request: WorkspaceRequest): AcquiredWorkspace;
  /** Pack the workspace and remove it; returns the artifact path. */
  archive(path: string): string;
  /** Remove the workspace without keeping anything. */
  release(path: string): void;
}

/** Raised when a workspace cannot be created (bad repo, escaping path, git). */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

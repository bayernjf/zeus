import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Cross-process advisory lock for one kernel state file (M-10).
 *
 * Two Zeus processes (a long-running server and a one-shot CLI, or two
 * servers) must never load-mutate-rename the same state file concurrently:
 * the last rename would silently overwrite the other process's roster,
 * idempotency and nonce changes. The lock is a sibling directory
 * `<stateFile>.lock/` whose creation is atomic (mkdir EEXIST), carrying one
 * owner.json record with pid/host metadata so a holder that died without
 * releasing (crash, SIGKILL, power loss) can be distinguished from a live
 * one. Acquire is fail-fast: a second boot refuses instead of queueing.
 */

export interface LockOwner {
  pid: number;
  host: string;
  startedAt: string;
  instanceId: string;
}

export class ProcessLockHeldError extends Error {
  /** Parsed owner record when one was present and readable, otherwise null. */
  readonly owner: LockOwner | null;

  constructor(message: string, owner: LockOwner | null = null) {
    super(message);
    this.name = 'ProcessLockHeldError';
    this.owner = owner;
  }
}

export interface ProcessLockAcquireOptions {
  now?: () => Date;
  localHost?: () => string;
}

const OWNER_FILE = 'owner.json';

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.host === 'string' &&
    typeof record.startedAt === 'string' &&
    typeof record.instanceId === 'string'
  );
}

/**
 * @returns a parsed owner record; `null` when the directory exists but the
 * owner record has not been published yet (holder died between mkdir and
 * publish). Throws ProcessLockHeldError on an unreadable/invalid record —
 * fail closed rather than guessing.
 */
function readOwner(lockPath: string): LockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(join(lockPath, OWNER_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProcessLockHeldError(
      `kernel state lock at ${lockPath} has a corrupt owner record (invalid JSON); refusing to guess whether it is stale: ${(err as Error).message}`,
    );
  }
  if (!isLockOwner(parsed)) {
    throw new ProcessLockHeldError(
      `kernel state lock at ${lockPath} has a corrupt owner record (missing pid/host/startedAt/instanceId fields); refusing to guess whether it is stale`,
    );
  }
  return parsed;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process, the holder is dead. EPERM: the process exists
    // but is owned by another user, so it counts as live. Anything else is
    // treated as live as well (fail closed).
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class ProcessLock {
  private constructor(
    private readonly lockPath: string,
    private readonly instanceId: string,
  ) {}

  /**
   * Acquire the lock at `lockPath`, creating the parent data directory
   * owner-only when needed. Reclaims a stale lock (dead pid, same-process
   * leftover, or unpublished owner record); refuses a live holder, a foreign
   * host, or a corrupt owner record with ProcessLockHeldError.
   */
  static async acquire(
    lockPath: string,
    options: ProcessLockAcquireOptions = {},
  ): Promise<ProcessLock> {
    const now = options.now ?? (() => new Date());
    const localHost = options.localHost ?? hostname;

    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

    try {
      mkdirSync(lockPath, { recursive: false, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const owner = readOwner(lockPath);
      if (owner !== null) {
        // A previous boot in this same process that never released always
        // yields to the current boot; pid liveness cannot distinguish them.
        if (owner.pid !== process.pid) {
          if (owner.host !== localHost()) {
            throw new ProcessLockHeldError(
              `kernel state lock at ${lockPath} is held on a different host (${owner.host}) by pid ${owner.pid} since ${owner.startedAt}; liveness cannot be probed across hosts`,
              owner,
            );
          }
          if (isPidAlive(owner.pid)) {
            throw new ProcessLockHeldError(
              `kernel state lock at ${lockPath} is held by a live process (pid ${owner.pid}, host ${owner.host}, since ${owner.startedAt})`,
              owner,
            );
          }
        }
        // Stale holder: fall through and republish this process as owner.
      }
    }

    const instanceId = randomUUID();
    const owner: LockOwner = {
      pid: process.pid,
      host: localHost(),
      startedAt: now().toISOString(),
      instanceId,
    };
    writeFileSync(join(lockPath, OWNER_FILE), JSON.stringify(owner, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return new ProcessLock(lockPath, instanceId);
  }

  /**
   * Release the lock, but only while the owner record is still the one this
   * handle published: a lock a newer instance already reclaimed must not be
   * deleted out from under it.
   */
  async release(): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(join(this.lockPath, OWNER_FILE), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let owner: unknown;
    try {
      owner = JSON.parse(raw);
    } catch {
      // Not our well-formed record anymore; leave the directory alone.
      return;
    }
    if (
      !isLockOwner(owner) ||
      owner.instanceId !== this.instanceId
    ) {
      return;
    }
    rmSync(this.lockPath, { recursive: true, force: true });
  }
}

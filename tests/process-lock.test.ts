import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessLock, ProcessLockHeldError } from '../src/state/process-lock.js';

// M-10: two Zeus processes pointed at one kernel state file both load, mutate
// and snapshot it; without a cross-process lock the last rename wins and the
// other process's roster/idempotency/nonce changes vanish. The lock is a
// directory holding one owner.json; acquire is fail-fast (a second boot must
// refuse, not queue), and a holder whose pid no longer exists is stale and gets
// reclaimed after a crash / kill -9.

function writeOwner(lockPath: string, owner: { pid: number; host: string; startedAt?: string; instanceId?: string }): void {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lockPath, 'owner.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), instanceId: randomUUID(), ...owner }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

const HOLDER_SOURCE = `
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const dir = process.env.LOCK_DIR;
fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
fs.writeFileSync(dir + '/owner.json', JSON.stringify({
  pid: process.pid,
  host: os.hostname(),
  startedAt: new Date().toISOString(),
  instanceId: crypto.randomUUID(),
}), { mode: 0o600 });
process.stdout.write('ready');
setTimeout(() => {}, 1_000_000);
`;

function spawnHolder(lockPath: string): ChildProcess {
  return spawn(process.execPath, ['-e', HOLDER_SOURCE], {
    env: { ...process.env, LOCK_DIR: lockPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('lock holder never reported ready'));
    }, 5_000);
    child.stdout!.on('data', chunk => {
      if (String(chunk).includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('close', () => resolve());
    child.on('error', reject);
  });
}

describe('ProcessLock cross-process kernel state lock', () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-process-lock-'));
  });

  afterEach(async () => {
    // A child whose 'close' already fired must not be awaited again: a late
    // one-shot listener never resolves.
    const pending = children.filter(c => c.exitCode === null && c.signalCode === null);
    for (const child of pending) child.kill('SIGKILL');
    await Promise.all(pending.map(exitOf));
    children.length = 0;
  });

  it('publishes an owner record on acquire and removes it on release', async () => {
    const lockPath = join(dir, 'data', 'kernel-state.json.lock');
    const lock = await ProcessLock.acquire(lockPath, { now: () => new Date('2026-10-13T08:00:00Z') });
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    expect(owner.pid).toBe(process.pid);
    expect(owner.startedAt).toBe('2026-10-13T08:00:00.000Z');
    expect(typeof owner.instanceId).toBe('string');

    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
    const again = await ProcessLock.acquire(lockPath);
    await again.release();
  });

  it('refuses while a live foreign process holds the lock, naming its pid', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    const holder = spawnHolder(lockPath);
    children.push(holder);
    await waitForReady(holder);

    await expect(ProcessLock.acquire(lockPath)).rejects.toMatchObject({
      name: 'ProcessLockHeldError',
      owner: expect.objectContaining({ pid: holder.pid }),
    });
    await expect(ProcessLock.acquire(lockPath)).rejects.toThrow(new RegExp(`pid ${holder.pid}`));
  });

  it('reclaims a lock whose holder was killed without releasing (crash / SIGKILL)', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    const holder = spawnHolder(lockPath);
    children.push(holder);
    await waitForReady(holder);
    holder.kill('SIGKILL');
    await exitOf(holder);

    const lock = await ProcessLock.acquire(lockPath);
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    expect(owner.pid).toBe(process.pid);
    await lock.release();
  });

  it('reclaims a leftover directory naming a pid that already exited', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = exited.pid!;
    await exitOf(exited);

    writeOwner(lockPath, { pid: deadPid, host: hostname() });

    const lock = await ProcessLock.acquire(lockPath);
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    expect(owner.pid).toBe(process.pid);
    await lock.release();
  });

  it('reclaims a leftover lock owned by this same process (a previous boot did not release)', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    writeOwner(lockPath, { pid: process.pid, host: 'irrelevant' });
    const lock = await ProcessLock.acquire(lockPath);
    await lock.release();
  });

  it('fails closed on a corrupt owner record instead of guessing', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, 'owner.json'), '{ not json', 'utf8');
    await expect(ProcessLock.acquire(lockPath)).rejects.toBeInstanceOf(ProcessLockHeldError);
    await expect(ProcessLock.acquire(lockPath)).rejects.toThrow(/owner record/);
  });

  it('reclaims a directory with no owner record (holder died between mkdir and publish)', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    mkdirSync(lockPath, { mode: 0o700 });
    const lock = await ProcessLock.acquire(lockPath);
    expect(existsSync(join(lockPath, 'owner.json'))).toBe(true);
    await lock.release();
  });

  it('refuses an owner record published on another host (liveness cannot be probed)', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    writeOwner(lockPath, { pid: process.ppid, host: 'some-other-host.example' });
    await expect(ProcessLock.acquire(lockPath)).rejects.toBeInstanceOf(ProcessLockHeldError);
    await expect(ProcessLock.acquire(lockPath)).rejects.toThrow(/different host/i);
  });

  it('release does not remove a lock a newer instance already took over', async () => {
    const lockPath = join(dir, 'kernel-state.json.lock');
    const first = await ProcessLock.acquire(lockPath);
    // Simulate a stale reclaim while the old handle is still around: the
    // directory now names a newer owner.
    writeOwner(lockPath, { pid: process.pid, host: 'replacement' });
    await first.release();
    expect(existsSync(join(lockPath, 'owner.json'))).toBe(true);
  });

  it('creates the parent data directory owner-only', async () => {
    const lockPath = join(dir, 'nested', 'data', 'kernel-state.json.lock');
    const lock = await ProcessLock.acquire(lockPath);
    expect(existsSync(dirname(lockPath))).toBe(true);
    await lock.release();
  });
});

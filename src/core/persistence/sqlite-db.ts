/**
 * SQLite connection wrapper for durable zeus state (T-M6-01). Uses the
 * built-in experimental node:sqlite module (Node 22+), loaded via
 * createRequire so the runtime — not the TS resolver — owns the `node:`
 * module. The PG driver is a later slice (same port contract).
 *
 * File hygiene: the database holds plaintext local secrets (e.g.
 * decision_webhooks.secret), so every open tightens the DB file and its
 * WAL/SHM sidecars to 0600 and creates the parent directory 0700 — the same
 * discipline as the kernel-state/vault/audit writers. Tightening runs on
 * every open, which also corrects databases created by older builds or
 * manually loosened by the operator. Pre-existing parent directories are
 * left untouched: the operator may share them deliberately.
 */
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

const DB_FILE_MODE = 0o600;
const DB_DIR_MODE = 0o700;

/** Tighten the DB file and its WAL/SHM sidecars to owner-only. */
function tightenDbFilePerms(location: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${location}${suffix}`;
    if (existsSync(path)) chmodSync(path, DB_FILE_MODE);
  }
}

export function openSqlite(location: string): DatabaseSync {
  if (location !== ':memory:') {
    mkdirSync(dirname(location), { recursive: true, mode: DB_DIR_MODE });
  }
  const db = new sqlite.DatabaseSync(location);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  if (location !== ':memory:') {
    // Materialize the WAL/SHM sidecars now — they are otherwise created
    // lazily on the first write and would keep the process umask (0644 under
    // umask 022) for the rest of the session. BEGIN IMMEDIATE acquires the
    // write lock and creates both files; ROLLBACK leaves the schema untouched.
    db.exec('BEGIN IMMEDIATE; ROLLBACK;');
    tightenDbFilePerms(location);
  }
  return db;
}

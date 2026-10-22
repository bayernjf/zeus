/**
 * SQLite connection wrapper for durable zeus state (T-M6-01). Uses the
 * built-in experimental node:sqlite module (Node 22+), loaded via
 * createRequire so the runtime — not the TS resolver — owns the `node:`
 * module. The PG driver is a later slice (same port contract).
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export function openSqlite(location: string): DatabaseSync {
  if (location !== ':memory:') {
    mkdirSync(dirname(location), { recursive: true });
  }
  const db = new sqlite.DatabaseSync(location);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  return db;
}

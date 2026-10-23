#!/usr/bin/env node
// @ts-check
/**
 * Durable-state backup (T-M6-02). Produces a consistent SQLite snapshot via
 * VACUUM INTO (no need to stop the process), copies the signed JSONL audit
 * trail, locks every artifact to 0600, and prunes to a configurable
 * retention count.
 *
 * CLI:
 *   node scripts/backup.mjs --db ./data/zeus.db \
 *     [--audit ./data/decision-audit.jsonl] \
 *     --dir ./data/backups [--keep 7]
 */
import { createRequire } from 'node:module';
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

/**
 * @param {Date} now
 * @returns {string}
 */
function stamp(now) {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
}

/**
 * @param {string} path
 * @returns {string}
 */
function sqlQuote(path) {
  return path.replaceAll("'", "''");
}

/**
 * Create one backup snapshot.
 * @param {{dbFile:string, auditFile?:string, backupDir:string, now?:Date}} opts
 * @returns {{id:string, dir:string}}
 */
export function backupSnapshot(opts) {
  const now = opts.now ?? new Date();
  if (!existsSync(opts.dbFile)) {
    throw new Error(`db file not found: ${opts.dbFile}`);
  }
  const id = `snapshot-${stamp(now)}`;
  const dir = join(opts.backupDir, id);
  mkdirSync(dir, { recursive: true });

  const src = new sqlite.DatabaseSync(opts.dbFile, { readOnly: true });
  try {
    const target = join(dir, 'zeus.db');
    src.exec(`VACUUM INTO '${sqlQuote(target)}'`);
  } finally {
    src.close();
  }

  if (opts.auditFile && existsSync(opts.auditFile)) {
    copyFileSync(opts.auditFile, join(dir, 'decision-audit.jsonl'));
  }

  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600);
  return { id, dir };
}

/**
 * Remove snapshots beyond the retention count (oldest first).
 * @param {string} backupDir
 * @param {number} keep
 * @returns {string[]} removed snapshot ids
 */
export function pruneSnapshots(backupDir, keep) {
  if (!existsSync(backupDir)) return [];
  const dirs = readdirSync(backupDir)
    .filter((d) => d.startsWith('snapshot-'))
    .sort();
  const remove = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const d of remove) rmSync(join(backupDir, d), { recursive: true, force: true });
  return remove;
}

/**
 * @param {string[]} argv
 * @returns {{db?: string, audit?: string, dir?: string, keep: number}}
 */
function parseArgs(argv) {
  /** @type {{db?: string, audit?: string, dir?: string, keep: number}} */
  const args = { keep: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--db') args.db = argv[++i] ?? '';
    else if (key === '--audit') args.audit = argv[++i] ?? '';
    else if (key === '--dir') args.dir = argv[++i] ?? '';
    else if (key === '--keep') args.keep = Number(argv[++i]);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.dir) {
    process.stderr.write('usage: backup.mjs --db <file> --dir <backup dir> [--audit <file>] [--keep N]\n');
    process.exit(2);
  }
  try {
    const result = backupSnapshot({
      dbFile: args.db,
      ...(args.audit ? { auditFile: args.audit } : {}),
      backupDir: args.dir,
    });
    const removed = pruneSnapshots(args.dir, args.keep);
    process.stdout.write(`backup ${result.id} -> ${result.dir}`);
    if (removed.length) process.stdout.write(`; pruned ${removed.join(', ')}`);
    process.stdout.write('\n');
  } catch (error) {
    process.stderr.write(
      `backup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

export { dirname };

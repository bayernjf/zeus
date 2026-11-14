#!/usr/bin/env node
// @ts-check
/**
 * Durable-state restore (T-M6-02). Fail-closed: a missing or corrupt backup
 * aborts with a non-zero exit and never silently starts an empty database.
 * The backup SQLite is verified with PRAGMA integrity_check before anything
 * is copied; restored files are locked to 0600.
 *
 * The signing key and the state files beside the db are restored too — a
 * database without its audit key cannot prove any past decision. Existing
 * state files are left alone unless `--force` is given, because overwriting a
 * newer runtime state with an older one is a silent regression.
 *
 * CLI:
 *   node scripts/restore.mjs --snapshot ./data/backups/snapshot-... \
 *     --target-db ./data/zeus.db [--target-audit ./data/audit.jsonl] \
 *     [--target-state-dir ./data] [--force]
 */
import { createRequire } from 'node:module';
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { STATE_FILES } from './backup.mjs';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

class RestoreError extends Error {}

/**
 * @param {Date} now
 * @returns {string}
 */
function stamp(now) {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Restore one snapshot to its target location.
 * @param {{snapshotDir:string, targetDb:string, targetAudit?:string, targetStateDir?:string, force?:boolean}} opts
 * @returns {{targetDb:string, targetAudit?:string, stateFiles:string[], skipped:string[]}}
 */
export function restoreSnapshot(opts) {
  const srcDb = join(opts.snapshotDir, 'zeus.db');
  if (!existsSync(srcDb)) {
    throw new RestoreError(`backup db missing: ${srcDb}`);
  }

  // Verify the backup before touching the target.
  const check = new sqlite.DatabaseSync(srcDb, { readOnly: true });
  try {
    const row = check.prepare('PRAGMA integrity_check').get();
    if (!row || row.integrity_check !== 'ok') {
      throw new RestoreError('backup db integrity check failed');
    }
  } finally {
    check.close();
  }

  if (!opts.force && existsSync(opts.targetDb)) {
    throw new RestoreError(`target db exists (use --force): ${opts.targetDb}`);
  }

  mkdirSync(dirname(opts.targetDb), { recursive: true });
  copyFileSync(srcDb, opts.targetDb);
  chmodSync(opts.targetDb, 0o600);

  /** @type {{targetDb:string, targetAudit?:string, stateFiles:string[], skipped:string[]}} */
  const result = { targetDb: opts.targetDb, stateFiles: [], skipped: [] };

  const srcAudit = join(opts.snapshotDir, 'decision-audit.jsonl');
  if (opts.targetAudit && existsSync(srcAudit)) {
    mkdirSync(dirname(opts.targetAudit), { recursive: true });
    copyFileSync(srcAudit, opts.targetAudit);
    chmodSync(opts.targetAudit, 0o600);
    result.targetAudit = opts.targetAudit;
  }

  const stateDir = opts.targetStateDir ?? dirname(opts.targetDb);
  for (const name of STATE_FILES) {
    const from = join(opts.snapshotDir, name);
    if (!existsSync(from)) continue;
    const to = join(stateDir, name);
    if (existsSync(to)) {
      if (!opts.force) {
        result.skipped.push(name);
        continue;
      }
      const keep = `${to}.pre-restore-${stamp(new Date())}`;
      copyFileSync(to, keep);
      chmodSync(keep, 0o600);
    }
    mkdirSync(stateDir, { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, 0o600);
    result.stateFiles.push(name);
  }

  return result;
}

/**
 * @param {string[]} argv
 * @returns {{snapshot?: string, targetDb?: string, targetAudit?: string, targetStateDir?: string, force?: boolean}}
 */
function parseArgs(argv) {
  /** @type {{snapshot?: string, targetDb?: string, targetAudit?: string, targetStateDir?: string, force?: boolean}} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--snapshot') args.snapshot = argv[++i] ?? '';
    else if (key === '--target-db') args.targetDb = argv[++i] ?? '';
    else if (key === '--target-audit') args.targetAudit = argv[++i] ?? '';
    else if (key === '--target-state-dir') args.targetStateDir = argv[++i] ?? '';
    else if (key === '--force') args.force = true;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshot || !args.targetDb) {
    process.stderr.write(
      'usage: restore.mjs --snapshot <dir> --target-db <file> [--target-audit <file>] [--target-state-dir <dir>] [--force]\n',
    );
    process.exit(2);
  }
  try {
    const result = restoreSnapshot({
      snapshotDir: args.snapshot,
      targetDb: args.targetDb,
      ...(args.targetAudit ? { targetAudit: args.targetAudit } : {}),
      ...(args.targetStateDir ? { targetStateDir: args.targetStateDir } : {}),
      ...(args.force ? { force: true } : {}),
    });
    process.stdout.write(`restored -> ${result.targetDb}`);
    if (result.targetAudit) process.stdout.write(`, ${result.targetAudit}`);
    process.stdout.write('\n');
    process.stdout.write(
      `  state files: ${result.stateFiles.length ? result.stateFiles.join(', ') : '(none)'}\n`,
    );
    if (result.skipped.length) {
      process.stderr.write(
        `restore warning: kept existing ${result.skipped.join(', ')} (pass --force to replace them)\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `restore failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

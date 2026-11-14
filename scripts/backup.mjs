#!/usr/bin/env node
// @ts-check
/**
 * Durable-state backup (T-M6-02). Produces a consistent SQLite snapshot via
 * VACUUM INTO (no need to stop the process), copies the signed JSONL audit
 * trail, copies the files beside the database that cannot be rebuilt (RSK
 * audit signing key, runtime/daily state, internal token), locks every artifact
 * to 0600, and prunes to a configurable retention count.
 *
 * The audit trail and the signing key are not optional extras: without the
 * key the historical chain can no longer be verified, and a silently skipped
 * audit copy makes a backup look complete while the chain is empty. Both are
 * therefore reported by name, and a missing key fails the run unless
 * `--allow-missing-key` says this deployment has not minted one yet.
 *
 * CLI:
 *   node scripts/backup.mjs --db ./data/zeus.db \
 *     [--audit ./data/audit.jsonl] [--state-dir ./data] \
 *     --dir ./data/backups [--keep 7] [--allow-missing-key]
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
import { join, dirname, basename } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

/**
 * Files that live beside the db and cannot be derived from it.
 * `rsk-ed25519.pem` is the audit-chain signing key: lose it and every earlier
 * signature becomes unverifiable. The two state files and the internal token
 * are the live runtime's own state, not a cache.
 */
export const STATE_FILES = [
  'rsk-ed25519.pem',
  'runtime-state.json',
  'daily-state.json',
  'internal-token',
];

/**
 * Candidate audit-trail paths, in order. The service ships `audit.jsonl`
 * (`src/dispatch/audit.ts` documents it as the fresh-data-dir default); the
 * older script default `decision-audit.jsonl` is kept for deployments that
 * were set up that way.
 */
export const AUDIT_CANDIDATES = ['decision-audit.jsonl', 'audit.jsonl'];

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
 * @param {{dbFile:string, auditFile?:string, stateDir?:string, backupDir:string, now?:Date}} opts
 * @returns {{id:string, dir:string, copied:string[], missing:string[]}}
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

  /** @type {string[]} */
  const copied = ['zeus.db'];
  /** @type {string[]} */
  const missing = [];

  const stateDir = opts.stateDir ?? dirname(opts.dbFile);
  for (const name of STATE_FILES) {
    const from = join(stateDir, name);
    if (existsSync(from)) {
      copyFileSync(from, join(dir, name));
      copied.push(name);
    } else {
      missing.push(name);
    }
  }

  if (opts.auditFile !== undefined) {
    if (existsSync(opts.auditFile)) {
      copyFileSync(opts.auditFile, join(dir, 'decision-audit.jsonl'));
      copied.push('decision-audit.jsonl');
    } else {
      // An explicitly requested trail that does not exist is a config error,
      // not something to swallow.
      missing.push(`audit(${opts.auditFile})`);
    }
  } else {
    const found = AUDIT_CANDIDATES.map((name) => join(stateDir, name)).find((p) =>
      existsSync(p),
    );
    if (found !== undefined) {
      copyFileSync(found, join(dir, 'decision-audit.jsonl'));
      copied.push(`decision-audit.jsonl<${basename(found)}>`);
    } else {
      missing.push('audit');
    }
  }

  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600);
  return { id, dir, copied, missing };
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
 * @returns {{db?: string, audit?: string, dir?: string, stateDir?: string, keep: number, allowMissingKey: boolean}}
 */
function parseArgs(argv) {
  /** @type {{db?: string, audit?: string, dir?: string, stateDir?: string, keep: number, allowMissingKey: boolean}} */
  const args = { keep: 7, allowMissingKey: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--db') args.db = argv[++i] ?? '';
    else if (key === '--audit') args.audit = argv[++i] ?? '';
    else if (key === '--dir') args.dir = argv[++i] ?? '';
    else if (key === '--state-dir') args.stateDir = argv[++i] ?? '';
    else if (key === '--keep') args.keep = Number(argv[++i]);
    else if (key === '--allow-missing-key') args.allowMissingKey = true;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.dir) {
    process.stderr.write(
      'usage: backup.mjs --db <file> --dir <backup dir> [--audit <file>] [--state-dir <dir>] [--keep N] [--allow-missing-key]\n',
    );
    process.exit(2);
  }
  try {
    const result = backupSnapshot({
      dbFile: args.db,
      ...(args.audit ? { auditFile: args.audit } : {}),
      ...(args.stateDir ? { stateDir: args.stateDir } : {}),
      backupDir: args.dir,
    });
    const removed = pruneSnapshots(args.dir, args.keep);
    process.stdout.write(`backup ${result.id} -> ${result.dir}\n`);
    process.stdout.write(`  copied:  ${result.copied.join(', ')}\n`);
    process.stdout.write(`  missing: ${result.missing.length ? result.missing.join(', ') : '(none)'}\n`);
    if (removed.length) process.stdout.write(`  pruned:  ${removed.join(', ')}\n`);

    const missingKey = result.missing.includes('rsk-ed25519.pem');
    const brokenAudit = result.missing.some((m) => m.startsWith('audit('));
    if (missingKey) {
      process.stderr.write(
        'backup warning: rsk-ed25519.pem is not in the snapshot — historical audit signatures ' +
          'will not be verifiable from this backup. Pass --allow-missing-key only if this ' +
          'deployment has not minted a key yet.\n',
      );
      if (!args.allowMissingKey) {
        process.stderr.write('backup failed: an audit signing key is required for a complete backup\n');
        process.exitCode = 1;
      }
    }
    if (result.missing.some((m) => m === 'audit')) {
      process.stderr.write(
        'backup warning: no audit trail found — neither decision-audit.jsonl nor audit.jsonl exists ' +
          'in the state directory, so the snapshot carries no decision history.\n',
      );
    }
    if (brokenAudit) {
      process.stderr.write('backup failed: the requested audit file does not exist\n');
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `backup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

export { dirname };

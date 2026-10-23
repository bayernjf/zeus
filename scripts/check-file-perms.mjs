#!/usr/bin/env node
// @ts-check
/**
 * Sensitive-file permission check (T-M6-02). Signing keys, SQLite/state files,
 * the internal token and audit/backup artifacts must not be readable or
 * writable by group or other (mode 0600, owner-only). Exits non-zero if any
 * named file has group/other bits set.
 *
 * CLI: node scripts/check-file-perms.mjs <file> [<file> ...]
 */
import { statSync, existsSync } from 'node:fs';

/**
 * @param {string} file
 * @returns {{file:string, mode:number, ok:boolean}}
 */
export function checkMode0600(file) {
  const mode = statSync(file).mode & 0o777;
  return { file, mode, ok: (mode & 0o077) === 0 };
}

/**
 * @param {string[]} files
 * @returns {{file:string, mode:number, ok:boolean}[]}
 */
export function checkFiles(files) {
  return files.filter(existsSync).map(checkMode0600);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write('usage: check-file-perms.mjs <file> [<file> ...]\n');
    process.exit(2);
  }
  const results = checkFiles(files);
  let failed = false;
  for (const r of results) {
    if (!r.ok) {
      failed = true;
      process.stderr.write(
        `${r.file}: mode ${r.mode.toString(8)} (want 0600, no group/other access)\n`,
      );
    }
  }
  if (results.length !== files.length) {
    failed = true;
    process.stderr.write('one or more named files do not exist\n');
  }
  if (failed) process.exit(1);
  process.stdout.write(`file permissions ok: ${results.length} file(s)\n`);
}

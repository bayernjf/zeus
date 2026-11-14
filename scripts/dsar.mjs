#!/usr/bin/env node
// @ts-check
// Data Subject Access Request (DSAR) —— T-C1-02.
//
//   node scripts/dsar.mjs export --subject <approver> [--db FILE] [--out FILE]
//   node scripts/dsar.mjs delete --subject <approver> [--db FILE] [--commit]
//
// 「审计不可篡改 vs 删除权」的处理（缺口清单 T-C1-02 方案落地）：
// - 删除只作用于业务表 decision_approvals 的个人字段 `approver` / `comment`。
// - 审计文件（audit.jsonl / decision-audit.jsonl）从不改动：它是 append-only，
//   删除不碰它，因此删除后审计链的验签结论天然不变（验签只依赖链内字节）。
// - `approver` 是 NOT NULL，删除用不可逆哈希占位符 `erased:<sha256(approver)>`
//   替换原文 —— 同一主体多次删除得到同一占位符，可追溯但无法还原；`comment`
//   置 NULL。
//
// 现状边界（如实，2026-11-13）：SQLite 持久化（T-M6-01）尚未接线生产 ——
// zeus 容器当前用 runtime-state.json + trace 审计。本脚本面向 schema.ts 的业务
// 表，待 SQLite 上线后才作用于真实数据；当前在无 DB 文件的机器上跑会
// fail-closed 报「数据库不存在」，而不是空跑成功。

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
/** @type {typeof import('node:sqlite')} */
const sqlite = nodeRequire('node:sqlite');

/**
 * Approver PII placeholder: same subject -> same token, but no plaintext.
 * @param {string} approver
 * @returns {string}
 */
function erasedToken(approver) {
  return `erased:${createHash('sha256').update(approver, 'utf8').digest('hex')}`;
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`dsar: ${message}\n`);
  process.exit(1);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      if (!out.subcommand) {
        out.subcommand = arg;
        continue;
      }
      fail(`unknown positional argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (name === 'commit' || name === 'help') {
      out[name] = '1';
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
    out[name] = value;
    i += 1;
  }
  return out;
}

function usage() {
  process.stdout.write(`usage:
  node scripts/dsar.mjs export --subject <approver> [--db FILE] [--out FILE]
  node scripts/dsar.mjs delete --subject <approver> [--db FILE] [--commit]
`);
}

/**
 * @param {string} dbFile
 * @param {boolean} readOnly
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDb(dbFile, readOnly) {
  const path = resolve(dbFile);
  if (!existsSync(path)) fail(`database does not exist: ${path}`);
  return new sqlite.DatabaseSync(path, readOnly ? { readOnly: true } : {});
}

/**
 * @param {string} subject
 * @param {string} dbFile
 * @param {string | undefined} outFile
 */
function doExport(subject, dbFile, outFile) {
  const db = openDb(dbFile, true);
  const approvals = db
    .prepare('SELECT seq, decision_id, approver, verdict, comment, at FROM decision_approvals WHERE approver = ? ORDER BY decision_id, seq')
    .all(subject);
  /** @type {Map<string, unknown>} */
  const decisions = new Map();
  for (const row of approvals) {
    const decisionId = String(row.decision_id);
    if (decisions.has(decisionId)) continue;
    const rec = db.prepare('SELECT * FROM decision_records WHERE id = ?').get(decisionId);
    if (rec) decisions.set(decisionId, rec);
  }
  db.close();

  const payload = {
    subject,
    exported_at: new Date().toISOString(),
    approvals,
    decisions: [...decisions.values()],
  };
  const text = JSON.stringify(payload, null, 2);
  if (outFile) {
    writeFileSync(resolve(outFile), text, { mode: 0o600 });
    process.stdout.write(`wrote ${outFile}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
  process.stdout.write(
    `exported ${approvals.length} approval(s) and ${decisions.size} decision(s) for "${subject}"\n`,
  );
}

/**
 * @param {string} subject
 * @param {string} dbFile
 * @param {boolean} commit
 */
function doDelete(subject, dbFile, commit) {
  const db = openDb(dbFile, false);
  const countRow = db
    .prepare('SELECT COUNT(*) AS n FROM decision_approvals WHERE approver = ?')
    .get(subject);
  const count = Number(countRow?.n ?? 0);
  const token = erasedToken(subject);

  if (!commit) {
    db.close();
    process.stdout.write(
      `[dry-run] would erase approver -> ${token} and comment -> NULL on ${count} row(s) for "${subject}" (rerun with --commit to write)\n`,
    );
    return;
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE decision_approvals SET approver = ?, comment = NULL WHERE approver = ?').run(token, subject);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    fail(`delete failed, rolled back: ${String(err)}`);
  }
  db.close();
  process.stdout.write(`erased ${count} approval row(s) for "${subject}" -> ${token}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const subject = args.subject;
  if (!subject) fail('--subject <approver> is required');
  const dbFile = args.db ?? './data/zeus.db';

  if (args.subcommand === 'export') {
    doExport(subject, dbFile, args.out);
    return;
  }
  if (args.subcommand === 'delete') {
    doDelete(subject, dbFile, args.commit === '1');
    return;
  }
  usage();
  fail('subcommand must be export or delete');
}

main();

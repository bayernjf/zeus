import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import type { AuditDecision, AuditEntry, AuditSink } from './dispatcher.js';

/** Rotation knobs for the JSONL audit sink. */
export type JsonlAuditSinkOptions = {
  /**
   * Ceiling for the active file. Crossing it rotates before the write, so the
   * file grows to roughly this size and no further. `Infinity` never rotates.
   * Default 64 MiB.
   */
  maxBytes?: number;
  /** Rotated generations kept as `<path>.1` … `<path>.<keep>`; default 5. */
  keep?: number;
};

export const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_AUDIT_KEEP = 5;

/**
 * Append one JSON object per line, bounded on disk.
 *
 * An audit trail that fills the volume takes the whole kernel down with it, and
 * "set up logrotate yourself" is the kind of instruction that gets written in a
 * deployment doc and never executed - so the sink bounds itself by default. Total
 * on-disk ceiling is maxBytes * (keep + 1). Set `maxBytes: Infinity` to opt out.
 */
export function jsonlAuditSink(path: string, options: JsonlAuditSinkOptions = {}): AuditSink {
  const maxBytes = options.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_AUDIT_KEEP;
  if (Number.isFinite(maxBytes) && maxBytes < 1) {
    throw new Error(`audit maxBytes must be >= 1 or Infinity, got ${String(maxBytes)}`);
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`audit keep must be a whole number >= 1, got ${String(keep)}`);
  }

  return entry => {
    const line = `${JSON.stringify(entry)}\n`;
    if (Number.isFinite(maxBytes)) {
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        size = 0; // first write: the file does not exist yet
      }
      if (size + Buffer.byteLength(line) > maxBytes) rotateAuditLog(path, keep);
    }
    appendFileSync(path, line);
  };
}

/** Shift `<path>.n` → `<path>.n+1`, drop the overflow generation, and retire the
 *  active file to `.1`. */
export function rotateAuditLog(path: string, keep: number = DEFAULT_AUDIT_KEEP): void {
  rmSync(`${path}.${keep}`, { force: true });
  for (let gen = keep - 1; gen >= 1; gen -= 1) {
    const from = `${path}.${gen}`;
    if (!existsSync(from)) continue;
    const to = `${path}.${gen + 1}`;
    rmSync(to, { force: true }); // rename over an existing file fails on Windows
    renameSync(from, to);
  }
  if (existsSync(path)) renameSync(path, `${path}.1`);
}

/** Filters for reading a persisted audit trail back. */
export type AuditQuery = {
  /** Maximum entries returned, counting from the newest. Default 200. */
  limit?: number;
  runId?: string;
  vassal?: string;
  decision?: AuditDecision;
};

export class AuditLogError extends Error {}

const DEFAULT_AUDIT_LIMIT = 200;
const DEFAULT_AUDIT_TAIL_BYTES = 256 * 1024;

/**
 * Read the tail of a JSONL audit log, oldest first. The read is bounded to the
 * last `readBytes`, so one request against a years-old log cannot exhaust
 * memory; the answer says nothing about entries older than that window.
 *
 * When the window starts mid-file the first line is necessarily partial and is
 * dropped - that is a truncated read, not corruption. Any other unparseable
 * line throws: an audit trail that quietly skips records is worse than one that
 * admits it cannot be trusted.
 */
export function readAuditLog(
  path: string,
  query: AuditQuery = {},
  options: { readBytes?: number } = {},
): AuditEntry[] {
  const readBytes = options.readBytes ?? DEFAULT_AUDIT_TAIL_BYTES;
  const limit = query.limit ?? DEFAULT_AUDIT_LIMIT;

  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const want = Math.min(size, readBytes);
    const offset = size - want;
    const buffer = Buffer.alloc(want);
    if (want > 0) readSync(fd, buffer, 0, want, offset);

    const lines = buffer.toString('utf8').split('\n');
    if (offset > 0 && lines.length > 1) lines.shift();

    const entries: AuditEntry[] = [];
    for (const [index, line] of lines.entries()) {
      const text = line.trim();
      if (text === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new AuditLogError(
          `unreadable audit record at byte ${offset + 1} of ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isAuditEntry(parsed)) {
        throw new AuditLogError(`audit record at byte ${offset + 1} of ${path} is missing ts/vassal/decision`);
      }
      entries.push(parsed);
    }

    const matching = entries.filter(entry =>
      (query.runId === undefined || entry.runId === query.runId) &&
      (query.vassal === undefined || entry.vassal === query.vassal) &&
      (query.decision === undefined || entry.decision === query.decision));
    return matching.slice(-limit);
  } finally {
    closeSync(fd);
  }
}

function isAuditEntry(value: unknown): value is AuditEntry {
  const entry = value as Partial<AuditEntry> | null;
  return !!entry &&
    typeof entry.ts === 'string' &&
    typeof entry.vassal === 'string' &&
    typeof entry.decision === 'string';
}

export function memoryAuditSink(): { log: AuditEntry[]; sink: AuditSink } {
  const log: AuditEntry[] = [];
  return { log, sink: entry => log.push(entry) };
}

/** Bridge registry revocation events into the same dispatch audit trail,
 *  so governance actions (token revocation / demotion to guest) are recorded
 *  alongside dispatch decisions. Wire as VassalRegistry's onRevoke hook. */
export function revokeAuditBridge(audit: AuditSink): (name: string, at: string) => void {
  return (name, at) =>
    audit({
      ts: at,
      vassal: name,
      decision: 'vassal-revoked',
      detail: 'vassal access revoked; demoted to guest/blocked, no further tokens issued',
    });
}

import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
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
  // `Infinity` is the documented opt-out; anything else must be a usable size.
  // NaN used to pass the old `Number.isFinite(maxBytes) && maxBytes < 1` guard and
  // then make the rotation branch unreachable, so a typo silently turned the bound
  // off rather than failing at boot.
  if (maxBytes !== Number.POSITIVE_INFINITY && !(Number.isFinite(maxBytes) && maxBytes >= 1)) {
    throw new Error(`audit maxBytes must be >= 1 or Infinity, got ${String(maxBytes)}`);
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`audit keep must be a whole number >= 1, got ${String(keep)}`);
  }

  // Fail at boot, not at the first dispatch: an audit path the operator
  // configured but cannot write is a configuration error, and silently
  // downgrading it would leave them believing they had a trail.
  try {
    ensureAuditFile(path);
  } catch (error) {
    throw new Error(
      `cannot use the audit log at ${path}: ${error instanceof Error ? error.message : String(error)} (fix ZEUS_AUDIT_FILE or unset it)`,
    );
  }

  return entry => {
    const line = `${JSON.stringify(entry)}\n`;
    if (Number.isFinite(maxBytes)) {
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        size = 0; // rotated away between two entries - recreated below
      }
      if (size + Buffer.byteLength(line) > maxBytes) {
        rotateAuditLog(path, keep);
        // Rotation retired the active file, so the replacement has to be
        // re-tightened or the next line lands world-readable again.
        ensureAuditFile(path);
      }
    }
    // `mode` only bites when the append creates the file - which is exactly the
    // rotation race: another writer can retire the active file between our
    // `ensureAuditFile` and this write, and a bare append would recreate it 0644.
    appendFileSync(path, line, { mode: 0o600 });
  };
}

/**
 * Make the trail exist and be owner-only.
 *
 * The directory is created because the sink used to assume it: with the
 * documented default (`./data/audit.jsonl` in a fresh data dir) the very first
 * audit write threw ENOENT, and the dispatcher's branch `catch` re-labelled that
 * filesystem error as the reason the *vassal* failed. The mode matters for the
 * same reason the kernel state file's does - audit lines carry realm ids, vassal
 * names and decision detail - and `appendFileSync` alone would leave the file
 * 0644 on a default umask.
 */
export function ensureAuditFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, '', { mode: 0o600 });
  chmodSync(path, 0o600); // also tightens a file an older build left world-readable
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
    // A generation written by a build that predates the 0600 create keeps its
    // old mode through the rename; tighten it on the way through. Best effort:
    // a generation that vanished underneath us is not a rotation failure.
    try {
      chmodSync(to, 0o600);
    } catch {
      /* concurrent rotation retired it */
    }
  }
  if (existsSync(path)) {
    renameSync(path, `${path}.1`);
    try {
      chmodSync(`${path}.1`, 0o600);
    } catch {
      /* concurrent rotation retired it */
    }
  }
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
    // readSync is allowed to return short (signal interruption, a file that
    // shrank underneath us); a single call would silently parse a half-window.
    let filled = 0;
    while (filled < want) {
      const read = readSync(fd, buffer, filled, want - filled, offset + filled);
      if (read === 0) break;
      filled += read;
    }
    const bytes = buffer.subarray(0, filled);
    const window = bytes.toString('utf8');

    const lines = window.split('\n');
    // Drop the first line only when the window did not begin on a line boundary:
    // then it is necessarily partial, and JSON.parse would report a truncated
    // read as corruption. The old `lines.length > 1` guard left the single-line
    // case behind, so a window holding one partial line threw instead of being
    // treated as a truncation.
    const droppedFirst = offset > 0 && !startsAtLineBoundary(fd, offset);

    // Byte offset of each line's first byte within the window, read off the buffer
    // itself: a window that starts mid-sequence decodes its leading bytes to one
    // replacement character, so summing re-encoded string lengths would drift.
    const lineStarts = [0];
    for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x0a) lineStarts.push(i + 1);

    const entries: AuditEntry[] = [];
    // Report each line's own byte offset. The window origin was used for every
    // line, pointing an operator at a good record while the corrupt one sat
    // further down the file.
    for (let i = 0; i < lines.length; i += 1) {
      if (droppedFirst && i === 0) continue;
      const line = lines[i];
      if (line === undefined) continue; // loop bound guarantees existence; defensive skip
      const at = offset + (lineStarts[i] ?? 0);
      const text = line.trim();
      if (text === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new AuditLogError(
          `unreadable audit record at byte ${at + 1} of ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isAuditEntry(parsed)) {
        throw new AuditLogError(`audit record at byte ${at + 1} of ${path} is missing ts/vassal/decision`);
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

/** True when `offset` is the first byte of a line, i.e. the byte before it is a
 *  newline - so the window's first line is complete and must not be dropped. */
function startsAtLineBoundary(fd: number, offset: number): boolean {
  const previous = Buffer.alloc(1);
  return readSync(fd, previous, 0, 1, offset - 1) === 1 && previous[0] === 0x0a;
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

/** A-02: bridge the explicit restore of a revoked vassal into the same trail.
 *  Re-registration no longer clears a revocation, so this is the only event
 *  that can show a revocation was undone. Wire as VassalRegistry's onReinstate. */
export function reinstateAuditBridge(audit: AuditSink): (name: string, at: string) => void {
  return (name, at) =>
    audit({
      ts: at,
      vassal: name,
      decision: 'vassal-reinstated',
      detail: 'vassal access restored by an explicit reinstate; not a side effect of re-registration',
    });
}

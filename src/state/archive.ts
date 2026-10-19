/**
 * deferred #42 decision-record retention: out-window archival (design
 * docs/design-intent-retention.md, plan C).
 *
 * The kernel state file rewrites and re-parses the full intent/request tables
 * on every save and boot, so a long-running instance grows linearly. Deleting
 * old intents would silently break three promises (idempotent replay of a
 * submitted intentId, `GET /api/intents/:id/replay` traceability, and
 * approve-resume via findIntentForBranchRun), so plan C moves settled records
 * out of the state file into an append-only JSONL archive instead: the state
 * file returns to window size while every promise keeps reading from the
 * archive.
 *
 * Modes (see design §4.5 / §5):
 *   retain  — default A: nothing leaves the state file (current behaviour).
 *   archive — plan C: out-window records move to intent-archive.jsonl.
 *   evict   — plan B: out-window records are deleted outright; idempotency is
 *             documented as window-scoped, and replays of evicted intents 404.
 *
 * Reads are injected into the Orchestrator and the HTTP face through
 * IntentArchiveLookup, so the kernel never performs file I/O itself; the
 * booted process supplies the real JSONL-backed implementation.
 */
import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FanOutRequest, FanOutResult, FanOutStatus } from '../orchestrator/types.js';
import type { Escalation } from '../oversight/types.js';

/** Retention behaviour selected at boot (ZEUS_INTENT_RETENTION). */
export type RetentionMode = 'retain' | 'archive' | 'evict';

/** One out-window intent as persisted on the archive JSONL. */
export type ArchivedIntentRecord = {
  intentId: string;
  /** When the record was archived (ISO-8601 UTC). */
  ts: string;
  /** Original intent creation time, used by the time-window condition. */
  createdAt: string;
  /** Terminal status at archive time. */
  status: FanOutStatus;
  /** Original dispatch input (idempotent replay / replay rendering). */
  request?: FanOutRequest;
  /** Final result (replay rebuilding). */
  result: FanOutResult;
  /** Intent ids referenced by escalations, retained for auditability. */
  references?: string[];
};

/** Read-only archive port the Orchestrator / HTTP face depend on. */
export type IntentArchiveLookup = {
  find(intentId: string): Promise<ArchivedIntentRecord | undefined>;
  findByBranch(runId: string, vassal: string): Promise<string | undefined>;
};

export type RetentionOptions = {
  /** Hard cap on settled intents kept in the state file. */
  maxEntries: number;
  /** Records older than this (ms) leave the state file. */
  windowMs: number;
  now: () => Date;
};

export const DEFAULT_MAX_ENTRIES = 1000;
export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Decide which settled intents leave the state file (pure, deterministic).
 *
 * Never out-window:
 *  - an intent referenced by a still-pending escalation (open question the
 *    driver has not answered yet);
 *  - an intent a human has already ruled on (an escalation that reached a
 *    decision, or a driver resolution written back into the result);
 *  - any intent still in flight (not settled — the caller only feeds settled
 *    intents, and in-flight keys live in a separate table anyway).
 *
 * Both conditions (count cap and time window) must hold before anything
 * leaves: candidates are ordered oldest-first, and the returned list is the
 * smallest prefix that brings the remainder inside both bounds.
 */
export function selectArchivable(
  intents: readonly FanOutResult[],
  escalations: readonly Escalation[],
  options: RetentionOptions,
): string[] {
  const referenced = new Set<string>();
  for (const escalation of escalations) {
    // intent-conflict carries its intentId directly; task-input references a
    // branch, so resolve it through the intent's branches like
    // findIntentForBranchRun does. A pending escalation keeps its intent in the
    // state file; a decided one is kept because a human touched that decision.
    if (escalation.intentId) {
      referenced.add(escalation.intentId);
    } else {
      for (const intent of intents) {
        if (intent.branches.some(branch => branch.runId === escalation.runId && branch.vassal === escalation.vassal)) {
          referenced.add(intent.intentId);
        }
      }
    }
  }

  const retained = new Set<string>();
  for (const intent of intents) {
    if (referenced.has(intent.intentId)) retained.add(intent.intentId);
    if (intent.driverResolution) retained.add(intent.intentId);
  }

  const candidates = intents
    .filter(intent => !retained.has(intent.intentId))
    .map(intent => ({ intentId: intent.intentId, createdAt: intent.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const cutoff = new Date(options.now().getTime() - options.windowMs).toISOString();
  const out: string[] = [];
  for (const candidate of candidates) {
    // Stop when both bounds are satisfied: no record older than the window and
    // the remaining set at or below the cap.
    const remaining = candidates.length - out.length - 1;
    const stillOverWindow = candidate.createdAt < cutoff;
    const stillOverCount = remaining >= options.maxEntries;
    if (!stillOverWindow && !stillOverCount) break;
    out.push(candidate.intentId);
  }
  return out;
}

/** Parse ZEUS_INTENT_RETENTION; unknown values fail loudly at boot. */
export function parseRetentionMode(raw: string | undefined): RetentionMode {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return 'retain';
  if (value === 'retain' || value === 'archive' || value === 'evict') return value;
  throw new Error(`ZEUS_INTENT_RETENTION must be retain | archive | evict, got '${raw}'`);
}

/** Archive file name beside the state file (design §4.1). */
export function archiveFilePath(stateFile: string): string {
  return join(dirname(stateFile), 'intent-archive.jsonl');
}

/**
 * JSONL-backed append-only archive. One record per line; `intentId` is the
 * primary key, so appends skip duplicates (an interrupted flush followed by a
 * retry cannot double-write). The in-memory index is rebuilt on construction,
 * making a restart read the same archive the previous process left behind.
 *
 * A kill mid-write can leave one torn record on the tail without its newline:
 * loadIndex tolerates exactly that case (a torn tail, never an interior line),
 * and the next append truncates the partial bytes before writing. Each append
 * is fsynced (and the directory when the file was created), and the file is
 * owner-only — created 0600 and re-chmodded in case an older build left it at
 * the umask default.
 */
export class IntentArchive implements IntentArchiveLookup {
  private index = new Map<string, ArchivedIntentRecord>();

  constructor(private filePath: string) {}

  /** Rebuild the in-memory index from the archive file. Missing file = empty. */
  async loadIndex(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    this.index.clear();
    const lines = raw.split('\n');
    let lastNonEmpty = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.trim() !== '') lastNonEmpty = i;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim() === '') continue;
      let record: ArchivedIntentRecord;
      try {
        record = JSON.parse(line) as ArchivedIntentRecord;
      } catch (error) {
        // Only the final non-empty line may be a torn tail from a crashed
        // append; an unparseable interior line is corruption we must not
        // paper over. The torn bytes are dropped here and reclaimed on the
        // next append (the record still lives in the state file until the
        // archive append + state snapshot sequence completed).
        if (i === lastNonEmpty) break;
        throw new Error(
          `unreadable archive record on line ${i + 1} of ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.index.set(record.intentId, record);
    }
  }

  /** Append new-key records; a torn tail is truncated first. */
  async append(records: readonly ArchivedIntentRecord[]): Promise<void> {
    if (records.length === 0) return;
    const fresh = records.filter(record => !this.index.has(record.intentId));
    if (fresh.length === 0) return;
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let created = false;
    try {
      await stat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      created = true;
    }
    // 'a+' (not 'a') so the torn-tail check can read the final byte.
    const handle = await open(this.filePath, 'a+', 0o600);
    try {
      // Mode on open only applies at creation; tighten a file an older build
      // left at the default umask.
      await handle.chmod(0o600);
      const size = (await handle.stat()).size;
      if (size > 0 && !(await endsWithNewline(handle, size))) {
        await truncateTornTail(handle, size);
      }
      for (const record of fresh) {
        await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' });
        this.index.set(record.intentId, record);
      }
      // Flush bytes before the state snapshot (saved right after this append)
      // is allowed to consider the record durable.
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (created) await fsyncDirectory(dir);
  }

  find(intentId: string): Promise<ArchivedIntentRecord | undefined> {
    return Promise.resolve(this.index.get(intentId));
  }

  findByBranch(runId: string, vassal: string): Promise<string | undefined> {
    for (const record of this.index.values()) {
      if (record.result.branches.some(branch => branch.runId === runId && branch.vassal === vassal)) {
        return Promise.resolve(record.intentId);
      }
    }
    return Promise.resolve(undefined);
  }

  /** Total archived records (index size). */
  size(): number {
    return this.index.size;
  }
}

/** Whether the file's final byte is a newline (the only valid line ending). */
async function endsWithNewline(handle: FileHandle, size: number): Promise<boolean> {
  const tail = Buffer.alloc(1);
  await handle.read(tail, 0, 1, size - 1);
  return tail[0] === 0x0a;
}

/**
 * Drop the partial bytes a crashed append left after the last complete line.
 * Scans backwards in chunks so a large archive is not read into memory; a
 * file whose very first record was torn (no newline anywhere) is emptied.
 */
async function truncateTornTail(handle: FileHandle, size: number): Promise<void> {
  const CHUNK = 64 * 1024;
  let position = size;
  while (position > 0) {
    const start = Math.max(0, position - CHUNK);
    const length = position - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    const newline = buffer.lastIndexOf(0x0a);
    if (newline !== -1) {
      await handle.truncate(start + newline + 1);
      return;
    }
    position = start;
  }
  await handle.truncate(0);
}

/** Flush a directory entry change (file creation) so it survives power loss. */
async function fsyncDirectory(dir: string): Promise<void> {
  const dirHandle = await open(dir, 'r');
  try {
    await dirHandle.sync();
  } catch (error) {
    // Windows cannot fsync a directory handle (EPERM); the directory-fsync
    // durability contract is not expressible there and NTFS journaling covers
    // the entry change. Ignore EPERM on win32 only; any other failure still throws.
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  } finally {
    await dirHandle.close();
  }
}

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
import { mkdir, open, readFile } from 'node:fs/promises';
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
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const record = JSON.parse(line) as ArchivedIntentRecord;
      this.index.set(record.intentId, record);
    }
  }

  /** Append records atomically (tmp + rename per line batch is not needed:
   *  duplicates are skipped by key, so a crash mid-write at worst loses the
   *  tail and the next flush re-appends). New keys only. */
  async append(records: readonly ArchivedIntentRecord[]): Promise<void> {
    if (records.length === 0) return;
    const fresh = records.filter(record => !this.index.has(record.intentId));
    if (fresh.length === 0) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const handle = await open(this.filePath, 'a');
    try {
      for (const record of fresh) {
        const line = JSON.stringify(record);
        await handle.writeFile(`${line}\n`, { encoding: 'utf8' });
        this.index.set(record.intentId, record);
      }
    } finally {
      await handle.close();
    }
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

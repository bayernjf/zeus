// design-evals (tech map S7) W4-2: eval run persistence + query (FR5-2).
//
// Storage follows the JsonlTraceExporter pattern exactly: append-only JSONL,
// one record per line, keyed append by runId so an interrupted flush followed
// by a retry cannot double-write, 0700 directory / 0600 file, and an
// insertion-ordered in-memory index rebuilt by loadIndex so a restart reads
// the same runs the previous process left behind. A single operator's volume
// is the index; the query projects filters over it.
//
// Record shape is a superset of the legacy evals/reports JSON artifact
// ({ ranAt, cases, report } — the runner's existing output): every legacy
// consumer field stays present at the top level, and the new identity fields
// (runId / suite / model) ride beside them. The offline runner keeps writing
// the legacy reports/ JSON unchanged; the structured store is an opt-in
// second output (--runs-file), not a replacement.

import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EvalMetricsReport, EvalResult } from './score.js';

export type EvalRunRecord = {
  /** Unique run id; the keyed-append identity. Derived from ranAt. */
  runId: string;
  /** Suite name the run belongs to (default `core` for the built-in set). */
  suite: string;
  /** Decision backend model the run booted with (`rules-only` when none). */
  model: string;
  /** Judge model that produced verdicts, when the judge was configured. */
  judgeModel?: string;
  /** Optional code revision the run exercised (CI passes the git sha). */
  revision?: string;
  /** Legacy artifact fields — unchanged from the evals/reports JSON shape. */
  ranAt: string;
  cases: EvalResult[];
  report: EvalMetricsReport;
};

export type EvalRunQuery = {
  suite?: string;
  model?: string;
  runId?: string;
  /** Inclusive ISO time window over ranAt. */
  from?: string;
  to?: string;
  limit?: number;
};

export type EvalRunQueryResult = {
  runs: EvalRunRecord[];
  count: number;
};

export const DEFAULT_EVAL_RUN_QUERY_LIMIT = 50;
export const MAX_EVAL_RUN_QUERY_LIMIT = 200;

export class JsonlEvalRunsStore {
  private index = new Map<string, EvalRunRecord>();

  constructor(private filePath: string) {}

  /** Rebuild the in-memory index from the store file. Missing file = empty. */
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
      const record = JSON.parse(line) as EvalRunRecord;
      this.index.set(record.runId, record);
    }
  }

  /** Append one run; duplicates by runId are skipped (keyed append). */
  async append(record: EvalRunRecord): Promise<void> {
    if (this.index.has(record.runId)) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      this.index.set(record.runId, record);
    } finally {
      await handle.close();
    }
  }

  /** All stored runs, oldest first (stable insertion order of the map). */
  async readBack(): Promise<EvalRunRecord[]> {
    if (this.index.size === 0) await this.loadIndex();
    return [...this.index.values()];
  }
}

/** Project the query over the stored records (oldest first) and return at
 *  most `limit` (default 50, capped 200). Pure and order-stable, like the
 *  trace query face. */
export function queryEvalRuns(records: readonly EvalRunRecord[], filter: EvalRunQuery): EvalRunQueryResult {
  const limit = Math.min(filter.limit ?? DEFAULT_EVAL_RUN_QUERY_LIMIT, MAX_EVAL_RUN_QUERY_LIMIT);
  const runs: EvalRunRecord[] = [];
  for (const record of records) {
    if (runs.length >= limit) break;
    if (filter.suite !== undefined && record.suite !== filter.suite) continue;
    if (filter.model !== undefined && record.model !== filter.model) continue;
    if (filter.runId !== undefined && record.runId !== filter.runId) continue;
    if (filter.from !== undefined || filter.to !== undefined) {
      const ranMs = Date.parse(record.ranAt);
      if (Number.isNaN(ranMs)) continue;
      if (filter.from !== undefined && ranMs < Date.parse(filter.from)) continue;
      if (filter.to !== undefined && ranMs > Date.parse(filter.to)) continue;
    }
    runs.push(record);
  }
  return { runs, count: runs.length };
}

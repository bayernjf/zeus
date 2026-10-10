/**
 * S6 V3 (design-observability §5): metrics history — the in-process
 * ConcurrencyMetrics window resets on restart, so trend questions ("did p50
 * get worse since last week") cannot be answered from the live snapshot alone.
 * This appends a MetricsSnapshot per capture to a local JSONL file, keyed by
 * `capturedAt` so a retried flush cannot double-write.
 *
 * Same data-sovereignty default as the trace exporter: local file, disabled
 * unless boot wires it (`metricsHistoryFile`). 0700 directory / 0600 file;
 * `read` returns snapshots oldest first. This is retention, not a timeseries
 * store — a caller keeps the file bounded by choosing the capture cadence.
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MetricsSnapshot } from '../orchestrator/metrics.js';

export class MetricsHistory {
  private index = new Map<string, MetricsSnapshot>();

  constructor(private filePath: string) {}

  /** Rebuild the in-memory index from the history file. Missing file = empty. */
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
      const record = JSON.parse(line) as MetricsSnapshot;
      this.index.set(record.capturedAt, record);
    }
  }

  /** Append one snapshot; duplicates by capturedAt are skipped (keyed append). */
  async capture(snapshot: MetricsSnapshot): Promise<void> {
    if (this.index.has(snapshot.capturedAt)) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, { encoding: 'utf8' });
      this.index.set(snapshot.capturedAt, snapshot);
    } finally {
      await handle.close();
    }
  }

  /** All captured snapshots, oldest first (stable insertion order of the map). */
  async read(): Promise<MetricsSnapshot[]> {
    if (this.index.size === 0) await this.loadIndex();
    return [...this.index.values()];
  }
}

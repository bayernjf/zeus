/**
 * S6 V3 (design-observability §5): a JSONL local-file TraceExporter.
 *
 * Data-sovereignty default: local file first, disabled unless a caller
 * explicitly attaches it (boot wires it only when `traceExportFile` is set).
 * No network export is shipped — OTLP/collector transport is deliberately left
 * for a future decision under explicit authorization, and the file layout here
 * is a stable interchange point for local tooling.
 *
 * Shape mirrors the intent archive (src/state/archive.ts): one record per
 * line, keyed by `traceId` so an interrupted flush followed by a retry cannot
 * double-write, 0700 directory / 0600 file. `readBack` rebuilds the in-memory
 * index, so a restart reads the same exports the previous process left behind.
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TraceExporter, TraceTree } from './trace.js';

/** One exported trace tree as persisted on the exporter JSONL. */
export type ExportedTraceRecord = { tree: TraceTree; exportedAt: string };

export class JsonlTraceExporter implements TraceExporter {
  private index = new Map<string, ExportedTraceRecord>();

  constructor(private filePath: string) {}

  /** Rebuild the in-memory index from the export file. Missing file = empty. */
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
      const record = JSON.parse(line) as ExportedTraceRecord;
      this.index.set(record.tree.traceId, record);
    }
  }

  /** Append one tree; duplicates by traceId are skipped (keyed append). */
  async export(tree: TraceTree): Promise<void> {
    if (this.index.has(tree.traceId)) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const record: ExportedTraceRecord = { tree, exportedAt: new Date().toISOString() };
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      this.index.set(tree.traceId, record);
    } finally {
      await handle.close();
    }
  }

  /** All exported trees, oldest first (stable insertion order of the map). */
  async readBack(): Promise<TraceTree[]> {
    if (this.index.size === 0) await this.loadIndex();
    return [...this.index.values()].map(record => record.tree);
  }
}

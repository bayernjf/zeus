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
 *
 * A kill mid-write can leave one torn record on the tail without its newline:
 * loadIndex tolerates exactly that case (a torn tail, never an interior line),
 * and the next capture truncates the partial bytes before writing. Each append
 * is fsynced (and the directory when the file was created).
 */
import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises';
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
    const lines = raw.split('\n');
    let lastNonEmpty = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.trim() !== '') lastNonEmpty = i;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim() === '') continue;
      let record: MetricsSnapshot;
      try {
        record = JSON.parse(line) as MetricsSnapshot;
      } catch (error) {
        // Only the final non-empty line may be a torn tail from a crashed
        // capture; an unparseable interior line is corruption we surface.
        if (i === lastNonEmpty) break;
        throw new Error(
          `unreadable metrics record on line ${i + 1} of ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.index.set(record.capturedAt, record);
    }
  }

  /** Append one snapshot; duplicates by capturedAt are skipped (keyed append). */
  async capture(snapshot: MetricsSnapshot): Promise<void> {
    if (this.index.has(snapshot.capturedAt)) return;
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
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, { encoding: 'utf8' });
      this.index.set(snapshot.capturedAt, snapshot);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (created) await fsyncDirectory(dir);
  }

  /** All captured snapshots, oldest first (stable insertion order of the map). */
  async read(): Promise<MetricsSnapshot[]> {
    if (this.index.size === 0) await this.loadIndex();
    return [...this.index.values()];
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
 * Scans backwards in chunks so a large history is not read into memory; a
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

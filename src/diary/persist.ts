/**
 * Persistence and export (design-diary §6). Persisting goes through
 * DataDomainStore.write so the diary never touches the filesystem directly;
 * structured export is a stable JSON string.
 */
import type { DataDomainStore } from '../dataDomain/types.js';
import type { DiaryEntry, PersistDiaryOptions } from './types.js';
import { DiaryUnsupportedError } from './types.js';
import { stableStringify } from './render.js';

export async function persistDiary(
  store: DataDomainStore,
  entry: DiaryEntry,
  options: PersistDiaryOptions = {},
): Promise<{ itemId: string }> {
  if (typeof store.write !== 'function') {
    throw new DiaryUnsupportedError('DataDomainStore has no write capability; cannot persist diary');
  }
  const dir = options.dir ?? 'diary';
  const itemId = `${dir}/${entry.date}.md`;
  const result = await store.write(entry.dataDomainId, { itemId, data: entry.markdown }, options.grant);
  return { itemId: result.itemId };
}

/** Stable, traceable JSON export of one or more diary entries. */
export function exportDiary(entries: DiaryEntry[]): string {
  return stableStringify(entries);
}

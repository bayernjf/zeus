/**
 * Persistence and export (design-diary §6). Persisting goes through
 * RealmStore.write so the diary never touches the filesystem directly;
 * structured export is a stable JSON string.
 */
import type { RealmStore } from '../realm/types.js';
import type { DiaryEntry, PersistDiaryOptions } from './types.js';
import { DiaryUnsupportedError } from './types.js';
import { stableStringify } from './render.js';

export async function persistDiary(
  store: RealmStore,
  entry: DiaryEntry,
  options: PersistDiaryOptions = {},
): Promise<{ itemId: string }> {
  if (typeof store.write !== 'function') {
    throw new DiaryUnsupportedError('RealmStore has no write capability; cannot persist diary');
  }
  const dir = options.dir ?? 'diary';
  const itemId = `${dir}/${entry.date}.md`;
  const result = await store.write(entry.realmId, { itemId, data: entry.markdown }, options.grant);
  return { itemId: result.itemId };
}

/** Stable, traceable JSON export of one or more diary entries. */
export function exportDiary(entries: DiaryEntry[]): string {
  return stableStringify(entries);
}

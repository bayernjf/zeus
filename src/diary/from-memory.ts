/**
 * buildDiariesFromState (E8.3): build diary entries from a whole MemoryState.
 * A diary cannot mix realms, so events are grouped per realm and each group is
 * built with that realm's facts. Optionally restrict to one realm and/or one
 * calendar date. Pure and deterministic; zero I/O.
 */
import type { MemoryState } from '../memory/types.js';
import type { DiaryEntry } from './types.js';
import { buildDiary } from './build.js';

export type BuildDiariesOptions = {
  /** Build only this realm's diaries; when omitted, every realm is built. */
  realmId?: string;
  /** Keep only this calendar date (YYYY-MM-DD). */
  date?: string;
  /** IANA zone for day buckets and time formatting; defaults to UTC. */
  timeZone?: string;
};

export function buildDiariesFromState(state: MemoryState, options: BuildDiariesOptions = {}): DiaryEntry[] {
  const eventsByRealm = new Map<string, typeof state.events>();
  for (const event of state.events) {
    const list = eventsByRealm.get(event.realmId);
    if (list) list.push(event);
    else eventsByRealm.set(event.realmId, [event]);
  }
  const factsByRealm = new Map(state.facts);
  const realmIds = options.realmId ? [options.realmId] : [...eventsByRealm.keys()];

  const entries: DiaryEntry[] = [];
  for (const realmId of realmIds) {
    const realmEvents = eventsByRealm.get(realmId);
    if (!realmEvents || realmEvents.length === 0) continue;
    const facts = factsByRealm.get(realmId) ?? [];
    entries.push(...buildDiary(realmEvents, { facts, ...(options.timeZone ? { timeZone: options.timeZone } : {}) }));
  }

  const sorted = entries.sort((a, b) =>
    a.date === b.date ? a.realmId.localeCompare(b.realmId) : a.date.localeCompare(b.date),
  );
  return options.date ? sorted.filter(entry => entry.date === options.date) : sorted;
}

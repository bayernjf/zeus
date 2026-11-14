/**
 * buildDiariesFromState (E8.3): build diary entries from a whole MemoryState.
 * A diary cannot mix dataDomains, so events are grouped per dataDomain and each group is
 * built with that dataDomain's facts. Optionally restrict to one dataDomain and/or one
 * calendar date. Pure and deterministic; zero I/O.
 */
import type { MemoryState } from '../memory/types.js';
import type { DiaryEntry } from './types.js';
import { buildDiary } from './build.js';

export type BuildDiariesOptions = {
  /** Build only this dataDomain's diaries; when omitted, every dataDomain is built. */
  dataDomainId?: string;
  /** Keep only this calendar date (YYYY-MM-DD). */
  date?: string;
  /** IANA zone for day buckets and time formatting; defaults to UTC. */
  timeZone?: string;
};

export function buildDiariesFromState(state: MemoryState, options: BuildDiariesOptions = {}): DiaryEntry[] {
  const eventsByDataDomain = new Map<string, typeof state.events>();
  for (const event of state.events) {
    const list = eventsByDataDomain.get(event.dataDomainId);
    if (list) list.push(event);
    else eventsByDataDomain.set(event.dataDomainId, [event]);
  }
  const factsByDataDomain = new Map(state.facts);
  const dataDomainIds = options.dataDomainId ? [options.dataDomainId] : [...eventsByDataDomain.keys()];

  const entries: DiaryEntry[] = [];
  for (const dataDomainId of dataDomainIds) {
    const dataDomainEvents = eventsByDataDomain.get(dataDomainId);
    if (!dataDomainEvents || dataDomainEvents.length === 0) continue;
    const facts = factsByDataDomain.get(dataDomainId) ?? [];
    entries.push(...buildDiary(dataDomainEvents, { facts, ...(options.timeZone ? { timeZone: options.timeZone } : {}) }));
  }

  const sorted = entries.sort((a, b) =>
    a.date === b.date ? a.dataDomainId.localeCompare(b.dataDomainId) : a.date.localeCompare(b.date),
  );
  return options.date ? sorted.filter(entry => entry.date === options.date) : sorted;
}

/**
 * buildDiary: pure, deterministic narrative construction (design-diary §4.3).
 * Buckets events into calendar days, renders traceable lines, optionally
 * surfaces facts, and computes a content digest. Zero I/O.
 */
import type { MemoryEvent, FactRecord } from '../memory/types.js';
import { sha256Hex } from '../util/crypto.js';
import { renderEventContent, dayBucket, stableStringify } from './render.js';
import { renderDiaryMarkdown } from './markdown.js';
import type { BuildDiaryOptions, DiaryEntry, DiaryLine, DiaryFact } from './types.js';
import { DiaryBoundaryError } from './types.js';

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function toLine(event: MemoryEvent, text: string): DiaryLine {
  const line: DiaryLine = {
    eventId: event.eventId,
    runId: event.runId,
    agentId: event.source.agentId,
    kind: event.kind,
    text,
    refs: [...event.refs],
    confidence: event.confidence,
    occurredAt: event.occurredAt,
  };
  if (event.source.taskId) line.taskId = event.source.taskId;
  return line;
}

function toFact(fact: FactRecord): DiaryFact {
  return {
    factId: fact.factId,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    status: fact.status,
    confidence: fact.confidence,
    version: fact.version,
  };
}

export function buildDiary(events: MemoryEvent[], options: BuildDiaryOptions = {}): DiaryEntry[] {
  if (events.length === 0) return [];
  const tz = options.timeZone ?? 'UTC';
  const maxJson = options.maxJsonLength ?? 500;

  const realmId = events[0].realmId;
  if (events.some(e => e.realmId !== realmId)) {
    throw new DiaryBoundaryError('Diary cannot mix events from multiple realms');
  }

  const buckets = new Map<string, MemoryEvent[]>();
  for (const event of events) {
    const date = dayBucket(event.occurredAt, tz);
    const bucket = buckets.get(date);
    if (bucket) bucket.push(event);
    else buckets.set(date, [event]);
  }

  const entries: DiaryEntry[] = [];
  const sortedDates = [...buckets.keys()].sort();
  for (const date of sortedDates) {
    const dayEvents = buckets.get(date)!;
    const sorted = [...dayEvents].sort((a, b) => {
      const byTime = a.occurredAt.localeCompare(b.occurredAt);
      return byTime !== 0 ? byTime : a.eventId.localeCompare(b.eventId);
    });
    const dayEventIds = new Set(sorted.map(e => e.eventId));

    const lines = sorted.map(e => {
      const text = options.renderContent
        ? options.renderContent(e.content, e)
        : renderEventContent(e.content, maxJson);
      return toLine(e, text);
    });

    const matchedFacts = (options.facts ?? [])
      .filter(f => f.realmId === realmId)
      .filter(
        f => f.provenance.some(id => dayEventIds.has(id)) || dayBucket(f.updatedAt, tz) === date,
      )
      .map(toFact);
    const facts = [...new Map(matchedFacts.map(f => [f.factId, f])).values()].sort((a, b) =>
      a.factId.localeCompare(b.factId),
    );

    const windowStart = sorted[0].occurredAt;
    const windowEnd = sorted[sorted.length - 1].occurredAt;
    const id = `diary:${realmId}:${date}`;
    const provenance = uniqueSorted([
      ...sorted.map(e => e.eventId),
      ...facts.map(f => f.factId),
    ]);

    const entry: DiaryEntry = {
      format: 'zeus-diary',
      version: 1,
      id,
      realmId,
      date,
      windowStart,
      windowEnd,
      lines,
      facts,
      provenance,
      markdown: '',
      digest: '',
    };

    // Digest over canonical content, excluding the self-referential markdown/digest.
    entry.digest = sha256Hex(
      stableStringify({
        format: entry.format,
        version: entry.version,
        id,
        realmId,
        date,
        windowStart,
        windowEnd,
        lines,
        facts,
        provenance,
      }),
    );
    entry.markdown = renderDiaryMarkdown(entry, tz);
    entries.push(entry);
  }

  return entries;
}

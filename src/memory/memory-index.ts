/**
 * Layered memory index (AM-01).
 *
 * A deterministic `memory-index.md` plus one `topics/<slug>.md` per topic,
 * rebuilt purely from the active fact store. The top-level index stays small
 * (≤200 lines / 25KiB) so it can be injected into every context; topic detail
 * is read on demand instead of being carried around unused.
 *
 * The generator is a pure function of the fact source — no clock, no random
 * ids, no model call — so the same facts always rebuild the same files. Topic
 * keys collapse per-round subjects (`project:x:round-11` → `project:x`) so the
 * index describes durable topics rather than individual runs.
 */

import { factText, INDEXABLE_STATUSES } from './recall.js';
import type { FactRecord } from './types.js';

/** Top-level index line budget (Anthropic MEMORY.md sizing, A). */
export const MAX_INDEX_LINES = 200;
/** Top-level index byte budget (Anthropic MEMORY.md sizing, A). */
export const MAX_INDEX_BYTES = 25 * 1024;

/** Strip a trailing `round-N` fragment so per-round facts collapse into one topic. */
export function topicKeyFor(subject: string): string {
  return subject.replace(/[-:](?:round[-_]?\d+)$/i, '');
}

/** File-system-safe topic file name; deterministic for a given topic key. */
export function topicSlug(key: string): string {
  const slug = key
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'topic' : slug;
}

export interface TopicFile {
  /** Unique file name inside `topics/`. */
  slug: string;
  /** Original topic key this file describes. */
  key: string;
  content: string;
}

export interface MemoryIndexBuild {
  index: string;
  topics: TopicFile[];
}

interface TopicSection {
  key: string;
  slug: string;
  facts: FactRecord[];
}

function compareFacts(a: FactRecord, b: FactRecord): number {
  return (
    a.subject.localeCompare(b.subject)
    || a.predicate.localeCompare(b.predicate)
    || a.factId.localeCompare(b.factId)
  );
}

function latestUpdated(facts: FactRecord[]): string {
  let latest = '';
  for (const fact of facts) {
    if (fact.updatedAt > latest) latest = fact.updatedAt;
  }
  return latest;
}

function datePart(iso: string): string {
  return iso.slice(0, 10);
}

function predicateSummary(facts: FactRecord[]): string {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    counts.set(fact.predicate, (counts.get(fact.predicate) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([predicate, count]) => `${predicate}(${count})`)
    .join(', ');
}

function renderTopic(section: TopicSection): string {
  const lines = [`# topic: ${section.key}`, '', '## facts', ''];
  for (const fact of section.facts) {
    lines.push(`- ${factText(fact)} · status ${fact.status} · v${fact.version}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Keep as many topic lines as fit under both budgets. The header always stays;
 * when the source has more topics than fit, the excess is reported as an
 * omitted count so the consumer knows the index is truncated, not complete.
 */
function fitTopicLines(
  header: string[],
  topicLines: string[],
): { kept: string[]; omitted: number } {
  // Reserve one line for the omission note when truncation is needed.
  const maxByLines = Math.max(0, MAX_INDEX_LINES - header.length - 1);
  let kept = topicLines.slice(0, maxByLines);

  while (kept.length > 0) {
    const omitted = topicLines.length - kept.length;
    const note = omitted > 0 ? `- … (${omitted} topics omitted)` : null;
    const lines = [...header, ...kept, ...(note === null ? [] : [note])];
    if (lines.join('\n').length <= MAX_INDEX_BYTES) break;
    kept = kept.slice(0, -1);
  }

  return { kept, omitted: topicLines.length - kept.length };
}

function renderIndex(
  dataDomainId: string,
  sections: TopicSection[],
  totalFacts: number,
): string {
  const header = [
    '# memory-index',
    '',
    `dataDomain: ${dataDomainId}`,
    `factCount: ${totalFacts}`,
    `topicCount: ${sections.length}`,
    '',
    '## topics',
    '',
  ];

  const topicLines = sections.map(section => {
    const latest = latestUpdated(section.facts);
    return (
      `- [${section.key}](./topics/${section.slug}.md) — ${section.facts.length} facts`
      + ` · last updated ${datePart(latest)} · ${predicateSummary(section.facts)}`
    );
  });

  const { kept, omitted } = fitTopicLines(header, topicLines);
  const note = omitted > 0 ? `- … (${omitted} topics omitted)` : null;
  return [...header, ...kept, ...(note === null ? [] : [note])].join('\n') + '\n';
}

/** Build the layered index from an active fact store, deterministically. */
export function buildMemoryIndex(dataDomainId: string, facts: FactRecord[]): MemoryIndexBuild {
  const indexable = facts.filter(fact => INDEXABLE_STATUSES.has(fact.status));

  const byTopic = new Map<string, FactRecord[]>();
  for (const fact of indexable) {
    const key = topicKeyFor(fact.subject);
    const list = byTopic.get(key);
    if (list === undefined) byTopic.set(key, [fact]);
    else list.push(fact);
  }

  const sections: TopicSection[] = [...byTopic.entries()]
    .map(([key, topicFacts]) => ({
      key,
      slug: topicSlug(key),
      facts: topicFacts.sort(compareFacts),
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.slug.localeCompare(b.slug));

  // De-duplicate slugs so one topic file can never shadow another.
  const usedSlugs = new Set<string>();
  for (const section of sections) {
    let candidate = section.slug;
    let suffix = 2;
    while (usedSlugs.has(candidate)) {
      candidate = `${section.slug}-${suffix}`;
      suffix += 1;
    }
    section.slug = candidate;
    usedSlugs.add(candidate);
  }

  const topics = sections.map(section => ({
    slug: section.slug,
    key: section.key,
    content: renderTopic(section),
  }));

  return { index: renderIndex(dataDomainId, sections, indexable.length), topics };
}

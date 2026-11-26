import { describe, expect, it } from 'vitest';
import {
  buildMemoryIndex,
  MAX_INDEX_BYTES,
  MAX_INDEX_LINES,
  topicKeyFor,
  topicSlug,
} from '../src/memory/memory-index.js';
import type { FactRecord } from '../src/memory/types.js';

/**
 * AM-01 layered memory index: deterministic rebuild, topic collapse, the two
 * top-level budgets, non-dangling links and slug de-duplication. The index is
 * a pure function of the fact source, so every assertion here is reproducible
 * without a clock, a model call or any persisted state.
 */

const DATA_DOMAIN = 'dd-1';

function fact(overrides: Partial<FactRecord> & Pick<FactRecord, 'factId'>): FactRecord {
  return {
    dataDomainId: DATA_DOMAIN,
    subject: 'project:alpha:round-1',
    predicate: 'deployment-health',
    object: 'healthy',
    status: 'active',
    provenance: [],
    confidence: 0.5,
    version: 1,
    updatedAt: '2026-11-24T11:48:56.612Z',
    ...overrides,
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe('topicKeyFor', () => {
  it('strips a trailing round fragment', () => {
    expect(topicKeyFor('project:alpha:round-11')).toBe('project:alpha');
    expect(topicKeyFor('project:alpha:round-1')).toBe('project:alpha');
    expect(topicKeyFor('project:alpha-round_3')).toBe('project:alpha');
  });

  it('leaves subjects without a round fragment intact', () => {
    expect(topicKeyFor('user-preference')).toBe('user-preference');
    expect(topicKeyFor('plain subject')).toBe('plain subject');
  });
});

describe('topicSlug', () => {
  it('produces a file-safe, deterministic name', () => {
    expect(topicSlug('project:alpha')).toBe('project-alpha');
    expect(topicSlug('a b/c')).toBe('a-b-c');
  });

  it('falls back to a stable name when everything is stripped', () => {
    expect(topicSlug('///')).toBe('topic');
  });
});

describe('buildMemoryIndex', () => {
  it('rebuilds identical files for identical facts', () => {
    const facts = [
      fact({ factId: 'a' }),
      fact({ factId: 'b', subject: 'project:beta:round-2', predicate: 'settled-decision' }),
    ];
    const first = buildMemoryIndex(DATA_DOMAIN, facts);
    const second = buildMemoryIndex(DATA_DOMAIN, facts);
    expect(first.index).toBe(second.index);
    expect(first.topics).toEqual(second.topics);
  });

  it('collapses per-round subjects into one topic', () => {
    const facts = [
      fact({ factId: 'a', subject: 'project:alpha:round-1' }),
      fact({ factId: 'b', subject: 'project:alpha:round-2' }),
      fact({ factId: 'c', subject: 'project:beta:round-1' }),
    ];
    const { index, topics } = buildMemoryIndex(DATA_DOMAIN, facts);
    expect(topics.map(topic => topic.key)).toEqual(['project:alpha', 'project:beta']);
    expect(index).toContain('[project:alpha](./topics/project-alpha.md) — 2 facts');
  });

  it('excludes superseded and retracted facts from the index', () => {
    const facts = [
      fact({ factId: 'a', status: 'active' }),
      fact({ factId: 'b', status: 'disputed' }),
      fact({ factId: 'c', status: 'superseded' }),
      fact({ factId: 'd', status: 'retracted' }),
    ];
    const { index } = buildMemoryIndex(DATA_DOMAIN, facts);
    expect(index).toContain('factCount: 2');
  });

  it('keeps the top-level index within the line budget', () => {
    const facts = Array.from({ length: 250 }, (_, index) => fact({
      factId: `f${index}`,
      subject: `project:p${index}:round-1`,
    }));
    const { index } = buildMemoryIndex(DATA_DOMAIN, facts);
    expect(index.trimEnd().split('\n').length).toBeLessThanOrEqual(MAX_INDEX_LINES);
    expect(index).toContain('topics omitted');
  });

  it('truncates by bytes even when the line budget is ample', () => {
    const facts = Array.from({ length: 50 }, (_, index) => fact({
      factId: `f${index}`,
      subject: `project:${'k'.repeat(600)}${index}:round-1`,
    }));
    const { index } = buildMemoryIndex(DATA_DOMAIN, facts);
    expect(byteLength(index)).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    expect(index).toContain('topics omitted');
  });

  it('links every top-level entry to a unique, generated topic file', () => {
    const facts = Array.from({ length: 30 }, (_, index) => fact({
      factId: `f${index}`,
      subject: `project:p${index}:round-1`,
    }));
    const { index, topics } = buildMemoryIndex(DATA_DOMAIN, facts);

    const slugs = topics.map(topic => topic.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const links = [...index.matchAll(/\]\(\.\/topics\/([^)]+)\.md\)/g)].map(match => match[1]);
    expect(links.length).toBe(slugs.length);
    for (const link of links) {
      expect(slugs).toContain(link);
    }
  });

  it('de-duplicates colliding slugs instead of shadowing a topic', () => {
    const facts = [
      fact({ factId: 'a', subject: 'project:a b' }),
      fact({ factId: 'b', subject: 'project:a-b' }),
    ];
    const { topics } = buildMemoryIndex(DATA_DOMAIN, facts);
    expect(new Set(topics.map(topic => topic.slug)).size).toBe(2);
    expect(topics.map(topic => topic.slug).sort()).toEqual(['project-a-b', 'project-a-b-2']);
  });

  it('sorts facts inside each topic deterministically', () => {
    const facts = [
      fact({ factId: 'z', subject: 'project:a', predicate: 'beta' }),
      fact({ factId: 'a', subject: 'project:a', predicate: 'alpha' }),
    ];
    const { topics } = buildMemoryIndex(DATA_DOMAIN, facts);
    expect(topics).toHaveLength(1);
    const content = topics[0]!.content;
    expect(content.indexOf('alpha')).toBeGreaterThan(-1);
    expect(content.indexOf('beta')).toBeGreaterThan(-1);
    expect(content.indexOf('alpha')).toBeLessThan(content.indexOf('beta'));
  });
});

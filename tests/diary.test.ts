import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDiary,
  persistDiary,
  exportDiary,
  renderEventContent,
  NO_CONTENT,
  DiaryBoundaryError,
  DiaryUnsupportedError,
  FsRealmStore,
} from '../src/index.js';
import type { MemoryEvent, FactRecord, RealmStore, DriverWriteGrant } from '../src/index.js';

let seq = 0;
function event(partial: Partial<MemoryEvent> & { occurredAt: string }): MemoryEvent {
  seq += 1;
  return {
    eventId: `evt-${String(seq).padStart(3, '0')}`,
    realmId: 'realm-test',
    runId: `run-${seq}`,
    source: { agentId: `agent-${seq}` },
    kind: 'observation',
    content: '',
    refs: [],
    confidence: 0.5,
    ...partial,
  };
}

function fact(partial: Partial<FactRecord> & { factId: string; updatedAt: string }): FactRecord {
  return {
    realmId: 'realm-test',
    subject: 'X',
    predicate: 'is',
    object: 'Y',
    status: 'active',
    provenance: [],
    confidence: 0.8,
    version: 1,
    ...partial,
  };
}

describe('buildDiary', () => {
  it('returns an empty list for no events', () => {
    expect(buildDiary([])).toEqual([]);
  });

  it('buckets events into calendar days and sorts dates', () => {
    const entries = buildDiary([
      event({ occurredAt: '2026-09-24T09:00:00.000Z' }),
      event({ occurredAt: '2026-09-23T09:00:00.000Z' }),
    ]);
    expect(entries.map(e => e.date)).toEqual(['2026-09-23', '2026-09-24']);
  });

  it('orders lines by occurredAt, ties broken by eventId', () => {
    const entries = buildDiary([
      event({ eventId: 'evt-b', occurredAt: '2026-09-23T09:00:00.000Z', content: 'B' }),
      event({ eventId: 'evt-a', occurredAt: '2026-09-23T09:00:00.000Z', content: 'A' }),
      event({ eventId: 'evt-c', occurredAt: '2026-09-23T08:00:00.000Z', content: 'C' }),
    ]);
    expect(entries[0].lines.map(l => l.eventId)).toEqual(['evt-c', 'evt-a', 'evt-b']);
  });

  it('keeps every line traceable and provenance covering all sources', () => {
    const entries = buildDiary([
      event({ eventId: 'evt-1', occurredAt: '2026-09-23T09:00:00.000Z' }),
      event({ eventId: 'evt-2', occurredAt: '2026-09-23T10:00:00.000Z' }),
    ]);
    for (const line of entries[0].lines) expect(line.eventId).toMatch(/^evt-/);
    expect(entries[0].provenance).toEqual(['evt-1', 'evt-2']);
  });

  it('rejects mixed-realm input', () => {
    expect(() =>
      buildDiary([
        event({ realmId: 'r1', occurredAt: '2026-09-23T09:00:00.000Z' }),
        event({ realmId: 'r2', occurredAt: '2026-09-23T10:00:00.000Z' }),
      ]),
    ).toThrow(DiaryBoundaryError);
  });

  it('is deterministic for the same input', () => {
    const events = [
      event({ eventId: 'evt-1', occurredAt: '2026-09-23T09:00:00.000Z', content: 'A' }),
      event({ eventId: 'evt-2', occurredAt: '2026-09-23T10:00:00.000Z', content: 'B' }),
    ];
    expect(buildDiary(events)).toEqual(buildDiary(events));
  });

  it('changes digest when any content changes', () => {
    const base = {
      eventId: 'evt-same',
      realmId: 'r',
      runId: 'run',
      source: { agentId: 'a' },
      kind: 'observation' as const,
      refs: [] as string[],
      confidence: 0.5,
    };
    const a = buildDiary([{ ...base, content: 'A', occurredAt: '2026-09-23T09:00:00.000Z' }]);
    const b = buildDiary([{ ...base, content: 'B', occurredAt: '2026-09-23T09:00:00.000Z' }]);
    expect(a[0].digest).not.toBe(b[0].digest);
  });

  it('honors a time zone for day buckets', () => {
    const instant = '2026-09-23T17:30:00.000Z'; // 09-24 01:30 in Shanghai
    expect(buildDiary([event({ occurredAt: instant })])[0].date).toBe('2026-09-23');
    expect(buildDiary([event({ occurredAt: instant })], { timeZone: 'Asia/Shanghai' })[0].date).toBe(
      '2026-09-24',
    );
  });

  it('surfaces facts whose provenance hits the day and records them in provenance', () => {
    const events = [event({ eventId: 'evt-1', occurredAt: '2026-09-23T09:00:00.000Z' })];
    const facts = [fact({ factId: 'fct-1', provenance: ['evt-1'], updatedAt: '2026-09-23T10:00:00.000Z' })];
    const entries = buildDiary(events, { facts });
    expect(entries[0].facts.map(f => f.factId)).toEqual(['fct-1']);
    expect(entries[0].provenance).toContain('fct-1');
    expect(entries[0].markdown).toContain('## Facts');
  });

  it('omits the Facts section when there are no facts', () => {
    const entries = buildDiary([event({ occurredAt: '2026-09-23T09:00:00.000Z' })]);
    expect(entries[0].facts).toEqual([]);
    expect(entries[0].markdown).not.toContain('## Facts');
  });

  it('uses an injected content renderer', () => {
    const entries = buildDiary([event({ occurredAt: '2026-09-23T09:00:00.000Z', content: { x: 1 } })], {
      renderContent: () => 'CUSTOM',
    });
    expect(entries[0].lines[0].text).toBe('CUSTOM');
  });
});

describe('renderEventContent', () => {
  it('renders the four content shapes without inventing text', () => {
    expect(renderEventContent('hello', 500)).toBe('hello');
    expect(renderEventContent('', 500)).toBe(NO_CONTENT);
    expect(renderEventContent(null, 500)).toBe(NO_CONTENT);
    expect(renderEventContent(undefined, 500)).toBe(NO_CONTENT);
    expect(renderEventContent({ subject: 'S', predicate: 'p', object: 'O' }, 500)).toBe('S p O');
    expect(renderEventContent({ k: 1 }, 500)).toBe('{"k":1}');
  });

  it('truncates oversized objects and marks them', () => {
    const text = renderEventContent({ a: 'x'.repeat(600) }, 500);
    expect(text).toContain('(truncated)');
    expect(text.length).toBeLessThan(530);
  });
});

describe('markdown', () => {
  it('renders a traceable timeline with header, window and event anchors', () => {
    const entries = buildDiary([
      event({
        eventId: 'evt-9',
        occurredAt: '2026-09-23T09:12:00.000Z',
        kind: 'decision',
        content: 'approve',
        confidence: 0.95,
      }),
    ]);
    const md = entries[0].markdown;
    expect(md).toContain('# Diary · 2026-09-23');
    expect(md).toContain('realm: realm-test · 1 event');
    expect(md).toContain('**decision**');
    expect(md).toContain('approve');
    expect(md).toContain('event:evt-9');
    expect(md).toContain('confidence 0.95');
  });
});

describe('persistDiary', () => {
  it('writes through Realm.write with a deterministic itemId', async () => {
    const write = vi.fn(async () => ({ itemId: 'diary/2026-09-23.md' }));
    const store = { write } as unknown as RealmStore;
    const entries = buildDiary([event({ occurredAt: '2026-09-23T09:00:00.000Z', content: 'A' })]);
    const result = await persistDiary(store, entries[0]);
    expect(result.itemId).toBe('diary/2026-09-23.md');
    expect(write).toHaveBeenCalledWith(
      'realm-test',
      { itemId: 'diary/2026-09-23.md', data: expect.stringContaining('# Diary') },
      undefined,
    );
  });

  it('supports a custom dir and passes a grant through', async () => {
    const write = vi.fn(async () => ({ itemId: 'journal/2026-09-23.md' }));
    const store = { write } as unknown as RealmStore;
    const grant: DriverWriteGrant = {
      kind: 'driver-write',
      realmId: 'realm-test',
      grantedBy: 'driver',
      grantedAt: '2026-09-23T00:00:00.000Z',
      nonce: 'n1',
    };
    const entries = buildDiary([event({ occurredAt: '2026-09-23T09:00:00.000Z' })]);
    await persistDiary(store, entries[0], { dir: 'journal', grant });
    expect(write).toHaveBeenCalledWith(
      'realm-test',
      { itemId: 'journal/2026-09-23.md', data: expect.any(String) },
      grant,
    );
  });

  it('throws when the store has no write capability', async () => {
    const entries = buildDiary([event({ occurredAt: '2026-09-23T09:00:00.000Z' })]);
    await expect(persistDiary({} as RealmStore, entries[0])).rejects.toBeInstanceOf(
      DiaryUnsupportedError,
    );
  });

  it('end-to-end: persists into a real realm and reads the markdown back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diary-e2e-'));
    try {
      const store = new FsRealmStore();
      const manifest = await store.connect(root, 'personal');
      const entries = buildDiary([
        event({
          realmId: manifest.realmId,
          eventId: 'evt-e2e',
          occurredAt: '2026-09-23T09:12:00.000Z',
          content: 'found 3 docs',
        }),
      ]);
      const result = await persistDiary(store, entries[0]);
      expect(result.itemId).toBe('diary/2026-09-23.md');
      const back = await store.read(manifest.realmId, result.itemId);
      expect(back.content).toContain('# Diary · 2026-09-23');
      expect(back.content).toContain('found 3 docs');
      expect(back.content).toContain('event:evt-e2e');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('exportDiary', () => {
  it('produces stable JSON carrying provenance and digest', () => {
    const entries = buildDiary([event({ eventId: 'evt-1', occurredAt: '2026-09-23T09:00:00.000Z' })]);
    const parsed = JSON.parse(exportDiary(entries));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('digest');
    expect(parsed[0].provenance).toEqual(['evt-1']);
    expect(exportDiary(entries)).toBe(exportDiary(entries));
  });
});

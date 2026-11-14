import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMeeting, recordUtterance } from './protocol.js';
import { MeetingStore } from './store.js';

const dirs: string[] = [];

async function store(): Promise<MeetingStore> {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-meeting-'));
  dirs.push(dir);
  return new MeetingStore(dir);
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('meeting store', () => {
  it('round-trips a meeting and leaves no temp file behind', async () => {
    const s = await store();
    const created = createMeeting({ id: 'm1', topic: '是否做会议功能', createdAt: '2026-11-14T00:00:00.000Z' });
    await s.save(created);
    expect(await s.load('m1')).toEqual(created);

    const saved = await s.save(recordUtterance(created, {
      id: 'u1',
      speakerId: 'proposer-a',
      kind: 'agent',
      round: 1,
      stance: 'propose',
      claims: [{ id: 'c1', text: '先跑通单轮', evidence: [] }],
      rebuts: [],
      at: '2026-11-14T00:01:00.000Z',
    }));
    void saved;
    const names = await readdir(s.dir);
    expect(names).toEqual(['m1.json']);
  });

  it('lists meetings newest first and tolerates a missing directory', async () => {
    const missing = await store();
    expect(await missing.list()).toEqual([]);

    const s = await store();
    await s.save(createMeeting({ id: 'm-old', topic: 'old', createdAt: '2026-11-01T00:00:00.000Z' }));
    await s.save(createMeeting({ id: 'm-new', topic: 'new', createdAt: '2026-11-14T00:00:00.000Z' }));
    expect((await s.list()).map(meeting => meeting.id)).toEqual(['m-new', 'm-old']);
  });

  it('refuses ids that would escape the store directory', async () => {
    const s = await store();
    await expect(s.load('../evil')).rejects.toThrow(/invalid meeting id/);
    expect(() => createMeeting({ id: '..', topic: 'x', createdAt: 'now' })).toThrow(/must match/);
  });
});

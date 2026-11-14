// Local meeting store: one JSON file per meeting, atomic replace, no database.
// Tier 0 runs single-user locally, so a directory the human can read and diff
// is worth more than a schema.

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Meeting } from './types.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class MeetingStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingStoreError';
  }
}

export class MeetingStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathFor(id: string): string {
    if (!ID_RE.test(id)) throw new MeetingStoreError(`invalid meeting id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  async save(meeting: Meeting): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.pathFor(meeting.id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(meeting, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  }

  async load(id: string): Promise<Meeting> {
    const raw = await readFile(this.pathFor(id), 'utf8');
    return JSON.parse(raw) as Meeting;
  }

  async list(): Promise<Meeting[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const meetings: Meeting[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(join(this.dir, name), 'utf8');
      meetings.push(JSON.parse(raw) as Meeting);
    }
    return meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

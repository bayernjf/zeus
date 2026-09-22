import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('E2.5 mentorship kernel persistence', () => {
  it('restores the mentorship and certified providers across restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-mentor-'));
    const stateFile = join(dir, 'kernel.json');

    const first = await bootKernel({ stateFile });
    const firstSkills = first.skillRegistry!;
    const firstMentor = first.mentorshipLedger!;
    firstSkills.register({
      id: 'code-review',
      name: 'Code Review',
      description: 'reviews code',
      version: '1.0.0',
      tags: [],
      providedBy: ['mentor-1'],
    });
    const record = firstMentor.commission({
      skillId: 'code-review',
      mentorId: 'mentor-1',
      learnerId: 'newbie-1',
    });
    firstMentor.assess(record.id, [
      { criterion: 'competent', required: true, passed: true, score: 0.95 },
    ]);
    await first.saveState();

    const second = await bootKernel({ stateFile });
    expect(second.restoredFromSnapshot).toBe(true);
    expect(second.mentorshipLedger!.get(record.id)!.status).toBe('certified');
    expect(second.skillRegistry!.isProvider('code-review', 'newbie-1')).toBe(true);
    expect(second.skillRegistry!.isProvider('code-review', 'mentor-1')).toBe(true);
  });
});

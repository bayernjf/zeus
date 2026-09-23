import { describe, expect, it } from 'vitest';
import {
  MentorshipError,
  MentorshipLedger,
  SkillRegistry,
  type CompetencyCheck,
} from '../src/index.js';

function registryWithMentor(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register({
    id: 'code-review',
    name: 'Code Review',
    description: 'reviews code',
    version: '1.0.0',
    domain: 'code',
    tags: ['qa'],
    permissions: ['realm:read'],
    providedBy: ['mentor-1'],
  });
  return registry;
}

const passChecks: CompetencyCheck[] = [
  { criterion: 'reads diff correctly', required: true, weight: 1, passed: true, score: 0.95 },
  { criterion: 'flags defects', required: true, weight: 2, passed: true, score: 0.9 },
  { criterion: 'writes summary', weight: 1, passed: true, score: 0.85 },
];

describe('E2.5 Mentor skill transfer', () => {
  it('commissions a mentorship only when the mentor already provides the skill', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({
      skillId: 'code-review',
      mentorId: 'mentor-1',
      learnerId: 'newbie-1',
    });
    expect(record.status).toBe('teaching');
    expect(record.version).toBe('1.0.0');
  });

  it('refuses commission for a non-provider, unknown skill, or self-mentoring', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    expect(() =>
      ledger.commission({ skillId: 'code-review', mentorId: 'impostor', learnerId: 'n' }),
    ).toThrowError(MentorshipError);
    expect(() =>
      ledger.commission({ skillId: 'nope', mentorId: 'mentor-1', learnerId: 'n' }),
    ).toThrowError();
    expect(() =>
      ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'mentor-1' }),
    ).toThrowError(MentorshipError);
  });

  it('records lessons while teaching', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'newbie-1' });
    const taught = ledger.teach(record.id, [{ topic: 'reading diffs', ref: 'res-1' }]);
    expect(taught.lessons).toHaveLength(1);
    expect(taught.lessons[0].topic).toBe('reading diffs');
  });

  it('certifies and registers the learner as a new provider', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'newbie-1' });
    const assessed = ledger.assess(record.id, passChecks);

    expect(assessed.status).toBe('certified');
    expect(assessed.score).toBeCloseTo((0.95 + 2 * 0.9 + 0.85) / 4, 5);
    expect(assessed.certifiedAt).toBeDefined();
    expect(registry.isProvider('code-review', 'newbie-1')).toBe(true);

    // The learner now appears in team composition for the skill.
    const team = registry.resolveTeam(['code-review']);
    expect(team.slots[0].providers.sort()).toEqual(['mentor-1', 'newbie-1']);
  });

  it('fails certification on a failed required check without adding a provider', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'newbie-1' });
    const checks: CompetencyCheck[] = [
      { criterion: 'hard gate', required: true, passed: false, score: 0.2 },
      { criterion: 'other', passed: true, score: 0.99 },
    ];
    const assessed = ledger.assess(record.id, checks);
    expect(assessed.status).toBe('failed');
    expect(assessed.failureReason).toMatch(/required/);
    expect(registry.isProvider('code-review', 'newbie-1')).toBe(false);
  });

  it('fails when the weighted score is below threshold, honoring a custom threshold', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'newbie-1' });
    const assessed = ledger.assess(
      record.id,
      [{ criterion: 'c', passed: true, score: 0.6 }],
      { threshold: 0.8 },
    );
    expect(assessed.status).toBe('failed');
    expect(assessed.failureReason).toMatch(/below threshold/);
  });

  it('rejects assessment without checks or with an out-of-range score', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'newbie-1' });
    expect(() => ledger.assess(record.id, [])).toThrowError(MentorshipError);
    expect(() => ledger.assess(record.id, [{ criterion: 'c', passed: true, score: 2 }])).toThrowError(MentorshipError);
  });

  it('dismisses an open mentorship and refuses mutations after closing', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'newbie-1' });
    expect(ledger.dismiss(record.id, 'not a fit').status).toBe('dismissed');
    expect(() => ledger.teach(record.id, [{ topic: 'x' }])).toThrowError(MentorshipError);
  });

  it('survives export/import of the ledger', () => {
    const registry = registryWithMentor();
    const ledger = new MentorshipLedger(registry);
    const record = ledger.commission({ skillId: 'code-review', mentorId: 'mentor-1', learnerId: 'newbie-1' });
    ledger.assess(record.id, passChecks);

    const restored = new MentorshipLedger(registry);
    restored.importState(ledger.exportState());
    expect(restored.get(record.id)!.status).toBe('certified');
    expect(restored.list({ skillId: 'code-review' })).toHaveLength(1);
  });
});

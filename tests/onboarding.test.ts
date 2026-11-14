import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgRegistry } from '../src/org/registry.js';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import { DomainGrantRegistry } from '../src/dataDomain/authorization.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { MentorshipLedger } from '../src/skills/mentor.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import type { MemoryEvent } from '../src/memory/types.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { SeatGrantLedger, verifySeatGrant } from '../src/onboarding/seatGrant.js';
import { composeBriefing } from '../src/onboarding/briefing.js';
import { SeatGrantError, seatGrantId } from '../src/onboarding/types.js';
import type { SeatGrantAuditEntry } from '../src/onboarding/seatGrant.js';

const NOW = new Date('2026-09-25T09:00:00.000Z');
const now = () => NOW;

/** Which skills each executor advertises, resolved from the card URL. */
const CARDS: Record<string, string[]> = {
  'pr-helper': ['release-review'],
  senior: ['release-review'],
  'new-hire': [],
};

function cardFor(name: string, skills: string[]) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'acme' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: skills.map(id => ({ id, name: id, description: `${id} work`, tags: [id] })),
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-handshake': { version: '1', swornTo: 'zeus', domain: 'acme', dataDomains: ['personal', 'enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' },
  };
}

function routingFetch() {
  return async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    const name = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
    return new Response(JSON.stringify(cardFor(name, CARDS[name] ?? [])), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function claim(eventId: string, dataDomainId: string, subject: string, predicate: string, object: unknown, agentId: string): MemoryEvent {
  return {
    eventId,
    dataDomainId,
    runId: `run-${eventId}`,
    source: { agentId },
    kind: 'claim',
    content: { subject, predicate, object },
    refs: [],
    confidence: 0.8,
    occurredAt: '2026-09-25T08:00:00.000Z',
  };
}

type Harness = {
  org: OrgRegistry;
  dataDomains: FsDataDomainStore;
  grants: DomainGrantRegistry;
  skills: SkillRegistry;
  mentorships: MentorshipLedger;
  memory: MemoryStore;
  registry: ExecutorRegistry;
  seatGrants: SeatGrantLedger;
  audit: SeatGrantAuditEntry[];
  engDataDomainId: string;
  personalDataDomainId: string;
  deptId: string;
  register: (name: string) => Promise<unknown>;
  openFor: (over?: {
    agentId?: string;
    dataDomainId?: string;
    tenant?: string;
    requiredSkills?: string[];
  }) => ReturnType<SeatGrantLedger['open']>;
};

let sandbox: string;
let harness: Harness;

/** A department with a mentor, a learner seat, one enterprise dataDomain (scoped) and
 *  one personal dataDomain. Every collaborator is the real class, not a stub: a
 *  hand-made "mentorship says certified" double would prove nothing about E2.5. */
async function setup(): Promise<Harness> {
  const org = new OrgRegistry(now);
  const dataDomains = new FsDataDomainStore();
  const grants = new DomainGrantRegistry(now);
  const skills = new SkillRegistry(now);
  const mentorships = new MentorshipLedger(skills, now);
  const memory = new MemoryStore(() => {}, now);

  const engRoot = join(sandbox, 'eng');
  const meRoot = join(sandbox, 'me');
  await mkdir(engRoot, { recursive: true });
  await mkdir(meRoot, { recursive: true });
  await writeFile(join(engRoot, 'charter.md'), 'department charter\n');
  await writeFile(join(meRoot, 'diary.md'), 'private\n');
  const engDataDomainId = (await dataDomains.connect(engRoot, 'enterprise', { tenant: 'acme/eng' })).dataDomainId;
  const personalDataDomainId = (await dataDomains.connect(meRoot, 'personal')).dataDomainId;

  const registry = new ExecutorRegistry(routingFetch(), now, {
    onRegister: entry => skills.registerFromCard(entry.card),
  });
  const register = (name: string) => registry.register(`http://127.0.0.1/${name}/api/a2a/card`);
  await register('pr-helper');
  await register('senior');

  const audit: SeatGrantAuditEntry[] = [];
  const seatGrants = new SeatGrantLedger(
    { org, executors: registry.asExecutorLookup(), dataDomains, grants, mentorships, now },
    now,
    entry => audit.push(entry),
  );

  const dept = org.createDepartment({ name: 'Engineering', mission: 'ship the compiler safely' });
  org.assignMember(dept.departmentId, { agentId: 'pr-helper', role: 'lead', title: 'EM', skills: ['release-review'] });
  org.assignMember(dept.departmentId, { agentId: 'new-hire', role: 'member', title: 'Junior reviewer' });
  org.assignMember(dept.departmentId, { agentId: 'senior', role: 'member', title: 'Staff engineer' });

  const openFor: Harness['openFor'] = (over = {}) =>
    seatGrants.open({
      departmentId: dept.departmentId,
      agentId: over.agentId ?? 'new-hire',
      dataDomainId: over.dataDomainId ?? engDataDomainId,
      openedBy: 'operator',
      ...(over.tenant !== undefined ? { tenant: over.tenant } : {}),
      ...(over.requiredSkills ? { requiredSkills: over.requiredSkills } : {}),
    });

  return {
    org,
    dataDomains,
    grants,
    skills,
    mentorships,
    memory,
    registry,
    seatGrants,
    audit,
    engDataDomainId,
    personalDataDomainId,
    deptId: dept.departmentId,
    register,
    openFor,
  };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'zeus-onboarding-'));
  harness = await setup();
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('E9.2 opening a seatGrant file', () => {
  it('refuses an agent with no seat in the department', () => {
    expect(() => harness.openFor({ agentId: 'nobody' })).toThrow(/is not on the Engineering roster/);
  });

  it('refuses an unknown department and an unconnected dataDomain, with an error kind', () => {
    try {
      harness.seatGrants.open({ departmentId: 'dept:nope', agentId: 'new-hire', dataDomainId: harness.engDataDomainId, openedBy: 'operator' });
      expect.unreachable();
    } catch (thrown) {
      expect((thrown as SeatGrantError).kind).toBe('not-found');
    }
    try {
      harness.openFor({ dataDomainId: 'dataDomain-missing' });
      expect.unreachable();
    } catch (thrown) {
      expect((thrown as SeatGrantError).kind).toBe('not-found');
      expect((thrown as SeatGrantError).message).toMatch(/dataDomain not connected/);
    }
  });

  it('refuses a tenant scope on a personal dataDomain', () => {
    expect(() => harness.openFor({ dataDomainId: harness.personalDataDomainId, tenant: 'acme/eng' }))
      .toThrow(/belongs to an enterprise dataDomain/);
  });

  it('inherits the dataDomain tenant when none is given, and refuses to open the same seat twice', () => {
    const opened = harness.openFor();
    expect(opened.tenant).toEqual({ org: 'acme', department: 'eng' });
    expect(() => harness.openFor()).toThrow(/already open/);
    // A seat scoped broader than its own department dataDomain is refused outright.
    expect(() => harness.openFor({ agentId: 'senior', tenant: 'acme' })).toThrow(/cannot be scoped broader/);
    expect(() => harness.openFor({ agentId: 'senior', tenant: 'acme/mkt' })).toThrow(/cannot be scoped broader/);
    const narrowed = harness.openFor({ agentId: 'senior', tenant: 'acme/eng' });
    expect(narrowed.tenant).toEqual({ org: 'acme', department: 'eng' });
  });
});

describe('E9.2 the four evidence gates', () => {
  it('account: a roster seat with no executor card cannot be signed off, and registering it moves the gate', async () => {
    const record = harness.openFor();
    harness.seatGrants.waiveMentorship(record.id, { reason: 'supervised internship', by: 'operator' });
    try {
      harness.seatGrants.seatGrant(record.id, { by: 'operator' });
      expect.unreachable();
    } catch (thrown) {
      const error = thrown as SeatGrantError;
      expect(error.kind).toBe('gate');
      expect(error.blocked?.blockedOn).toBe('account');
      expect(error.blocked?.reason).toMatch(/no executor named new-hire/);
    }
    expect(harness.audit.map(entry => entry.decision)).toContain('seatGrant-refused');

    await harness.register('new-hire');
    expect(harness.seatGrants.verify(record.id).checks.account.ok).toBe(true);
  });

  it('authorization: a personal-side subject needs a DomainGrant, and the grant satisfies exactly that gate', () => {
    const record = harness.openFor({ tenant: 'acme/eng' });
    // Verify directly with no tenant: the subject is then on the personal side.
    const deps = {
      org: harness.org,
      executors: harness.registry.asExecutorLookup(),
      dataDomains: harness.dataDomains,
      grants: harness.grants,
      mentorships: harness.mentorships,
      now,
    };
    const { tenant: _omitted, ...withoutTenant } = record;
    const ungranted = verifySeatGrant(withoutTenant, deps);
    expect(ungranted.checks.authorization.ok).toBe(false);
    expect(ungranted.checks.authorization.reason).toMatch(/no read grant for enterprise dataDomain/);

    harness.grants.issue({ subject: 'new-hire', dataDomainId: harness.engDataDomainId, access: 'read', grantedBy: 'operator' });
    expect(verifySeatGrant(withoutTenant, deps).checks.authorization.ok).toBe(true);
  });

  it('mentorship: attendance is not competency - only certification opens the gate', async () => {
    await harness.register('new-hire');
    const record = harness.openFor({ requiredSkills: ['release-review'] });
    const before = harness.seatGrants.verify(record.id);
    expect(before.checks.mentorship.ok).toBe(false);
    if (!before.checks.mentorship.ok) expect(before.checks.mentorship.missing).toEqual(['release-review']);

    const first = harness.mentorships.seatGrant({
      skillId: 'release-review',
      mentorId: 'pr-helper',
      learnerId: 'new-hire',
      dataDomainId: harness.engDataDomainId,
    });
    harness.mentorships.teach(first.id, [{ topic: 'what a safe release looks like' }]);
    const failed = harness.mentorships.assess(first.id, [
      { criterion: 'blocks an unsafe deploy', passed: false, required: true, score: 0.95 },
    ]);
    expect(failed.status).toBe('failed');
    expect(harness.seatGrants.verify(record.id).checks.mentorship.ok).toBe(false);

    // A different mentor gives a fresh run; passing it certifies the learner.
    const second = harness.mentorships.seatGrant({
      skillId: 'release-review',
      mentorId: 'senior',
      learnerId: 'new-hire',
    });
    harness.mentorships.assess(second.id, [
      { criterion: 'blocks an unsafe deploy', passed: true, required: true, score: 0.9 },
    ]);
    const after = harness.seatGrants.verify(record.id);
    expect(after.checks.mentorship.ok).toBe(true);
    expect(after.checks.mentorship.certified.map(entry => entry.mentorId)).toEqual(['senior']);
    expect(harness.seatGrants.seatGrant(record.id, { by: 'operator' }).seatGranted?.by).toBe('operator');
  });

  it('mentorship: a seat with no stated competencies needs an explicit waiver', () => {
    const record = harness.openFor();
    expect(harness.seatGrants.verify(record.id).checks.mentorship.reason).toMatch(/list them or waive/);
    expect(() => harness.seatGrants.waiveMentorship(record.id, { reason: '  ', by: 'operator' }))
      .toThrow(/needs a reason/);
    expect(() => harness.seatGrants.waiveMentorship(record.id, { reason: 'skip', by: '  ' }))
      .toThrow(/needs an author/);
    const waived = harness.seatGrants.waiveMentorship(record.id, { reason: 'internship, supervised', by: 'operator' });
    expect(waived.waiver?.reason).toBe('internship, supervised');
    expect(harness.seatGrants.verify(record.id).checks.mentorship.ok).toBe(true);
  });

  it('mentorship: a waiver cannot cover a seat that does state requirements', () => {
    const record = harness.openFor({ requiredSkills: ['release-review'] });
    expect(() => harness.seatGrants.waiveMentorship(record.id, { reason: 'just let them ship', by: 'operator' }))
      .toThrow(/cannot cover a stated requirement/);
  });
});

describe('E9.2 seatGrant state is recomputed, never cached', () => {
  async function seatGrantSeat() {
    await harness.register('new-hire');
    const record = harness.openFor();
    harness.seatGrants.waiveMentorship(record.id, { reason: 'supervised internship', by: 'operator' });
    return harness.seatGrants.seatGrant(record.id, { by: 'operator' });
  }

  it('signs off and clears the task gate', async () => {
    const record = await seatGrantSeat();
    expect(record.seatGranted?.by).toBe('operator');
    expect(harness.seatGrants.verify(record.id).stage).toBe('seatGranted');
    expect(() => harness.seatGrants.assertSeatGranted(record.id)).not.toThrow();
  });

  it('a later revocation takes eligibility away by itself', async () => {
    const record = await seatGrantSeat();
    expect(harness.registry.revoke('new-hire')).toBe(true);
    try {
      harness.seatGrants.assertSeatGranted(record.id);
      expect.unreachable();
    } catch (thrown) {
      const error = thrown as SeatGrantError;
      expect(error.blocked?.blockedOn).toBe('account');
      expect(error.blocked?.reason).toMatch(/has been revoked/);
    }
  });

  it('striking the seat makes the sign-off stale', async () => {
    const record = await seatGrantSeat();
    harness.org.removeMember(harness.deptId, 'new-hire');
    const verdict = harness.seatGrants.verify(record.id);
    expect(verdict.checks.seat.ok).toBe(false);
    expect(verdict.checks.seatGrant.reason).toMatch(/seatGrant is stale/);
    expect(verdict.stage).toBe('opened');
  });

  it('withdrawing ends it, and re-seatGranting is an explicit new act', async () => {
    const record = await seatGrantSeat();
    const withdrawn = harness.seatGrants.withdraw(record.id, { by: 'operator', reason: 'moved teams' });
    expect(withdrawn.withdrawn?.reason).toBe('moved teams');
    expect(() => harness.seatGrants.assertSeatGranted(record.id)).toThrow(/withdrawn/);

    const again = harness.seatGrants.seatGrant(record.id, { by: 'other-operator' });
    expect(again.withdrawn).toBeUndefined();
    expect(again.seatGranted?.by).toBe('other-operator');
  });
});

describe('E9.1 the day-one briefing', () => {
  const brief = (record: Parameters<typeof composeBriefing>[0]) =>
    composeBriefing(record, {
      org: harness.org,
      executors: harness.registry.asExecutorLookup(),
      dataDomains: harness.dataDomains,
      grants: harness.grants,
      mentorships: harness.mentorships,
      skills: harness.skills,
      memory: harness.memory,
      now,
    });

  async function briefedRecord(requiredSkills: string[] = []) {
    await harness.register('new-hire');
    const record = harness.openFor({ requiredSkills });
    if (requiredSkills.length === 0) harness.seatGrants.waiveMentorship(record.id, { reason: 'supervised', by: 'operator' });
    return harness.seatGrants.seatGrant(record.id, { by: 'operator' });
  }

  it('assembles seat, chain, boundaries and team from runtime state alone', async () => {
    const briefing = await brief(await briefedRecord());
    expect(briefing.seat).toMatchObject({
      departmentName: 'Engineering',
      mission: 'ship the compiler safely',
      role: 'member',
      title: 'Junior reviewer',
    });
    expect(briefing.chain.lead).toBe('pr-helper');
    expect(briefing.chain.leadTitle).toBe('EM');
    expect(briefing.boundaries).toMatchObject({
      dataDomainType: 'enterprise',
      readOnly: false,
      itemCount: 1,
      canRead: true,
      // the tenant subtree admits the write at the domain edge; the
      // per-write OperatorWriteGrant is the second layer, named separately
      canWrite: true,
      writeNeedsGrant: true,
    });
    expect(briefing.boundaries.tenant).toEqual({ org: 'acme', department: 'eng' });
    expect(briefing.business.teammates.map(member => member.agentId).sort()).toEqual(['pr-helper', 'senior']);
    expect(briefing.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says so when the org has written nothing down', async () => {
    const briefing = await brief(await briefedRecord());
    expect(briefing.culture.empty).toBe(true);
    expect(briefing.culture.totalFacts).toBe(0);
    expect(briefing.gaps.join(' ')).toContain('holds no facts at all');
  });

  it('pulls org practice out of memory once it exists', async () => {
    harness.memory.append(claim(
      'evt-1',
      harness.engDataDomainId,
      'compiler team policy',
      'requires',
      'shipping the compiler safely means two approvals before any deploy',
      'pr-helper',
    ));
    await harness.memory.consolidateDataDomain(harness.engDataDomainId);
    const briefing = await brief(await briefedRecord());
    expect(briefing.culture.facts.length).toBeGreaterThan(0);
    expect(JSON.stringify(briefing.culture.facts)).toContain('two approvals before any deploy');
    expect(briefing.culture.totalFacts).toBe(1);
    expect(briefing.gaps.join(' ')).not.toContain('no recorded practice matches');
  });

  it('names who can teach each missing competency', async () => {
    const record = harness.openFor({ requiredSkills: ['release-review'] });
    const briefing = await brief(record);
    const entry = briefing.business.mentorsForMissing.find(candidate => candidate.skillId === 'release-review');
    expect(entry?.mentors.sort()).toEqual(['pr-helper', 'senior']);
    expect(briefing.competencies.missing).toEqual(['release-review']);
    expect(briefing.gaps.join(' ')).toContain('no certification yet');
  });

  it('is deterministic for unchanged state', async () => {
    const record = await briefedRecord();
    const first = await brief(record);
    const second = await brief(record);
    expect(second.digest).toBe(first.digest);
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it('reports a read-only mount as unwritable, with the rule attached', async () => {
    const roRoot = join(sandbox, 'ro');
    await mkdir(roRoot, { recursive: true });
    await writeFile(join(roRoot, 'a.md'), 'a\n');
    const roDataDomainId = (await harness.dataDomains.connect(roRoot, 'personal', { readOnly: true })).dataDomainId;
    await harness.register('new-hire');
    const record = harness.openFor({ dataDomainId: roDataDomainId });
    harness.seatGrants.waiveMentorship(record.id, { reason: 'supervised', by: 'operator' });
    const briefing = await brief(record);
    expect(briefing.boundaries.canWrite).toBe(false);
    expect(briefing.boundaries.rules.join(' ')).toContain('read-only');
  });
});

describe('E9.2 persistence', () => {
  it('round-trips seatGrant files through the runtime snapshot', async () => {
    await harness.register('new-hire');
    const record = harness.openFor();
    harness.seatGrants.waiveMentorship(record.id, { reason: 'supervised', by: 'operator' });
    harness.seatGrants.seatGrant(record.id, { by: 'operator' });

    const restored = new SeatGrantLedger({
      org: harness.org,
      executors: harness.registry.asExecutorLookup(),
      dataDomains: harness.dataDomains,
      grants: harness.grants,
      mentorships: harness.mentorships,
      now,
    }, now);
    restored.importState(JSON.parse(JSON.stringify(harness.seatGrants.exportState())));
    expect(restored.get(seatGrantId(harness.deptId, 'new-hire'))?.seatGranted?.by).toBe('operator');
    expect(() => restored.assertSeatGranted(record.id)).not.toThrow();
  });
});

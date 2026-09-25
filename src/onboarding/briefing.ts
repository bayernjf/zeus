/**
 * Day-one role briefing (E9.1: 新员工首日无人工介入获得岗位上下文).
 *
 * Everything here is *read* from a layer that already owns the fact - the
 * department establishment, the skill catalogue, the mentorship ledger, the vassal
 * directory, the realm boundary decisions, and the department's own memory. No
 * prompt template, no invented culture: when the org has written nothing down,
 * the briefing says so in `gaps` instead of dressing an empty room up as context.
 */
import { sha256Hex } from '../util/crypto.js';
import type { VassalLookup } from '../registry/registry.js';
import type { OrgRegistry } from '../org/registry.js';
import type { MentorshipLedger } from '../skills/mentor.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { MemoryStore } from '../memory/memory-store.js';
import { decideRealmAccess, type DomainGrantRegistry } from '../realm/authorization.js';
import type { RealmActor, RealmStore, TenantScope } from '../realm/types.js';
import { verifyCommission } from './commission.js';
import type { CommissionRecord } from './types.js';

export type BriefingDeps = {
  org: Pick<OrgRegistry, 'listDepartments'>;
  vassals: VassalLookup;
  realms: Pick<RealmStore, 'manifest' | 'connections'>;
  grants: Pick<DomainGrantRegistry, 'list'>;
  mentorships: Pick<MentorshipLedger, 'list'>;
  skills: Pick<SkillRegistry, 'get'>;
  memory: Pick<MemoryStore, 'searchRecall' | 'facts'>;
  now?: () => Date;
};

export type RoleBriefing = {
  agentId: string;
  departmentId: string;
  generatedAt: string;
  /** Stable over content: two briefings of an unchanged org share a digest. */
  digest: string;
  seat: {
    departmentName: string;
    mission: string;
    role: string;
    title?: string;
    requiredSkills: string[];
  };
  chain: { lead?: string; leadTitle?: string; note: string };
  competencies: {
    certified: Array<{ skillId: string; version: string; mentorId: string; score: number }>;
    missing: string[];
    waived: boolean;
  };
  business: {
    skills: Array<{ id: string; name: string; domain?: string; description: string }>;
    teammates: Array<{ agentId: string; role: string; title?: string; skills: string[] }>;
    /** Who can teach each missing competency right now, among active vassals. */
    mentorsForMissing: Array<{ skillId: string; mentors: string[] }>;
  };
  culture: {
    query: string;
    facts: Array<{ subject: string; predicate: string; object: unknown; confidence: number; updatedAt: string; score: number }>;
    /** How much this realm knows in total, so "nothing matched" and "nothing
     *  was ever written" stay distinguishable. */
    totalFacts: number;
    empty: boolean;
  };
  boundaries: {
    realmId: string;
    realmType: 'personal' | 'enterprise';
    tenant?: TenantScope;
    readOnly: boolean;
    itemCount: number;
    canRead: boolean;
    /** The domain edge only. An enterprise write additionally needs a
     *  per-write DriverWriteGrant at the store (E3.5) - `writeNeedsGrant` says
     *  which of the two layers still stands between this seat and a write. */
    canWrite: boolean;
    writeNeedsGrant: boolean;
    rules: string[];
  };
  /** What the kernel could NOT tell the newcomer - honest, not decorative. */
  gaps: string[];
};

const CULTURE_QUERIES = 5;

export async function composeBriefing(
  record: CommissionRecord,
  deps: BriefingDeps,
): Promise<RoleBriefing> {
  const now = deps.now ?? (() => new Date());
  const gaps: string[] = [];

  const department = deps.org.listDepartments().find(entry => entry.departmentId === record.departmentId);
  if (!department) throw new Error(`unknown department ${record.departmentId}`);
  const member = department.members.find(candidate => candidate.agentId === record.agentId);
  const lead = department.members.find(candidate => candidate.agentId === department.lead);

  const certified = deps.mentorships
    .list({ status: 'certified' })
    .filter(entry => entry.learnerId === record.agentId);
  const certifiedIds = new Set(certified.map(entry => entry.skillId));
  const missing = record.requiredSkills.filter(skillId => !certifiedIds.has(skillId));
  if (record.requiredSkills.length === 0 && !record.waiver) {
    gaps.push('this seat states no required competencies and no waiver - nobody decided what it must be able to do');
  }
  for (const skillId of missing) gaps.push(`no certification yet for '${skillId}'`);

  const skills: RoleBriefing['business']['skills'] = [];
  for (const skillId of record.requiredSkills) {
    const spec = deps.skills.get(skillId);
    if (spec) {
      skills.push({
        id: spec.id,
        name: spec.name,
        ...(spec.domain ? { domain: spec.domain } : {}),
        description: spec.description,
      });
    } else {
      gaps.push(`required skill '${skillId}' is not in the catalogue`);
    }
  }

  const teammates = department.members
    .filter(candidate => candidate.agentId !== record.agentId)
    .map(candidate => ({
      agentId: candidate.agentId,
      role: candidate.role,
      ...(candidate.title ? { title: candidate.title } : {}),
      skills: [...(candidate.skills ?? [])],
    }));

  const mentorsForMissing = missing.map(skillId => ({
    skillId,
    mentors: deps.vassals
      .findBySkill(skillId)
      .map(vassal => vassal.name)
      .filter(name => name !== record.agentId)
      .sort(),
  }));
  for (const entry of mentorsForMissing) {
    if (entry.mentors.length === 0) gaps.push(`no active vassal provides '${entry.skillId}' - nobody can teach it`);
  }

  // The org's culture and business facts are what its memory actually holds for
  // this realm. Same-realm read only: a cross-realm query would be the exact
  // boundary violation this layer exists to catch, and MemoryStore throws on it.
  const query = [department.mission, department.name, ...record.requiredSkills].join(' ').trim().slice(0, 160);
  const hits = query
    ? deps.memory
        .searchRecall(record.realmId, record.realmId, query, { limit: CULTURE_QUERIES })
        .map(hit => ({
          subject: hit.fact.subject,
          predicate: hit.fact.predicate,
          object: hit.fact.object,
          confidence: hit.fact.confidence,
          updatedAt: hit.fact.updatedAt,
          score: Number(hit.score.toFixed(4)),
        }))
    : [];
  const knownFacts = deps.memory.facts(record.realmId, record.realmId);
  if (hits.length === 0) {
    gaps.push(knownFacts.length === 0
      ? `memory of ${record.realmId} holds no facts at all - nobody has written the org's practice down`
      : `no recorded practice matches this seat (${knownFacts.length} fact(s) known in ${record.realmId})`);
  }

  const realm = deps.realms.connections().find(entry => entry.realmId === record.realmId);
  if (!realm) throw new Error(`realm not connected: ${record.realmId}`);
  const manifest = await deps.realms.manifest(record.realmId);
  const actor: RealmActor = record.tenant
    ? { kind: 'agent', id: record.agentId, tenant: record.tenant }
    : { kind: 'agent', id: record.agentId };
  const read = decideRealmAccess({ actor, realm, access: 'read', grants: deps.grants.list(), now });
  const write = decideRealmAccess({ actor, realm, access: 'write', grants: deps.grants.list(), now });

  const verdict = verifyCommission(record, {
    org: deps.org,
    vassals: deps.vassals,
    realms: deps.realms,
    grants: deps.grants,
    mentorships: deps.mentorships,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (verdict.blockedOn === 'commissioned' && !record.commissioned) {
    gaps.push('not commissioned yet - the seat exists but nobody has signed it off');
  }
  if (!read.ok) gaps.push(`you cannot read your own realm: ${read.detail}`);

  const briefing: Omit<RoleBriefing, 'digest' | 'generatedAt'> = {
    agentId: record.agentId,
    departmentId: record.departmentId,
    seat: {
      departmentName: department.name,
      mission: department.mission,
      role: member?.role ?? 'member',
      ...(member?.title ? { title: member.title } : {}),
      requiredSkills: [...record.requiredSkills],
    },
    chain: {
      ...(department.lead ? { lead: department.lead } : {}),
      ...(lead?.title ? { leadTitle: lead.title } : {}),
      note: department.lead
        ? `result accountability lands on ${department.lead} (department lead); conflicts the rules cannot settle escalate to the driver - you do not pick a side`
        : 'this department has no lead - result accountability has nowhere to land',
    },
    competencies: {
      certified: certified.map(entry => ({
        skillId: entry.skillId,
        version: entry.version,
        mentorId: entry.mentorId,
        score: Number(entry.score.toFixed(4)),
      })),
      missing,
      waived: Boolean(record.waiver),
    },
    business: { skills, teammates, mentorsForMissing },
    culture: { query, facts: hits, totalFacts: knownFacts.length, empty: hits.length === 0 },
    boundaries: {
      realmId: record.realmId,
      realmType: realm.type,
      ...(realm.tenant ? { tenant: realm.tenant } : {}),
      readOnly: realm.readOnly,
      itemCount: manifest.itemCount,
      canRead: read.ok,
      canWrite: write.ok,
      writeNeedsGrant: realm.type === 'enterprise',
      rules: [
        'enterprise -> personal is never allowed; no credential can authorize it',
        'personal -> enterprise requires an explicit DomainGrant from the driver',
        realm.type === 'enterprise'
          ? 'writing into this enterprise realm additionally needs a per-write DriverWriteGrant'
          : 'this personal realm is writable by default',
        'the tenant hierarchy (org / department / member) is structural - no grant loosens it',
      ].concat(realm.readOnly ? ['this realm is mounted read-only: writes refuse even when authorized'] : []),
    },
    gaps,
  };

  // Digest over content, not clock: the same org state must fingerprint the same,
  // so a first-day task can prove which briefing it was dispatched with.
  const digest = sha256Hex(JSON.stringify(stableForDigest(briefing)));

  return { ...briefing, generatedAt: now().toISOString(), digest };
}

function stableForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableForDigest);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'generatedAt')
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, nested]) => [key, stableForDigest(nested)]));
  }
  return value;
}

import type { AgentCardSkill, Fealty, RealmType } from '../a2a/types.js';
import type { VassalEntry } from './registry.js';

/**
 * Roster projector (bayjf 封神榜, design-bayjf-roster.md R0):
 * a pure projection from registry state to immutable, JSON-serializable roster
 * snapshots. The vassal's Agent Card + fealty is the single source of truth;
 * the projector only reshapes and trims, it never invents fields.
 */

export type RosterHealth = 'healthy' | 'unhealthy' | 'unknown';

export type RosterCommitments = {
  dataRealms: RealmType[];
  dataPolicy: Fealty['dataPolicy'];
  reportBack: boolean;
  escalationPolicy: Fealty['escalationPolicy'];
};

export type RosterEntry = {
  name: string;
  description?: string;
  domain: string;
  skills: AgentCardSkill[];
  commitments: RosterCommitments;
  sla?: { ackSeconds?: number };
  status: 'active' | 'revoked';
  health: RosterHealth;
  /** Probe error detail — internal view only. */
  healthDetail?: string;
  registeredAt: string;
  /** Internal endpoints — internal view only. */
  cardUrl?: string;
  taskUrl?: string;
};

/** Public view: revoked vassals removed, endpoints and probe details trimmed. */
export type PublicRosterEntry = Omit<RosterEntry, 'cardUrl' | 'taskUrl' | 'healthDetail'>;

export type RosterSnapshot<T extends RosterEntry = RosterEntry> = {
  generatedAt: string;
  scope: 'internal' | 'public';
  entries: T[];
};

type ListAllEntry = VassalEntry & { status: 'active' | 'revoked' };

/** Full governance view: every vassal including revoked, with endpoints and probe detail. */
export function projectInternalRoster(entries: ListAllEntry[], now: () => Date = () => new Date()): RosterSnapshot<RosterEntry> {
  return {
    generatedAt: now().toISOString(),
    scope: 'internal',
    entries: entries.map(toInternalEntry).sort(byName),
  };
}

/** bayjf-facing view: active vassals only, internal fields stripped. */
export function projectPublicRoster(entries: ListAllEntry[], now: () => Date = () => new Date()): RosterSnapshot<PublicRosterEntry> {
  return {
    generatedAt: now().toISOString(),
    scope: 'public',
    entries: entries
      .filter(entry => !entry.revoked)
      .map(entry => toPublicEntry(toInternalEntry(entry)))
      .sort(byName),
  };
}

function toInternalEntry(entry: ListAllEntry): RosterEntry {
  const { card, fealty } = entry;
  const health: RosterHealth = entry.lastHealthCheck
    ? entry.lastHealthCheck.ok
      ? 'healthy'
      : 'unhealthy'
    : 'unknown';
  return {
    name: card.name,
    ...(card.description ? { description: card.description } : {}),
    domain: fealty.domain,
    skills: card.skills.map(skill => ({ ...skill })),
    commitments: {
      dataRealms: [...fealty.dataRealms],
      dataPolicy: fealty.dataPolicy,
      reportBack: fealty.reportBack,
      escalationPolicy: fealty.escalationPolicy,
    },
    ...(fealty.sla ? { sla: { ...fealty.sla } } : {}),
    status: entry.status,
    health,
    ...(entry.lastHealthCheck?.detail ? { healthDetail: entry.lastHealthCheck.detail } : {}),
    registeredAt: entry.registeredAt,
    cardUrl: entry.cardUrl,
    taskUrl: entry.taskUrl,
  };
}

function toPublicEntry(entry: RosterEntry): PublicRosterEntry {
  return {
    name: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    domain: entry.domain,
    skills: entry.skills,
    commitments: entry.commitments,
    ...(entry.sla !== undefined ? { sla: entry.sla } : {}),
    status: entry.status,
    health: entry.health,
    registeredAt: entry.registeredAt,
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

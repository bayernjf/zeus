/**
 * Diary (E8.3): narrative rendering of the memory event log.
 *
 * Pure, deterministic narrative functions plus a Realm-backed persistence
 * step. Every narrative line keeps its source eventId (traceable); the diary
 * never invents content and never crosses a realm boundary.
 */
import type { MemoryKind, MemoryEvent, FactRecord, FactStatus } from '../memory/types.js';
import type { DriverWriteGrant } from '../realm/types.js';

export type { MemoryKind, MemoryEvent, FactRecord, FactStatus, DriverWriteGrant };

/** Deterministic diary id: `diary:{realmId}:{date}`. */
export type DiaryId = string;

/** One narrative line, rendered from a single MemoryEvent. */
export interface DiaryLine {
  /** Traceability anchor (required). */
  eventId: string;
  runId: string;
  agentId: string;
  taskId?: string;
  kind: MemoryKind;
  /** Deterministically rendered from content; never fabricated. */
  text: string;
  refs: string[];
  confidence: number;
  occurredAt: string;
}

/** A fact surfaced into the day's narrative (optional). */
export interface DiaryFact {
  factId: string;
  subject: string;
  predicate: string;
  object: unknown;
  status: FactStatus;
  confidence: number;
  version: number;
}

/** One diary per calendar day. */
export interface DiaryEntry {
  format: 'zeus-diary';
  version: 1;
  id: DiaryId;
  realmId: string;
  /** YYYY-MM-DD. */
  date: string;
  windowStart: string;
  windowEnd: string;
  /** Ascending by occurredAt, ties by eventId. */
  lines: DiaryLine[];
  facts: DiaryFact[];
  /** Deduplicated eventId + factId list. */
  provenance: string[];
  markdown: string;
  /** sha256 over canonical content (excludes markdown/digest). */
  digest: string;
}

export interface BuildDiaryOptions {
  /** IANA zone for day buckets and time formatting; defaults to UTC. */
  timeZone?: string;
  /** Facts to surface into the narrative. */
  facts?: FactRecord[];
  /** Custom content renderer; when omitted the safe default is used. */
  renderContent?: (content: unknown, event: MemoryEvent) => string;
  /** Max JSON length for object rendering; defaults to 500. */
  maxJsonLength?: number;
}

export interface PersistDiaryOptions {
  /** Required driver write grant for enterprise realms; omitted on personal. */
  grant?: DriverWriteGrant;
  /** Directory prefix; defaults to 'diary', yielding diary/YYYY-MM-DD.md. */
  dir?: string;
}

export class DiaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiaryError';
  }
}

/** Mixed-realm input was supplied; a diary belongs to exactly one realm. */
export class DiaryBoundaryError extends DiaryError {
  constructor(message: string) {
    super(message);
    this.name = 'DiaryBoundaryError';
  }
}

/** The RealmStore cannot persist (no write capability). */
export class DiaryUnsupportedError extends DiaryError {
  constructor(message: string) {
    super(message);
    this.name = 'DiaryUnsupportedError';
  }
}

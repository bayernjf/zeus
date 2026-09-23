/**
 * Skill as a first-class module (PRD E2).
 *
 * A SkillSpec is independent of any vassal's Agent Card: the same skill may be
 * provided by many vassals and exist in multiple co-registered versions. The
 * registry is the catalogue; vassal cards merely advertise which skills they
 * implement (importable via registerFromCard).
 */

export type SkillStatus = 'active' | 'deprecated' | 'uninstalled';

/** E2.3 hardening: narrowed permission claims plus stacked constraints. */
export type SkillHardening = {
  /** Effective claims after hardening — always a subset of the originals. */
  permissions: string[];
  /** Free-form bound descriptors, e.g. { maxRuntimeMs: 5000, readOnly: true }. */
  constraints: Record<string, unknown>;
  hardenedAt: string;
};

export type SkillSpec = {
  /** Stable skill id, e.g. 'code-review'. */
  id: string;
  name: string;
  description: string;
  /** Semver-ish 'major.minor.patch'; multiple versions coexist. */
  version: string;
  /** Capability domain, e.g. 'code' / 'research' / 'release'. */
  domain?: string;
  tags: string[];
  /** Declared input shape (free-form schema descriptor for v0.1). */
  inputs?: Record<string, unknown>;
  /** Declared output shape. */
  outputs?: Record<string, unknown>;
  /** Permission claims the skill requires, e.g. ['realm:read', 'execute']. */
  permissions?: string[];
  /** Other skill ids this one depends on. */
  dependencies?: string[];
  status: SkillStatus;
  /** Vassal names known to provide this skill version (populated on card import). */
  providedBy: string[];
  registeredAt: string;
  deprecatedAt?: string;
  /** E2.3 lifecycle. */
  installedAt?: string;
  uninstalledAt?: string;
  hardening?: SkillHardening;
};

/** Input shape accepted at registration; registry fills bookkeeping fields. */
export type SkillSpecInput = Omit<SkillSpec, 'status' | 'providedBy' | 'registeredAt'> &
  Partial<Pick<SkillSpec, 'status' | 'providedBy'>>;

export type TeamSlot = {
  skillId: string;
  /** Exactly one provider: safe to auto-assign. */
  providers: string[];
  /** More than one active provider: the driver/strategy must disambiguate (never random). */
  ambiguous: boolean;
  /** No registered provider for this skill. */
  missing: boolean;
};

export type TeamResolution = {
  slots: TeamSlot[];
  /** True when every required skill has exactly one provider. */
  complete: boolean;
  /** Skill ids with no provider. */
  missingSkills: string[];
  /** Skill ids with multiple providers (need an explicit choice). */
  ambiguousSkills: string[];
};

import type { AgentCard, AgentCardSkill } from '../a2a/types.js';
import type { SkillSpec, SkillSpecInput, SkillStatus, TeamResolution, TeamSlot } from './types.js';
import { validateSkillSpecShape, validatePermissionClaims, SkillValidationError } from './validate-spec.js';

/** Compare semver-ish 'major.minor.patch' strings. Returns -1/0/1; missing
 *  segments count as 0. Non-numeric segments fall back to lexical compare. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i] ?? '0');
    const nb = Number(pb[i] ?? '0');
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const cmp = (pa[i] ?? '0').localeCompare(pb[i] ?? '0');
      if (cmp !== 0) return cmp;
      continue;
    }
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export class SkillNotFoundError extends Error {}
export class DuplicateSkillError extends Error {}

/**
 * E2.2 Skill registry: catalogue of skill specs independent of vassal cards.
 *  - register: id + version is the unique key (re-registering is idempotent);
 *  - multiple versions of the same id coexist;
 *  - deprecate marks a version without deleting it (traceability);
 *  - get/list default to active versions, latest first.
 */
export class SkillRegistry {
  private specs = new Map<string, SkillSpec[]>(); // id -> versions

  constructor(private now: () => Date = () => new Date()) {}

  register(input: SkillSpecInput): SkillSpec {
    validateSkillSpecShape(input);
    const versions = this.specs.get(input.id) ?? [];
    if (versions.some(spec => spec.version === input.version)) {
      throw new DuplicateSkillError(`skill ${input.id}@${input.version} already registered`);
    }
    // Dependencies must reference already-registered skill ids, and adding this
    // spec must not create a dependency cycle (forward references are refused,
    // so mutually dependent skills cannot register — by design).
    this.validateDependencies(input.id, input.dependencies ?? []);

    const spec: SkillSpec = {
      ...input,
      tags: input.tags ?? [],
      dependencies: input.dependencies ?? [],
      permissions: input.permissions ?? [],
      providedBy: input.providedBy ?? [],
      status: input.status ?? 'active',
      registeredAt: this.now().toISOString(),
    };
    versions.push(spec);
    this.specs.set(input.id, versions);
    return structuredClone(spec);
  }

  private validateDependencies(id: string, dependencies: string[]): void {
    const issues: string[] = [];
    for (const dep of [...new Set(dependencies)]) {
      if (!this.specs.has(dep)) issues.push(`unknown dependency '${dep}' (register it first)`);
    }
    const edges = this.dependencyEdges();
    edges.set(id, dependencies);
    if (this.createsCycle(id, edges)) issues.push(`dependencies create a cycle involving '${id}'`);
    if (issues.length > 0) throw new SkillValidationError(issues);
  }

  /** Id-level dependency graph: union of every version's dependencies. */
  private dependencyEdges(): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    for (const [id, versions] of this.specs) {
      edges.set(id, [...new Set(versions.flatMap(spec => spec.dependencies ?? []))]);
    }
    return edges;
  }

  private createsCycle(start: string, edges: Map<string, string[]>): boolean {
    const visited = new Set<string>();
    const visit = (node: string): boolean => {
      if (node === start && visited.size > 0) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      return (edges.get(node) ?? []).some(visit);
    };
    return (edges.get(start) ?? []).some(visit);
  }

  /** Import the skills advertised on a vassal Agent Card. Card skills carry no
   *  version/permissions, so they register a '0.0.0' catalogue entry tagged to
   *  the provider; explicit specs (register()) override the catalogue entry. */
  registerFromCard(card: AgentCard): SkillSpec[] {
    const created: SkillSpec[] = [];
    for (const cardSkill of card.skills) {
      const existing = this.specs.get(cardSkill.id);
      const catalogue = existing?.find(spec => spec.version === CARD_CATALOGUE_VERSION);
      if (catalogue) {
        if (!catalogue.providedBy.includes(card.name)) catalogue.providedBy.push(card.name);
        created.push(catalogue);
        continue;
      }
      const spec = this.register({
        id: cardSkill.id,
        name: cardSkill.name,
        description: cardSkill.description,
        version: CARD_CATALOGUE_VERSION,
        tags: cardSkill.tags ?? [],
        providedBy: [card.name],
      });
      created.push(spec);
    }
    return created.map(spec => structuredClone(spec));
  }

  /** Get one skill: the latest active version by default, or an explicit
   *  version (an explicit version is returned regardless of status, so a
   *  deprecated spec remains auditable by exact version). */
  get(id: string, version?: string): SkillSpec | undefined {
    const all = this.specs.get(id);
    if (!all) return undefined;
    if (version) return structuredClone(all.find(spec => spec.version === version));
    const active = this.activeVersions(id);
    return active ? structuredClone(active[0]) : undefined;
  }

  versions(id: string): SkillSpec[] {
    const versions = this.specs.get(id);
    return versions ? [...versions].sort((a, b) => compareVersions(b.version, a.version)).map(spec => structuredClone(spec)) : [];
  }

  /** List active skills, optionally filtered by domain/tag; latest version per id first. */
  list(filter: { domain?: string; tag?: string; status?: SkillStatus } = {}): SkillSpec[] {
    const out: SkillSpec[] = [];
    for (const id of this.specs.keys()) {
      const versions = filter.status ? this.specs.get(id)!.filter(spec => spec.status === filter.status) : this.activeVersions(id);
      if (!versions || versions.length === 0) continue;
      for (const spec of versions) {
        if (filter.domain && spec.domain !== filter.domain) continue;
        if (filter.tag && !spec.tags.includes(filter.tag)) continue;
        out.push(structuredClone(spec));
      }
    }
    return out;
  }

  findByDomain(domain: string): SkillSpec[] {
    return this.list({ domain });
  }

  findByTag(tag: string): SkillSpec[] {
    return this.list({ tag });
  }

  /** Mark a version deprecated (default: latest active). Deprecated specs stay
   *  registered for traceability but drop out of default lookups. */
  deprecate(id: string, version?: string): SkillSpec {
    const target = version ? this.specs.get(id)?.find(spec => spec.version === version) : this.activeVersions(id)?.[0];
    if (!target) throw new SkillNotFoundError(`skill ${id}${version ? `@${version}` : ''} not found`);
    target.status = 'deprecated';
    target.deprecatedAt = this.now().toISOString();
    return structuredClone(target);
  }

  /**
   * E2.3 install: make a registered version effective immediately. A deprecated
   * spec cannot be reinstalled (register a new version instead).
   */
  install(id: string, version?: string): SkillSpec {
    const target = this.requireVersion(id, version);
    if (target.status === 'deprecated') {
      throw new Error(`skill ${id}@${target.version} is deprecated; register a new version`);
    }
    target.status = 'active';
    target.installedAt = this.now().toISOString();
    delete target.uninstalledAt;
    return structuredClone(target);
  }

  /**
   * E2.3 uninstall: the version immediately stops providing the skill. Team
   * resolution reads only active specs, so a re-team after uninstall shows the
   * skill missing — no cached grant survives.
   */
  uninstall(id: string, version?: string): SkillSpec {
    const target = this.requireVersion(id, version);
    target.status = 'uninstalled';
    target.uninstalledAt = this.now().toISOString();
    return structuredClone(target);
  }

  /**
   * E2.3 harden: stack extra bounds on an installed skill. Every claimed
   * permission must already be granted (a bare 'scope' grant may be narrowed
   * to 'scope:action'); claims can only shrink. Constraints are merged onto
   * any prior hardening. Hardening an uninstalled skill is refused.
   */
  harden(
    id: string,
    bounds: { permissions?: string[]; constraints?: Record<string, unknown> },
    version?: string,
  ): SkillSpec {
    const target = this.requireVersion(id, version);
    if (target.status === 'uninstalled') {
      throw new Error(`cannot harden uninstalled skill ${id}@${target.version}`);
    }
    const narrowed = bounds.permissions ?? [];
    const issues = validatePermissionClaims(narrowed);
    const current = target.hardening?.permissions ?? target.permissions ?? [];
    for (const claim of narrowed) {
      const scope = claim.split(':')[0];
      if (!current.includes(claim) && !current.includes(scope)) {
        issues.push(`hardening cannot grant ${claim}; current effective claims: ${current.join(', ')}`);
      }
    }
    if (issues.length > 0) throw new SkillValidationError(issues);

    target.hardening = {
      permissions: [...new Set(narrowed)],
      constraints: { ...(target.hardening?.constraints ?? {}), ...(bounds.constraints ?? {}) },
      hardenedAt: this.now().toISOString(),
    };
    return structuredClone(target);
  }

  /** Resolve an explicit version, or the latest one regardless of status. */
  private requireVersion(id: string, version?: string): SkillSpec {
    const all = this.specs.get(id);
    if (!all) throw new SkillNotFoundError(`skill ${id} not found`);
    if (version) {
      const target = all.find(spec => spec.version === version);
      if (!target) throw new SkillNotFoundError(`skill ${id}@${version} not found`);
      return target;
    }
    return [...all].sort((a, b) => compareVersions(b.version, a.version))[0];
  }

  /**
   * E2.4 team composition: map required skills to providers without silently
   *  picking among several candidates. A slot with multiple providers is
   *  'ambiguous' (the driver/strategy must choose); a slot with none is 'missing'.
   */
  resolveTeam(requiredSkillIds: string[]): TeamResolution {
    const slots: TeamSlot[] = requiredSkillIds.map(skillId => {
      const providers = this.providersFor(skillId);
      return {
        skillId,
        providers,
        ambiguous: providers.length > 1,
        missing: providers.length === 0,
      } satisfies TeamSlot;
    });
    return {
      slots,
      complete: slots.every(slot => !slot.ambiguous && !slot.missing),
      missingSkills: slots.filter(slot => slot.missing).map(slot => slot.skillId),
      ambiguousSkills: slots.filter(slot => slot.ambiguous).map(slot => slot.skillId),
    };
  }

  /** Active providers of a skill: explicit spec's providedBy, else the card
   *  catalogue entry's providers. */
  private providersFor(id: string): string[] {
    const versions = this.specs.get(id);
    if (!versions) return [];
    const explicit = versions.filter(spec => spec.version !== CARD_CATALOGUE_VERSION && spec.status === 'active');
    const source = explicit.length > 0 ? explicit : versions.filter(spec => spec.status === 'active');
    return [...new Set(source.flatMap(spec => spec.providedBy))].sort();
  }

  /** E2.5: true when the agent is an active provider of the skill. */
  isProvider(id: string, agentId: string): boolean {
    return this.providersFor(id).includes(agentId);
  }

  /**
   * E2.2/E2.3/E2.4 (Active work 47 §E-3): governance read for the dispatch gate.
   * Returns the catalogue's active providers, or `undefined` when the skill was
   * never registered — only the card advertises it, so there is nothing to
   * govern and auto-selection passes through unchanged. `[]` means registered
   * but no active version provides it (uninstalled/deprecated everywhere), which
   * is a refusal, not a pass-through: an uninstalled skill must stop dispatch.
   */
  activeProviders(id: string): string[] | undefined {
    if (!this.specs.has(id)) return undefined;
    return this.providersFor(id);
  }

  /**
   * E2.5: register a newly certified learner as a provider of the taught spec.
   * Only an active spec gains a provider; certification against an
   * uninstalled/deprecated version is refused. Idempotent per agent.
   */
  grantProvider(id: string, agentId: string, version?: string): SkillSpec {
    const target = version
      ? this.requireVersion(id, version)
      : this.activeVersions(id)?.[0];
    if (!target) throw new SkillNotFoundError(`skill ${id} has no active version to certify against`);
    if (target.status !== 'active') {
      throw new Error(`cannot certify provider for ${id}@${target.version} (${target.status})`);
    }
    if (!target.providedBy.includes(agentId)) target.providedBy.push(agentId);
    return structuredClone(target);
  }

  /** E2.1: serializable snapshot of every spec version. */
  exportState(): SkillSpec[] {
    return [...this.specs.values()].flat().map(spec => structuredClone(spec));
  }

  /** E2.1: replace the catalogue from a snapshot, rebuilding the id map. */
  importState(specs: SkillSpec[]): void {
    this.specs = new Map();
    for (const original of specs) {
      const spec = structuredClone(original);
      const versions = this.specs.get(spec.id) ?? [];
      versions.push(spec);
      this.specs.set(spec.id, versions);
    }
  }

  private activeVersions(id: string): SkillSpec[] | undefined {
    const versions = this.specs.get(id)?.filter(spec => spec.status === 'active');
    if (!versions || versions.length === 0) return undefined;
    return [...versions].sort((a, b) => compareVersions(b.version, a.version));
  }
}

/** Placeholder version for skills learned from a vassal card (cards carry no
 *  version). Explicitly registered specs always take precedence in lookups. */
export const CARD_CATALOGUE_VERSION = '0.0.0';

export type { AgentCardSkill };

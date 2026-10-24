/**
 * Adapter: live (read-only) kernel -> the PersonalKernelQueries port consumed by
 * the transport-agnostic MCP handler (src/realm/mcp.ts).
 *
 * Contract (design P1-1):
 *  - read-only: these methods only read registries. plan goes through the local
 *    deterministic ranker (recognizeIntent without a backend), so zero bytes
 *    leave the machine and no execute originates here.
 *  - path non-disclosure: realms are projected to realmId/type/readOnly only;
 *    the absolute root never crosses the JSON-RPC boundary.
 *  - fail loud at assembly: a booted kernel missing one of the components the
 *    port reads from is a host wiring error, not a runtime "empty catalogue".
 */
import type { KernelBoot } from '../state/boot.js';
import { rankCandidates, recognizeIntent, type SkillCatalogEntry } from '../intent/recognize.js';
import type { SkillSpec } from '../skills/types.js';
import type { PersonalKernelQueries } from './mcp.js';

/** Project a skill spec down to the public catalogue row (no permissions/inputs). */
function skillRow(spec: SkillSpec): {
  id: string;
  name: string;
  description: string;
  version: string;
  domain?: string;
  tags: string[];
} {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    ...(spec.domain ? { domain: spec.domain } : {}),
    tags: spec.tags,
  };
}

/** The catalogue shape the local ranker consumes. */
function toCatalogEntry(spec: SkillSpec): SkillCatalogEntry {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    ...(spec.aliases && spec.aliases.length > 0 ? { aliases: spec.aliases } : {}),
  };
}

export function createPersonalKernelQueries(kernel: KernelBoot): PersonalKernelQueries {
  const skills = kernel.skillRegistry;
  if (!skills) {
    throw new Error('personal kernel queries: kernel booted without a skill registry');
  }
  const realmStore = kernel.realmStore;
  if (!realmStore) {
    throw new Error('personal kernel queries: kernel booted without a realm store');
  }

  return {
    async listSkills(filter) {
      return skills
        .list({
          ...(filter?.domain ? { domain: filter.domain } : {}),
          ...(filter?.tag ? { tag: filter.tag } : {}),
        })
        .map(skillRow);
    },

    async getSkill(id, version) {
      const spec = skills.get(id, version);
      return spec ? skillRow(spec) : undefined;
    },

    async plan({ text, realm }) {
      // Local ranker only: no backend, no model, no outbound call. The ranked
      // candidates are forwarded alongside the recognition verdict so the client
      // sees why a skill was (or was not) chosen.
      const catalog = skills.list().map(toCatalogEntry);
      const candidates = rankCandidates(catalog, text);
      const result = await recognizeIntent({ text, catalog, realm: realm ?? 'personal' });
      if (result.ok) {
        return {
          ok: true,
          chosenBy: 'local-ranker',
          skill: result.intent.skill,
          confidence: result.confidence,
          candidates,
        };
      }
      return {
        ok: false,
        chosenBy: 'local-ranker',
        reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        candidates,
      };
    },

    async status() {
      const connections = realmStore.connections();
      const agents = kernel.registry.listAll().filter(entry => entry.status === 'active');
      return {
        ts: new Date().toISOString(),
        // Projected on purpose: RealmConnection carries the absolute root, which
        // must never be serialized to a client.
        realms: connections.map(({ realmId, type, readOnly }) => ({ realmId, type, readOnly })),
        agents: {
          activeCount: agents.length,
          names: agents.map(entry => entry.card.name),
        },
        pendingOversight: kernel.oversight.list('pending').length,
        watches: kernel.watches?.list().length ?? 0,
      };
    },
  };
}

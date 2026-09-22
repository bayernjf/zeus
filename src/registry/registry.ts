import type { AgentCard, Fealty } from '../a2a/types.js';
import { SUPPORTED_FEALTY_VERSIONS } from '../a2a/types.js';

/** Dispatcher-facing view of a registered vassal. */
export type VassalLike = {
  name: string;
  taskUrl: string;
  card: AgentCard;
  fealty: Fealty;
};

export type VassalStatus = 'unknown' | 'active' | 'revoked';

/** Live directory the dispatcher routes through. Revoked vassals are invisible
 *  to get/findBySkill but distinguishable via statusOf for governance audit. */
export type VassalLookup = {
  get(name: string): VassalLike | undefined;
  statusOf(name: string): VassalStatus;
  findBySkill(skillId: string): VassalLike[];
};

export type RegistryHooks = {
  /** Fired exactly once when a vassal transitions active -> revoked.
   *  Bridge this into the dispatch audit sink. */
  onRevoke?: (name: string, at: string) => void;
  /** Fired after a vassal's card is fetched and accepted (register). Used by
   *  boot to import the card's skills into the SkillRegistry. */
  onRegister?: (entry: VassalEntry) => void;
};

export type VassalEntry = {
  cardUrl: string;
  taskUrl: string;
  card: AgentCard;
  fealty: Fealty;
  registeredAt: string;
  lastHealthCheck?: { at: string; ok: boolean; detail?: string };
  revoked: boolean;
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class VassalRegistry {
  private entries = new Map<string, VassalEntry>();

  constructor(
    private fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private now: () => Date = () => new Date(),
    private hooks: RegistryHooks = {}
  ) {}

  /** Fetch the agent card at a well-known/card URL and register the vassal.
   *  Requires a valid x-zeus-fealty; a card without fealty is a guest, not a vassal. */
  async register(cardUrl: string, options: { taskUrl?: string; validate?: (card: AgentCard) => void } = {}): Promise<VassalEntry> {
    const response = await this.fetchImpl(cardUrl);
    if (!response.ok) throw new Error(`card fetch failed: ${response.status} ${cardUrl}`);
    const card = (await response.json()) as AgentCard;
    if (!card.name || !Array.isArray(card.skills)) throw new Error(`invalid agent card: ${cardUrl}`);
    const fealty = card['x-zeus-fealty'];
    if (!fealty || fealty.swornTo !== 'zeus' || !fealty.version) {
      throw new Error(`no vassal fealty on card (guest agent?): ${cardUrl}`);
    }
    // Version negotiation (§4.5): refuse an unsupported fealty version rather
    // than silently interpreting a newer/older contract.
    if (!(SUPPORTED_FEALTY_VERSIONS as readonly string[]).includes(fealty.version)) {
      throw new Error(
        `unsupported fealty.version '${fealty.version}'; supported: ${SUPPORTED_FEALTY_VERSIONS.join(', ')} — upgrade Zeus: ${cardUrl}`
      );
    }
    options.validate?.(card);
    const taskUrl = options.taskUrl ?? defaultTaskUrl(cardUrl);
    const entry: VassalEntry = {
      cardUrl,
      taskUrl,
      card,
      fealty,
      registeredAt: this.now().toISOString(),
      revoked: false,
    };
    this.entries.set(card.name, entry);
    this.hooks.onRegister?.(entry);
    return structuredClone(entry);
  }

  get(name: string): VassalEntry | undefined {
    const entry = this.entries.get(name);
    return entry && !entry.revoked ? structuredClone(entry) : undefined;
  }

  list(): VassalEntry[] {
    return [...this.entries.values()].filter(entry => !entry.revoked).map(entry => structuredClone(entry));
  }

  /** Oversight-deck view: every vassal including revoked ones, with an explicit
   *  status flag. Routing uses list(); the deck needs to see retired vassals too. */
  listAll(): Array<VassalEntry & { status: 'active' | 'revoked' }> {
    return [...this.entries.values()].map(entry => ({
      ...structuredClone(entry),
      status: entry.revoked ? 'revoked' : 'active',
    }));
  }

  revoke(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry || entry.revoked) return false;
    entry.revoked = true;
    this.hooks.onRevoke?.(name, this.now().toISOString());
    return true;
  }

  /** Live dispatcher view. The same object is returned every call, so a revoke
   *  takes effect for in-flight dispatchers immediately without rewiring. */
  asVassalLookup(): VassalLookup {
    const toLike = (entry: VassalEntry): VassalLike => ({
      name: entry.card.name,
      taskUrl: entry.taskUrl,
      card: entry.card,
      fealty: entry.fealty,
    });
    return {
      get: name => {
        const entry = this.entries.get(name);
        return entry && !entry.revoked ? toLike(structuredClone(entry)) : undefined;
      },
      statusOf: name => {
        const entry = this.entries.get(name);
        return entry ? (entry.revoked ? 'revoked' : 'active') : 'unknown';
      },
      findBySkill: skillId => this.findVassalsForSkill(skillId).map(toLike),
    };
  }

  findVassalsForSkill(skillId: string): VassalEntry[] {
    return this.list().filter(entry => entry.card.skills.some(skill => skill.id === skillId));
  }

  findVassalsForDomain(domain: string): VassalEntry[] {
    return this.list().filter(entry => entry.fealty.domain === domain);
  }

  async healthCheck(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry || entry.revoked) return false;
    try {
      const response = await this.fetchImpl(entry.cardUrl);
      entry.lastHealthCheck = { at: this.now().toISOString(), ok: response.ok, detail: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      entry.lastHealthCheck = { at: this.now().toISOString(), ok: false, detail: error instanceof Error ? error.message : 'fetch failed' };
    }
    return entry.lastHealthCheck.ok;
  }

  /** E5.3: serializable snapshot (including revoked vassals, for audit). */
  exportState(): VassalEntry[] {
    return [...this.entries.values()].map(entry => structuredClone(entry));
  }

  /** E5.3: replace registry contents from a snapshot (keyed by card.name). */
  importState(entries: VassalEntry[]): void {
    this.entries = new Map(entries.map(entry => [entry.card.name, structuredClone(entry)]));
  }
}

/** Derive the JSON-RPC task endpoint from the card URL:
 *  .../api/a2a/agent-card → .../api/a2a/tasks */
export function defaultTaskUrl(cardUrl: string): string {
  return cardUrl.replace(/\/api\/a2a\/agent-card\/?$/, '/api/a2a/tasks').replace(/\/\.well-known\/agent(-card)?\.json\/?$/, '/api/a2a/tasks');
}

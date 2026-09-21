import type { AgentCard, Fealty } from '../a2a/types.js';

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

  constructor(private fetchImpl: FetchLike = (url, init) => fetch(url, init), private now: () => Date = () => new Date()) {}

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
    return true;
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
}

/** Derive the JSON-RPC task endpoint from the card URL:
 *  .../api/a2a/agent-card → .../api/a2a/tasks */
export function defaultTaskUrl(cardUrl: string): string {
  return cardUrl.replace(/\/api\/a2a\/agent-card\/?$/, '/api/a2a/tasks').replace(/\/\.well-known\/agent(-card)?\.json\/?$/, '/api/a2a/tasks');
}

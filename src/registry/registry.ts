import type { AgentCard, Fealty } from '../a2a/types.js';
import { SUPPORTED_FEALTY_VERSIONS } from '../a2a/types.js';
import { assertOutboundUrlAllowed } from '../util/outbound-url.js';

/** Dispatcher-facing view of a registered vassal. */
export type VassalLike = {
  name: string;
  taskUrl: string;
  card: AgentCard;
  fealty: Fealty;
  /** Present when the wiring carries revocation (a static Map for tests and
   *  single-process wiring); the registry's own lookups drop revoked entries
   *  instead of flagging them. */
  revoked?: boolean;
};

/**
 * C-audit: what every public accessor actually returns. The outbound bearer is
 * deliberately dropped by `withoutToken`, so a return type that still carried
 * `token?` was lying — and a caller could read a field that is never there. The
 * type now matches the value, so a new field added to `VassalEntry` fails to
 * compile here instead of silently widening the public shape.
 */
export type PublicVassalEntry = Omit<VassalEntry, 'token'>;

export type VassalStatus = 'unknown' | 'active' | 'revoked';

/** The card could not be read at all — the peer is unreachable or answered with
 *  an error status. Distinct from a card that was fetched and then refused: that
 *  is a content problem, this one is a transport problem, and the HTTP face maps
 *  them to different codes. */
export class CardFetchError extends Error {}

/** A-02: a revocation is sticky, so re-registering a revoked name is refused
 *  rather than silently clearing the revocation and swapping the outbound URL
 *  and credential. Restoring a vassal is a separate, explicit act (reinstate). */
export class VassalRevokedError extends Error {}

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
  /** Fired exactly once when a vassal transitions revoked -> active. A-02: a
   *  revocation is only undone by this audited, explicit act. */
  onReinstate?: (name: string, at: string) => void;
  /** Fired after a vassal's card is fetched and accepted (register). Used by
   *  boot to import the card's skills into the SkillRegistry. Carries the same
   *  token-stripped shape the public accessors return. */
  onRegister?: (entry: PublicVassalEntry) => void;
};

export type VassalEntry = {
  cardUrl: string;
  taskUrl: string;
  card: AgentCard;
  fealty: Fealty;
  registeredAt: string;
  lastHealthCheck?: { at: string; ok: boolean; detail?: string };
  revoked: boolean;
  /**
   * E4.8: outbound bearer token for this vassal, issued at registration/seed.
   * Persisted with the snapshot (exportState) so restarts keep dispatching, but
   * never surfaced by the public accessors (get/list/listAll), the roster
   * projection or any HTTP response — the only readers are Dispatcher.tokenFor
   * (via boot) and the state file on disk.
   */
  token?: string;
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
   *  Requires a valid x-zeus-fealty; a card without fealty is a guest, not a vassal.
   *  `token` is the optional outbound bearer this vassal presents on dispatch
   *  (E4.8); it is stored for the dispatcher and the snapshot only. */
  async register(cardUrl: string, options: { taskUrl?: string; token?: string; validate?: (card: AgentCard) => void } = {}): Promise<PublicVassalEntry> {
    // A-12: the caller names where we fetch from, so the URL is untrusted input.
    // Refuse a non-public target before the request leaves the process, not after
    // its body has been read into the roster.
    assertOutboundUrlAllowed(cardUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(cardUrl);
    } catch (e) {
      // A connection-level failure never reaches the status check below, and the
      // underlying message (undici says just "fetch failed") names no URL — the
      // operator has to be told which host we could not reach.
      const reason = e instanceof Error ? e.message : String(e);
      throw new CardFetchError(`card fetch failed: ${reason} (${cardUrl})`);
    }
    if (!response.ok) throw new CardFetchError(`card fetch failed: ${response.status} ${cardUrl}`);
    let card: AgentCard;
    try {
      card = (await response.json()) as AgentCard;
    } catch (e) {
      // A 200 whose body is not JSON is the peer failing to serve a card: the
      // same transport class as an error status, so it maps to 502. Left
      // outside this catch, the SyntaxError escaped as a 400 "invalid_request"
      // and blamed the caller for the peer's response.
      const reason = e instanceof Error ? e.message : String(e);
      throw new CardFetchError(`card fetch returned a body that is not JSON: ${reason} (${cardUrl})`);
    }
    // A JSON body that is not a card (including the literal `null`/scalar a peer
    // could return) is a content problem, refused with the field it lacks.
    if (!card || typeof card !== 'object' || !card.name || !Array.isArray(card.skills)) {
      throw new Error(`invalid agent card: ${cardUrl}`);
    }
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
    // The oath fields below are what dispatch reads on every request. A card
    // that omits one used to register cleanly and then die later with a
    // TypeError from the dispatcher - refusing at the boundary says which field
    // the vassal must fix, and when it went wrong.
    const oathProblem = fealtyOathProblem(fealty);
    if (oathProblem) throw new Error(`invalid vassal fealty: ${oathProblem}: ${cardUrl}`);
    options.validate?.(card);
    // Where dispatch posts is resolved in a fixed order: an explicit override
    // wins outright, then the endpoint the card declares (A2A AgentCard.url is
    // the agent's own statement of where its service lives), and only then the
    // URL convention. pr-helper exposed why the declaration has to come first:
    // its JSON-RPC face sits on the card path itself, so the convention derived
    // a URL that 404s. The convention stays last so a card that declares nothing
    // usable keeps registering the way it always did, rather than newly failing
    // at the boundary.
    const taskUrl = options.taskUrl ?? declaredTaskUrl(card) ?? defaultTaskUrl(cardUrl);
    // A-12: dispatch posts to taskUrl on every branch. A card (or a taskUrl
    // override) can point it at a private host just as the cardUrl can, so it is
    // held to the same guard before it is stored and later trusted.
    assertOutboundUrlAllowed(taskUrl);
    const entry: VassalEntry = {
      cardUrl,
      taskUrl,
      card,
      fealty,
      registeredAt: this.now().toISOString(),
      revoked: false,
      ...(options.token !== undefined ? { token: options.token } : {}),
    };
    // A-02: revocation is sticky. Re-registering used to rebuild the entry with
    // revoked:false, so one POST undid a governance act and could also swap the
    // outbound taskUrl and token. A revoked name must be restored explicitly.
    const existing = this.entries.get(card.name);
    if (existing?.revoked) {
      throw new VassalRevokedError(
        `vassal '${card.name}' is revoked; re-registering does not clear a revocation — reinstate it explicitly first: ${cardUrl}`
      );
    }
    this.entries.set(card.name, entry);
    // E4.8: the stored bearer belongs to the dispatcher and the state file, so
    // neither the caller's return value nor a hook payload carries it. Stripping
    // it here rather than at each call site means a new caller cannot leak the
    // credential by echoing back what register handed it.
    const publicEntry = withoutToken(structuredClone(entry));
    this.hooks.onRegister?.(publicEntry);
    return publicEntry;
  }

  get(name: string): PublicVassalEntry | undefined {
    const entry = this.entries.get(name);
    return entry && !entry.revoked ? withoutToken(structuredClone(entry)) : undefined;
  }

  list(): PublicVassalEntry[] {
    return [...this.entries.values()]
      .filter(entry => !entry.revoked)
      .map(entry => withoutToken(structuredClone(entry)));
  }

  /** Oversight-deck view: every vassal including revoked ones, with an explicit
   *  status flag. Routing uses list(); the deck needs to see retired vassals too. */
  listAll(): Array<PublicVassalEntry & { status: 'active' | 'revoked' }> {
    return [...this.entries.values()].map(entry => ({
      ...withoutToken(structuredClone(entry)),
      status: entry.revoked ? 'revoked' : 'active',
    }));
  }

  /**
   * E4.8: the dispatcher's outbound token source. Revoked vassals yield nothing
   * even if a concurrent dispatch already passed the governance gate, so a
   * revocation always takes effect before any bearer is attached.
   */
  tokenFor(name: string): string | undefined {
    const entry = this.entries.get(name);
    return entry && !entry.revoked ? entry.token : undefined;
  }

  revoke(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry || entry.revoked) return false;
    entry.revoked = true;
    this.hooks.onRevoke?.(name, this.now().toISOString());
    return true;
  }

  /**
   * A-02: the only way back from a revocation. Explicit and audited, so the
   * governance record shows a restore rather than having a re-registration
   * quietly erase it. The stored card/credential are kept as they were: a
   * restore changes the access decision, not the vassal's identity.
   */
  reinstate(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry || !entry.revoked) return false;
    entry.revoked = false;
    this.hooks.onReinstate?.(name, this.now().toISOString());
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

  findVassalsForSkill(skillId: string): PublicVassalEntry[] {
    return this.list().filter(entry => entry.card.skills.some(skill => skill.id === skillId));
  }

  findVassalsForDomain(domain: string): PublicVassalEntry[] {
    return this.list().filter(entry => entry.fealty.domain === domain);
  }

  async healthCheck(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry || entry.revoked) return false;
    try {
      const response = await this.fetchImpl(entry.cardUrl);
      entry.lastHealthCheck = { at: this.now().toISOString(), ok: response.ok, detail: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      // C-audit: this text is written by the peer's transport (or the OS), and it
      // then lands in the state file and inside the signed roster snapshot. Bound
      // and flatten it first, so an unbounded, multi-line or control-character
      // reason cannot bloat or corrupt either artifact.
      const reason = error instanceof Error ? error.message : 'fetch failed';
      entry.lastHealthCheck = { at: this.now().toISOString(), ok: false, detail: sanitizeProbeDetail(reason) };
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

/** The A2A endpoint the card declares it is reachable at, when it declares one.
 *  A blank or non-http(s) value counts as "not declared" and falls through to the
 *  convention: a card that used to register and work through the convention must
 *  not start failing at the boundary because its `url` is junk. */
function declaredTaskUrl(card: AgentCard): string | undefined {
  const declared = typeof card.url === 'string' ? card.url.trim() : '';
  if (!declared) return undefined;
  try {
    const { protocol } = new URL(declared);
    return protocol === 'http:' || protocol === 'https:' ? declared : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback when a card declares no usable endpoint: derive the JSON-RPC task
 *  endpoint from the card URL by convention:
 *  .../api/a2a/agent-card → .../api/a2a/tasks */
export function defaultTaskUrl(cardUrl: string): string {
  return cardUrl.replace(/\/api\/a2a\/agent-card\/?$/, '/api/a2a/tasks').replace(/\/\.well-known\/agent(-card)?\.json\/?$/, '/api/a2a/tasks');
}

const REALM_TYPES = ['personal', 'enterprise'] as const;
const DATA_POLICIES = ['none', 'read-task-scope', 'read-realm', 'write'] as const;
const ESCALATION_POLICIES = ['none', 'on-failure', 'auto'] as const;

/**
 * The first defect in the part of the oath that dispatch reads on every request.
 * An empty dataRealms array is not a defect: it means "no data at all", and the
 * diode then refuses each task with an explicit audit reason.
 */
function fealtyOathProblem(fealty: Fealty): string | null {
  const oath = fealty as unknown as Record<string, unknown>;
  // domain is the grouping key routing and the roster project on, so an empty or
  // missing one silently puts every such vassal in the same nameless bucket.
  if (typeof oath.domain !== 'string' || oath.domain.trim() === '') {
    return `domain must be a non-empty string, got ${describeOathValue(oath.domain)}`;
  }
  if (!Array.isArray(oath.dataRealms)) {
    return `dataRealms must be an array of realm types, got ${describeOathValue(oath.dataRealms)}`;
  }
  const unknownRealms = (oath.dataRealms as unknown[]).filter(realm => !(REALM_TYPES as readonly string[]).includes(realm as string));
  if (unknownRealms.length > 0) {
    return `dataRealms holds unknown realm types: ${unknownRealms.map(value => describeOathValue(value)).join(', ')}`;
  }
  if (!(DATA_POLICIES as readonly string[]).includes(oath.dataPolicy as string)) {
    return `dataPolicy must be one of ${DATA_POLICIES.join(', ')}, got ${describeOathValue(oath.dataPolicy)}`;
  }
  if (!(ESCALATION_POLICIES as readonly string[]).includes(oath.escalationPolicy as string)) {
    return `escalationPolicy must be one of ${ESCALATION_POLICIES.join(', ')}, got ${describeOathValue(oath.escalationPolicy)}`;
  }
  if (typeof oath.reportBack !== 'boolean') {
    return `reportBack must be a boolean, got ${describeOathValue(oath.reportBack)}`;
  }
  const sla = oath.sla as { ackSeconds?: unknown } | undefined;
  if (
    sla !== undefined
    && sla.ackSeconds !== undefined
    && (typeof sla.ackSeconds !== 'number' || !Number.isFinite(sla.ackSeconds) || sla.ackSeconds <= 0)
  ) {
    return `sla.ackSeconds must be a positive number of seconds, got ${describeOathValue(sla.ackSeconds)}`;
  }
  return null;
}

/** Upper bound on a recorded probe failure detail, in characters. */
const PROBE_DETAIL_LIMIT = 200;

/** Flatten and bound a probe failure reason before it is persisted and signed.
 *  The text originates outside this process, so its length, line count and
 *  character set are all peer-controlled. */
function sanitizeProbeDetail(raw: string): string {
  const flattened = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flattened.length > PROBE_DETAIL_LIMIT ? `${flattened.slice(0, PROBE_DETAIL_LIMIT - 1)}…` : flattened;
}

function describeOathValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return value === undefined ? 'nothing' : String(value);
}

/** Strip the outbound token from a clone so no public accessor (and therefore
 *  no roster projection or HTTP response) can echo it. `exportState` keeps the
 *  token on purpose: the state file on disk is the dispatcher's token store. */
function withoutToken<T extends { token?: string }>(entry: T): Omit<T, 'token'> {
  const { token, ...rest } = entry;
  return rest;
}

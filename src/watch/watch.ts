import type { RealmType } from '../a2a/types.js';
import type { MetricsSnapshot } from '../orchestrator/metrics.js';
import type { RealmStore } from '../realm/types.js';

/**
 * design-self-host-loop §3: the trigger primitive that lets an intent exist
 * without a human being present at the moment it is raised.
 *
 * Two things are deliberately refused here, and both are what make the
 * primitive safe to run unattended:
 *  - no expression language. `op` is a closed enum and `field` is a per-source
 *    whitelist, so the boundary stays in the type instead of in an evaluator
 *    that would have to remember every prohibition.
 *  - no outbound surface. A tick reads what the kernel already holds (metrics)
 *    or what the user already authorized (a mounted realm); `connector` is
 *    step 3 and is absent here, so an unreadable source is reported as unknown
 *    rather than guessed at.
 */

export const WATCH_SOURCES = ['metrics', 'realm', 'connector'] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];

export const WATCH_OPS = ['above', 'below', 'present', 'absent', 'changed'] as const;
export type WatchOp = (typeof WATCH_OPS)[number];

/**
 * The readable fields per source. A field outside this list is a registration
 * error, not a silent empty reading - otherwise a typo becomes a watch that
 * never fires and looks healthy.
 */
export const WATCH_FIELDS: Record<WatchSource, readonly string[]> = {
  metrics: ['inFlight', 'queueDepth', 'failureRate', 'finished'],
  realm: ['entryCount', 'lastItemModifiedAt'],
  // A connector's payload is not knowable at compile time, so there is no field
  // list to close over; the boundary is the connector's own declaration plus the
  // outbound guards, and the path is checked against `WATCH_PATH_GRAMMAR`.
  connector: [],
};

/**
 * The only shape a connector field may take: a bounded dot-path of plain
 * identifiers. No brackets, no indices, no wildcards, no quoting — this is not
 * an expression language and must never grow into one. An unbounded path would
 * move the boundary into the walker, which has no gate of its own.
 */
export const WATCH_PATH_GRAMMAR = /^[A-Za-z0-9_-]{1,40}(?:\.[A-Za-z0-9_-]{1,40}){0,3}$/;

export type WatchPredicate = {
  source: WatchSource;
  op: WatchOp;
  field: string;
  value?: string | number;
};

export type Watch = {
  id: string;
  /** Who registered it; an auto-raised intent is attributed to this actor. */
  owner: string;
  /** §5: a watch belongs to a single domain, fixed at registration. */
  realm: RealmType;
  realmId?: string;
  /** Which declared connector tool to read. Args are fixed at registration:
   *  nothing here is computed per tick. */
  connector?: { id: string; tool: string; args?: Record<string, unknown> };
  predicate: WatchPredicate;
  intent: { skill: string; subject: string; mode: 'plan' | 'execute'; maxFanOut: number };
  intervalSeconds: number;
  startsAt: string;
  expiresAt: string;
  /** Ceilings, set once by the human who registered the watch. */
  budget: { fires: number; executes: number };
  /** Kernel's ledger of what those ceilings have been spent on. Persisted: a
   *  restart must not hand out a fresh budget. */
  used: { fires: number; executes: number };
  enabled: boolean;
  lastEvaluatedAt?: string;
  lastFiredAt?: string;
  /** `changed` compares against this; without it the first tick would always
   *  look like a change. */
  lastValue?: string | number;
  /** Consecutive evaluation failures, for the auto-disable threshold. */
  evalFailures?: number;
  /** Required when `intent.mode === 'execute'` (invariant 4). */
  delegationId?: string;
};

export class WatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchError';
  }
}

/** A source reading, or `unavailable` when the tick could not obtain one. */
export type WatchReading = { kind: 'value'; value: string | number } | { kind: 'unavailable' };

export type WatchSources = {
  metrics?: () => MetricsSnapshot | undefined;
  realm?: (realmId: string) => Promise<{ entryCount: number; lastItemModifiedAt?: string }>;
  connector?: (ref: { id: string; tool: string; args?: Record<string, unknown> }) => Promise<unknown>;
};

/** Read a mounted realm through its existing read-only enumeration (no new surface). */
export async function realmReading(store: RealmStore, realmId: string): Promise<{ entryCount: number; lastItemModifiedAt?: string }> {
  const entries = await store.entries(realmId);
  let lastItemModifiedAt: string | undefined;
  for (const entry of entries) {
    if (lastItemModifiedAt === undefined || entry.modifiedAt > lastItemModifiedAt) {
      lastItemModifiedAt = entry.modifiedAt;
    }
  }
  return { entryCount: entries.length, ...(lastItemModifiedAt ? { lastItemModifiedAt } : {}) };
}

/**
 * Read a declared connector tool. The boundary is the connector's own: the tool
 * must have been granted by the declaration and advertised at handshake, and the
 * call goes out through the existing outbound guards. Nothing here widens that.
 */
export async function connectorReading(
  registry: {
    callTool: (id: string, name: string, args?: Record<string, unknown>, fetchImpl?: typeof fetch) => Promise<unknown>;
  },
  ref: { id: string; tool: string; args?: Record<string, unknown> },
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  // The same injected transport the rest of the kernel was assembled with, so a
  // watch never opens a second, differently-guarded outbound path.
  return registry.callTool(ref.id, ref.tool, ref.args ?? {}, fetchImpl);
}

/** Walk a bounded dot-path to a scalar. Anything else is "not readable". */
export function readPath(payload: unknown, path: string): string | number | undefined {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'number' || typeof current === 'string') return current;
  return undefined;
}

/** Pure predicate evaluation. Returns null when the reading is unavailable. */
export function evaluatePredicate(predicate: WatchPredicate, reading: WatchReading, lastValue?: string | number): boolean | null {
  if (reading.kind === 'unavailable') return null;
  const value = reading.value;
  switch (predicate.op) {
    case 'above':
    case 'below': {
      if (typeof value !== 'number') return false;
      const threshold = typeof predicate.value === 'number' ? predicate.value : Number(predicate.value);
      if (!Number.isFinite(threshold)) return false;
      return predicate.op === 'above' ? value > threshold : value < threshold;
    }
    case 'present':
      return value !== '' && value !== 0;
    case 'absent':
      return value === '' || value === 0;
    case 'changed':
      return lastValue === undefined ? false : String(lastValue) !== String(value);
  }
}

export type WatchAuditEntry = {
  decision:
    | 'watch-registered'
    | 'watch-fired'
    | 'watch-disabled'
    | 'watch-revoked'
    | 'watch-eval-unavailable'
    | 'watch-auto-disabled'
    | 'delegation-child-issued'
    | 'delegation-limit-exceeded';
  watchId: string;
  owner: string;
  detail: string;
  at: string;
};

export type WatchSubmitRequest = {
  intentId: string;
  skill: string;
  subject: string;
  mode: 'plan' | 'execute';
  realm: RealmType;
  maxFanOut: number;
  /** Execute fires only: the one-time child ticket derived from the watch's
   *  delegation contract. The orchestrator gate verifies and consumes it. */
  executionDelegation?: unknown;
};

export type WatchSubmitResult = { ok: boolean; replayed?: boolean; reason?: string };

export type WatchTickOptions = {
  now: () => Date;
  sources?: WatchSources;
  /** Absent (or throwing) = the intent cannot be raised, which is not the same
   *  as the condition being false. */
  submit?: (request: WatchSubmitRequest) => Promise<WatchSubmitResult>;
  audit?: (entry: WatchAuditEntry) => void;
  /** Consecutive unreadable evaluations before the watch is disabled (§3.3). */
  maxEvalFailures?: number;
  /**
   * Self-host loop step 4: mint the one-time child ticket an execute fire
   * presents to the orchestrator gate. Absent = no trust anchor, so execute
   * fires fail closed. A refusal (no contract / revoked / a ceiling hit) is a
   * structured reason, never an exception the tick would swallow silently.
   */
  deriveExecution?: (input: {
    watchId: string;
    delegationId: string;
    skill: string;
  }) => Promise<{ ok: true; delegation: unknown } | { ok: false; reason: string }>;
  /** Step 4 §4.2: a refused execute fire becomes a desk escalation instead of
   *  a silent miss, so the operator can issue a new contract or drop to plan. */
  escalateLimit?: (input: {
    watchId: string;
    delegationId?: string;
    skill: string;
    realm: RealmType;
    realmId?: string;
    reason: string;
    tickSeq: number;
  }) => void;
};

export type WatchTickReport = {
  evaluated: number;
  fired: string[];
  unavailable: string[];
  autoDisabled: string[];
};

const DEFAULT_MAX_EVAL_FAILURES = 3;

export class WatchRegistry {
  private watches = new Map<string, Watch>();

  constructor(
    private options: { newId?: () => string } = {}
  ) {}

  private newId(): string {
    return this.options.newId?.() ?? `watch-${crypto.randomUUID()}`;
  }

  /** `enabled` is not an input: a watch starts enabled, and the only ways off
   *  are disable/revoke, which are separate recorded acts. */
  register(input: Omit<Watch, 'id' | 'used' | 'enabled' | 'lastEvaluatedAt' | 'lastFiredAt' | 'lastValue' | 'evalFailures'> & { id?: string }): Watch {
    const source = input.predicate?.source;
    if (!source || !WATCH_SOURCES.includes(source)) {
      throw new WatchError(`predicate.source must be one of ${WATCH_SOURCES.join(', ')}`);
    }
    if (!WATCH_OPS.includes(input.predicate.op)) {
      throw new WatchError(`predicate.op must be one of ${WATCH_OPS.join(', ')}`);
    }
    if (source === 'connector') {
      if (!WATCH_PATH_GRAMMAR.test(input.predicate.field)) {
        throw new WatchError(
          `predicate.field '${input.predicate.field}' is not a bounded dot-path (plain identifiers, at most 4 segments; no indices, wildcards or expressions)`
        );
      }
      if (!input.connector?.id || !input.connector?.tool) {
        throw new WatchError("a connector watch must name the connector id and the tool it reads");
      }
    } else if (!WATCH_FIELDS[source].includes(input.predicate.field)) {
      throw new WatchError(`predicate.field '${input.predicate.field}' is not readable from source '${source}' (allowed: ${WATCH_FIELDS[source].join(', ') || 'none'})`);
    }
    if ((input.predicate.op === 'above' || input.predicate.op === 'below') && typeof input.predicate.value !== 'number') {
      throw new WatchError(`predicate.op '${input.predicate.op}' requires a numeric predicate.value`);
    }
    if (input.intent.mode === 'execute' && !input.delegationId) {
      throw new WatchError('an execute watch must name the delegationId it derives its ticket from (invariant 4)');
    }
    if (input.intent.mode === 'execute' && !input.intent.skill) {
      throw new WatchError('intent.skill is required');
    }
    if (!(input.intervalSeconds > 0)) throw new WatchError('intervalSeconds must be positive');
    if (Date.parse(input.expiresAt) <= Date.parse(input.startsAt)) {
      throw new WatchError('expiresAt must be after startsAt');
    }
    if (!(input.budget.fires > 0)) throw new WatchError('budget.fires must be positive');
    if (input.intent.mode === 'execute' && !(input.budget.executes > 0)) {
      throw new WatchError('budget.executes must be positive for an execute watch');
    }

    const watch: Watch = {
      ...input,
      id: input.id ?? this.newId(),
      used: { fires: 0, executes: 0 },
      enabled: true,
    };
    this.watches.set(watch.id, watch);
    return structuredClone(watch);
  }

  get(id: string): Watch | undefined {
    const found = this.watches.get(id);
    return found ? structuredClone(found) : undefined;
  }

  list(): Watch[] {
    return [...this.watches.values()].map(watch => structuredClone(watch));
  }

  /** Reversible: stops evaluating but keeps the record and its history. */
  disable(id: string): Watch | undefined {
    const watch = this.watches.get(id);
    if (!watch) return undefined;
    watch.enabled = false;
    return structuredClone(watch);
  }

  /** Terminal: never evaluates again, and is not re-enabled. */
  revoke(id: string): Watch | undefined {
    const watch = this.watches.get(id);
    if (!watch) return undefined;
    watch.enabled = false;
    watch.expiresAt = watch.startsAt;
    return structuredClone(watch);
  }

  exportState(): Watch[] {
    return this.list();
  }

  importState(watches: Watch[]): void {
    this.watches.clear();
    for (const watch of watches) this.watches.set(watch.id, structuredClone(watch));
  }

  /**
   * One evaluation pass. Every watch is evaluated in order and a throwing
   * watch is recorded and skipped - one bad watch must not stop the tick.
   */
  async runTick(options: WatchTickOptions): Promise<WatchTickReport> {
    const report: WatchTickReport = { evaluated: 0, fired: [], unavailable: [], autoDisabled: [] };
    const maxFailures = options.maxEvalFailures ?? DEFAULT_MAX_EVAL_FAILURES;
    const nowMs = options.now().getTime();
    const nowIso = options.now().toISOString();

    for (const watch of this.watches.values()) {
      if (!watch.enabled) continue;
      if (nowMs < Date.parse(watch.startsAt) || nowMs > Date.parse(watch.expiresAt)) continue;
      if (watch.used.fires >= watch.budget.fires) continue;
      if (watch.intervalSeconds > 0 && watch.lastEvaluatedAt) {
        const elapsed = (nowMs - Date.parse(watch.lastEvaluatedAt)) / 1000;
        if (elapsed < watch.intervalSeconds) continue;
      }
      report.evaluated += 1;
      watch.lastEvaluatedAt = nowIso;

      let reading: WatchReading;
      try {
        reading = await this.readSource(watch, options.sources ?? {});
      } catch {
        reading = { kind: 'unavailable' };
      }

      if (reading.kind === 'unavailable') {
        watch.evalFailures = (watch.evalFailures ?? 0) + 1;
        report.unavailable.push(watch.id);
        options.audit?.({
          decision: 'watch-eval-unavailable',
          watchId: watch.id,
          owner: watch.owner,
          detail: `source '${watch.predicate.source}' could not be read; not firing (failure ${watch.evalFailures})`,
          at: nowIso,
        });
        if (watch.evalFailures >= maxFailures) {
          watch.enabled = false;
          report.autoDisabled.push(watch.id);
          options.audit?.({
            decision: 'watch-auto-disabled',
            watchId: watch.id,
            owner: watch.owner,
            detail: `disabled after ${watch.evalFailures} consecutive unreadable evaluations`,
            at: nowIso,
          });
        }
        continue;
      }

      watch.evalFailures = 0;
      const matched = evaluatePredicate(watch.predicate, reading, watch.lastValue);
      watch.lastValue = reading.value;
      if (matched !== true) continue;

      if (!options.submit) continue;

      const seq = watch.used.fires + 1;
      // The deterministic intent id is what makes a repeated condition a replay
      // instead of a second dispatch: it hits the orchestrator's idempotency
      // table rather than relying on the tick not to run twice.
      const intentId = `watch:${watch.id}:${seq}`;

      // Step 4: an unattended execute fire may only run inside a pre-signed,
      // bounded contract. The watch never carries its own ticket (invariant 4);
      // it asks the kernel to derive one for this fire. No derive hook, no
      // contract, revoked/window-ended, or a spent ceiling all read the same
      // way: zero outbound and a desk escalation naming the exact limit hit.
      let childTicket: unknown;
      if (watch.intent.mode === 'execute') {
        const delegationId = watch.delegationId;
        // The execute budget is the watch-local ceiling; the contract adds its
        // own maxChildTickets/maxConcurrent. A spent watch budget refuses
        // before asking for a ticket, so it never spends a contract slot.
        let reason: string | null = null;
        if (watch.used.executes >= watch.budget.executes) reason = 'execute-budget-exhausted';
        else if (!delegationId) reason = 'no-contract';
        else if (!options.deriveExecution) reason = 'no-trust-anchor';
        if (reason) {
          options.audit?.({
            decision: 'delegation-limit-exceeded',
            watchId: watch.id,
            owner: watch.owner,
            detail: `execute fire refused (${reason}); no outbound dispatch`,
            at: nowIso,
          });
          if (options.escalateLimit) {
            options.escalateLimit({
              watchId: watch.id,
              ...(delegationId ? { delegationId } : {}),
              skill: watch.intent.skill,
              realm: watch.realm,
              ...(watch.realmId ? { realmId: watch.realmId } : {}),
              reason,
              tickSeq: seq,
            });
          }
          continue;
        }
        const derive = options.deriveExecution;
        if (!derive) continue;
        const derived = await derive({
          watchId: watch.id,
          delegationId: delegationId as string,
          skill: watch.intent.skill,
        });
        if (!derived.ok) {
          options.audit?.({
            decision: 'delegation-limit-exceeded',
            watchId: watch.id,
            owner: watch.owner,
            detail: `execute fire refused (${derived.reason}); no outbound dispatch`,
            at: nowIso,
          });
          options.escalateLimit?.({
            watchId: watch.id,
            ...(delegationId ? { delegationId: delegationId as string } : {}),
            skill: watch.intent.skill,
            realm: watch.realm,
            ...(watch.realmId ? { realmId: watch.realmId } : {}),
            reason: derived.reason,
            tickSeq: seq,
          });
          continue;
        }
        childTicket = derived.delegation;
        options.audit?.({
          decision: 'delegation-child-issued',
          watchId: watch.id,
          owner: watch.owner,
          detail: `derived one-time child ticket from contract ${delegationId} for fire ${intentId}`,
          at: nowIso,
        });
      }

      let outcome: WatchSubmitResult;
      try {
        outcome = await options.submit({
          intentId,
          skill: watch.intent.skill,
          subject: watch.intent.subject,
          mode: watch.intent.mode,
          realm: watch.realm,
          maxFanOut: watch.intent.maxFanOut,
          ...(childTicket !== undefined ? { executionDelegation: childTicket } : {}),
        });
      } catch (error) {
        outcome = { ok: false, reason: error instanceof Error ? error.message : 'submit failed' };
      }
      if (!outcome.ok) continue;

      watch.used.fires += 1;
      if (watch.intent.mode === 'execute') watch.used.executes += 1;
      watch.lastFiredAt = nowIso;
      report.fired.push(watch.id);
      options.audit?.({
        decision: 'watch-fired',
        watchId: watch.id,
        owner: watch.owner,
        detail: outcome.replayed
          ? `fired as a replay of ${intentId}; no second dispatch`
          : `fired intent ${intentId} (skill ${watch.intent.skill}, mode ${watch.intent.mode})`,
        at: nowIso,
      });
    }

    return report;
  }

  private async readSource(watch: Watch, sources: WatchSources): Promise<WatchReading> {
    if (watch.predicate.source === 'metrics') {
      const snapshot = sources.metrics?.();
      if (!snapshot) return { kind: 'unavailable' };
      const value = (snapshot as unknown as Record<string, unknown>)[watch.predicate.field];
      if (typeof value !== 'number') return { kind: 'unavailable' };
      return { kind: 'value', value };
    }
    if (watch.predicate.source === 'realm') {
      if (!sources.realm || !watch.realmId) return { kind: 'unavailable' };
      const reading = await sources.realm(watch.realmId);
      const value = (reading as unknown as Record<string, unknown>)[watch.predicate.field];
      if (typeof value !== 'number' && typeof value !== 'string') return { kind: 'unavailable' };
      return { kind: 'value', value };
    }
    if (watch.predicate.source === 'connector') {
      // Unwired, unmounted or throwing all read the same way: unavailable. A
      // connector that jitters must not look like a satisfied condition.
      if (!sources.connector || !watch.connector) return { kind: 'unavailable' };
      const payload = await sources.connector(watch.connector);
      const value = readPath(payload, watch.predicate.field);
      if (value === undefined) return { kind: 'unavailable' };
      return { kind: 'value', value };
    }
    return { kind: 'unavailable' };
  }
}

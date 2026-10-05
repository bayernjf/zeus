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
  // Step 3. Declared now so the registry can refuse it loudly (unreadable
  // source) instead of treating an unwired source as "condition not met".
  connector: [],
};

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
    | 'watch-auto-disabled';
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
    if (!WATCH_FIELDS[source].includes(input.predicate.field)) {
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

      // execute needs a ticket derived from the contract; until step 4 wires
      // the derivation there is nothing to hand over, so it fails closed
      // rather than dispatching an unattended irreversible action.
      if (watch.intent.mode === 'execute') {
        options.audit?.({
          decision: 'watch-fired',
          watchId: watch.id,
          owner: watch.owner,
          detail: `execute fire refused: no child ticket available for contract ${watch.delegationId ?? '(none)'}`,
          at: nowIso,
        });
        continue;
      }
      if (!options.submit) continue;

      const seq = watch.used.fires + 1;
      // The deterministic intent id is what makes a repeated condition a replay
      // instead of a second dispatch: it hits the orchestrator's idempotency
      // table rather than relying on the tick not to run twice.
      const intentId = `watch:${watch.id}:${seq}`;
      let outcome: WatchSubmitResult;
      try {
        outcome = await options.submit({
          intentId,
          skill: watch.intent.skill,
          subject: watch.intent.subject,
          mode: watch.intent.mode,
          realm: watch.realm,
          maxFanOut: watch.intent.maxFanOut,
        });
      } catch (error) {
        outcome = { ok: false, reason: error instanceof Error ? error.message : 'submit failed' };
      }
      if (!outcome.ok) continue;

      watch.used.fires += 1;
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
    // connector: step 3. Unwired means unreadable, and unreadable must never be
    // mistaken for "the condition does not hold".
    return { kind: 'unavailable' };
  }
}

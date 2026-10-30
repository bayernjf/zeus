/**
 * Decision webhook dispatcher: push lifecycle events to registered HTTP
 * receivers instead of letting them poll listPending.
 *
 * Contract:
 *  - HMAC-SHA256 over the exact JSON body, `x-zeus-signature: sha256=<hex>`;
 *    receivers verify it before trusting the payload. **Legacy body-only
 *    signature — kept during the v2 rollout so an unupgraded receiver keeps
 *    working; remove once every receiver verifies v2.**
 *  - v2 freshness headers (replay defense), regenerated on every attempt:
 *      x-zeus-webhook-timestamp: unix seconds
 *      x-zeus-webhook-nonce:     random hex, unique per attempt
 *      x-zeus-webhook-signature: sha256=<HMAC over "<ts>\n<nonce>\n<body>">
 *    Receivers reject a stale timestamp (default 5 min skew) or a nonce that
 *    was already consumed.
 *  - `x-zeus-delivery-id: <decisionId>:<type>:<at>` is deterministic per
 *    transition so a receiver can dedupe retries (at-least-once delivery).
 *    The per-attempt nonce is deliberately different from this id.
 *  - Retryable failures (network error, 5xx, 429) get a small bounded
 *    exponential backoff; a 4xx other than 429 is a business rejection and
 *    is not retried.
 *  - Fail-soft by construction: emit() never throws into the decision path,
 *    and never writes back into the kernel. Real external channels stay
 *    external — this module only ships the local delivery mechanism.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { DecisionEvent, DecisionEventSink } from './events.js';

export interface DecisionWebhookSubscription {
  id: string;
  url: string;
  secret: string;
  active: boolean;
}

/** Read-only-plus-append registry of receivers. `remove` returns true when a
 *  row existed and was deleted; the route layer maps false to 404. */
export interface DecisionWebhookStore {
  list(): DecisionWebhookSubscription[] | Promise<DecisionWebhookSubscription[]>;
  add(subscription: DecisionWebhookSubscription): void | Promise<void>;
  remove(id: string): boolean | Promise<boolean>;
}

export class MemoryDecisionWebhookStore implements DecisionWebhookStore {
  private readonly subscriptions: DecisionWebhookSubscription[] = [];

  list(): DecisionWebhookSubscription[] {
    return this.subscriptions.map(s => ({ ...s }));
  }

  add(subscription: DecisionWebhookSubscription): void {
    this.subscriptions.push({ ...subscription });
  }

  remove(id: string): boolean {
    const at = this.subscriptions.findIndex(s => s.id === id);
    if (at === -1) return false;
    this.subscriptions.splice(at, 1);
    return true;
  }
}

export interface DecisionWebhookDispatcherDeps {
  store: DecisionWebhookStore;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Total delivery attempts per subscription before giving up (default 3). */
  maxAttempts?: number;
  /** Backoff between attempts, doubled each try (default 200ms). */
  baseBackoffMs?: number;
}

/** Compute the legacy body-only header signature a receiver must verify. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * v2 signature binding the freshness headers to the body. The signed string
 * is exactly `<unixSeconds>\n<nonce>\n<body>` with LF separators; both sides
 * must construct it identically.
 */
export function signWebhookPayload(secret: string, timestamp: string, nonce: string, body: string): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${body}`)
    .digest('hex')}`;
}

/** Deterministic per-transition idempotency key. */
export function webhookDeliveryId(event: DecisionEvent): string {
  return `${event.decisionId}:${event.type}:${event.at}`;
}

export class DecisionWebhookDispatcher implements DecisionEventSink {
  private readonly store: DecisionWebhookStore;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(deps: DecisionWebhookDispatcherDeps) {
    this.store = deps.store;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.sleepImpl = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.baseBackoffMs = deps.baseBackoffMs ?? 200;
  }

  async emit(event: DecisionEvent): Promise<void> {
    let subscriptions: DecisionWebhookSubscription[];
    try {
      subscriptions = await this.store.list();
    } catch {
      return; // fail-soft: a broken registry never breaks the decision path
    }
    await Promise.all(
      subscriptions.filter(s => s.active).map(s => this.deliver(s, event)),
    );
  }

  /** Deliver to one subscription; never throws. */
  private async deliver(subscription: DecisionWebhookSubscription, event: DecisionEvent): Promise<void> {
    const body = JSON.stringify(event);
    // Legacy body-only signature stays during the v2 rollout; the freshness
    // headers and v2 signature are regenerated per attempt (a retried request
    // is a fresh, independently signed delivery, never a captured replay).
    const legacySignature = signWebhookBody(subscription.secret, body);
    let attempt = 0;
    for (;;) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const headers = {
        'content-type': 'application/json',
        'x-zeus-delivery-id': webhookDeliveryId(event),
        'x-zeus-signature': legacySignature,
        'x-zeus-webhook-timestamp': timestamp,
        'x-zeus-webhook-nonce': nonce,
        'x-zeus-webhook-signature': signWebhookPayload(subscription.secret, timestamp, nonce, body),
      };
      let status: number | undefined;
      try {
        const response = await this.fetchImpl(subscription.url, { method: 'POST', headers, body });
        if (response.ok) return;
        status = response.status;
        // 4xx (except 429) is the receiver's business rejection: retrying
        // would just spam; give up silently.
        if (status >= 400 && status < 500 && status !== 429) return;
      } catch {
        // Network failure: retryable below.
      }
      attempt += 1;
      if (attempt >= this.maxAttempts) return;
      await this.sleepImpl(this.baseBackoffMs * 2 ** (attempt - 1));
    }
  }
}

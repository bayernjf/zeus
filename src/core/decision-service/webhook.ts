/**
 * Decision webhook dispatcher: push lifecycle events to registered HTTP
 * receivers instead of letting them poll listPending.
 *
 * Contract:
 *  - HMAC-SHA256 over the exact JSON body, `x-zeus-signature: sha256=<hex>`;
 *    receivers verify it before trusting the payload.
 *  - `x-zeus-delivery-id: <decisionId>:<type>:<at>` is deterministic per
 *    transition so a receiver can dedupe retries (at-least-once delivery).
 *  - Retryable failures (network error, 5xx, 429) get a small bounded
 *    exponential backoff; a 4xx other than 429 is a business rejection and
 *    is not retried.
 *  - Fail-soft by construction: emit() never throws into the decision path,
 *    and never writes back into the kernel. Real external channels stay
 *    external — this module only ships the local delivery mechanism.
 */
import { createHmac } from 'node:crypto';
import type { DecisionEvent, DecisionEventSink } from './events.js';

export interface DecisionWebhookSubscription {
  id: string;
  url: string;
  secret: string;
  active: boolean;
}

/** Read-only-plus-append registry of receivers. */
export interface DecisionWebhookStore {
  list(): DecisionWebhookSubscription[] | Promise<DecisionWebhookSubscription[]>;
  add(subscription: DecisionWebhookSubscription): void | Promise<void>;
}

export class MemoryDecisionWebhookStore implements DecisionWebhookStore {
  private readonly subscriptions: DecisionWebhookSubscription[] = [];

  list(): DecisionWebhookSubscription[] {
    return this.subscriptions.map(s => ({ ...s }));
  }

  add(subscription: DecisionWebhookSubscription): void {
    this.subscriptions.push({ ...subscription });
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

/** Compute the header signature a receiver must verify. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
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
    const headers = {
      'content-type': 'application/json',
      'x-zeus-delivery-id': webhookDeliveryId(event),
      'x-zeus-signature': signWebhookBody(subscription.secret, body),
    };
    let attempt = 0;
    for (;;) {
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

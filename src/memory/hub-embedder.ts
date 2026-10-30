import { createHash } from 'node:crypto';
import { LocalHashingEmbedder } from './recall.js';
import type { EmbedContext, Embedder } from './types.js';

/**
 * Hub-backed embedder (MemoryPort contract v1 §4, ruling D-1).
 *
 * The embedding call is an *authorised* out-of-realm call: the model comes
 * from the hub's `embed` alias assignment (doubao-embedding-vision, 2048
 * dimensions), enabled explicitly by leaving the kill switch off, and every
 * external call is audited by content hash only — plain text never reaches
 * the audit trail. Failures degrade to the local hashing embedder for a
 * cooldown window, then retry the hub; a dimension change (2048 ↔ 256) is
 * reported through the `dimension` getter so the store can rebuild the
 * derived recall index without ever mixing vector spaces.
 */

export interface HubEmbeddingEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Overrides the default `/embeddings` path (model-kit endpoint shape). */
  embeddingsPath?: string;
}

export interface HubEmbedCallAudit {
  /** SHA-256 of the embedded text; the text itself is never audited. */
  hash: string;
  ok: boolean;
  latencyMs: number;
  /** Realm whose memory the call served (P2-5); absent when unknown. */
  realmId?: string;
  reason?: string;
}

export interface HubEmbeddingEmbedderOptions {
  /**
   * Lazy alias resolution, consulted on every call: before the hub wiring
   * exists, or while the hub is unreachable, returning `null` keeps the
   * embedder in local mode without breaking the recall path.
   */
  resolveEndpoint: () => HubEmbeddingEndpoint | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** LRU capacity, keyed by vector dimension + content hash. */
  cacheSize?: number;
  /** Cooldown before the hub is retried after a failure, in minutes. */
  retryMinutes?: number;
  now?: () => number;
  onExternalCall?: (audit: HubEmbedCallAudit) => void;
}

interface EmbedResponseShape {
  data?: Array<{ embedding?: unknown }>;
}

export class HubEmbeddingEmbedder implements Embedder {
  private readonly local = new LocalHashingEmbedder();
  private readonly cache = new Map<string, number[]>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheSize: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly onExternalCall: ((audit: HubEmbedCallAudit) => void) | undefined;

  private hubDimension: number | null = null;
  private lastFailureAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: HubEmbeddingEmbedderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheSize = options.cacheSize ?? 10_000;
    this.retryMs = (options.retryMinutes ?? 5) * 60_000;
    this.now = options.now ?? Date.now;
    this.onExternalCall = options.onExternalCall;
  }

  /**
   * Vector space currently served: the hub dimension once known, otherwise
   * the local hashing dimension. A change between the two is what triggers
   * an index rebuild in the store.
   */
  get dimension(): number {
    return this.hubDimension ?? this.local.dimension;
  }

  async embed(text: string, ctx?: EmbedContext): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest('hex');
    const cached = this.cache.get(`${this.dimension}:${hash}`);
    if (cached) return cached;

    const vector = await this.embedUncached(text, hash, ctx);
    return vector;
  }

  private async embedUncached(text: string, hash: string, ctx?: EmbedContext): Promise<number[]> {
    const endpoint = this.options.resolveEndpoint();
    const mayRetry = this.now() - this.lastFailureAt >= this.retryMs;
    if (endpoint && (this.hubDimension !== null || mayRetry)) {
      const started = this.now();
      try {
        const vector = await this.fetchHubVector(text, endpoint);
        const latencyMs = this.now() - started;
        if (this.hubDimension === null) {
          this.hubDimension = vector.length;
        }
        this.audit(hash, true, latencyMs, undefined, ctx?.realmId);
        // Key by the dimension of the space this vector actually lives in, not
        // the `dimension` getter seen before the call: on the very first hub
        // success that getter still reads the local fallback, so keying with
        // it would file the hub vector under the local space and the cache
        // would miss (re-hitting the hub) until the next dimension change.
        this.cacheSet(`${vector.length}:${hash}`, vector);
        return vector;
      } catch (error) {
        // Any hub failure returns the embedder to the local vector space
        // (the dimension drop makes the store rebuild its index) and starts
        // the retry cooldown. The vector cache is dropped with it: after a
        // dimension drift the cached vectors would poison the recovered space.
        this.hubDimension = null;
        this.cache.clear();
        this.lastFailureAt = this.now();
        this.audit(hash, false, this.now() - started, error instanceof Error ? error.message : 'hub embed failed', ctx?.realmId);
        // Fall through to the local embedding for this call; the cooldown
        // gates further hub attempts until the retry window elapses.
      }
    }
    return this.local.embed(text);
  }

  private async fetchHubVector(
    text: string,
    endpoint: HubEmbeddingEndpoint,
  ): Promise<number[]> {
    const url = `${endpoint.baseUrl.replace(/\/$/, '')}${endpoint.embeddingsPath ?? '/embeddings'}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({ model: endpoint.model, input: [text] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`hub embed http ${response.status}`);
    }
    const body = (await response.json()) as EmbedResponseShape;
    const vector = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(v => typeof v === 'number')) {
      throw new Error('hub embed response shape invalid');
    }
    if (this.hubDimension !== null && vector.length !== this.hubDimension) {
      // A provider-side dimension change is a hard mismatch, not a transient
      // failure: refuse the vector rather than poison the vector space.
      throw new Error(`hub embed dimension drifted ${this.hubDimension} -> ${vector.length}`);
    }
    return vector;
  }

  private cacheSet(key: string, vector: number[]): void {
    if (this.cache.size >= this.cacheSize) {
      // Map iteration is insertion order, so the oldest entry is evicted.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, vector);
  }

  private audit(hash: string, ok: boolean, latencyMs: number, reason?: string, realmId?: string): void {
    this.onExternalCall?.({
      hash,
      ok,
      latencyMs,
      ...(realmId !== undefined ? { realmId } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
}

/**
 * Boot-time embedder choice: `enabled=false` (kill switch
 * `ZEUS_MEMORY_EMBEDDING=off`) pins the store to the local hashing embedder;
 * otherwise the hub-backed embedder is used and degrades on its own.
 */
export function createMemoryEmbedder(
  options: HubEmbeddingEmbedderOptions & { enabled: boolean },
): Embedder {
  return options.enabled ? new HubEmbeddingEmbedder(options) : new LocalHashingEmbedder();
}

import { sha256Hex } from '../util/crypto.js';
import { stableStringify } from './consolidate.js';
import type {
  Embedder,
  FactRecord,
  FactStatus,
  RecallHit,
  RecallSearchOptions,
} from './types.js';
import { DEFAULT_FACT_IMPORTANCE } from './types.js';

/**
 * Hybrid recall index (design-memory-consolidation.md §2, §4.2).
 *
 * The index is a derived, rebuildable artifact: it is never persisted and can
 * always be reconstructed from the fact store. It combines a BM25 lexical
 * score with a vector cosine score. Embeddings are asynchronous since the
 * hub-backed embedder landed (MemoryPort contract v1 §4, ruling D-1): the
 * default embedder stays the deterministic signed-hashing bag-of-words, a
 * hub model is injected through the same Embedder port, and a dimension
 * change on the embedder tells the store to rebuild the index.
 *
 * sync() is incremental (W2-1a, review P2-1 follow-up): each doc carries the
 * SHA-256 of its factText, so re-syncing an unchanged fact source re-embeds
 * nothing — what used to be a full clear-and-rebuild on every searchRecall
 * becomes a hashing pass. Dirty facts (new or changed text) embed through a
 * small bounded pool, because on a cold cache they used to line up as N serial
 * hub round trips (15s timeout each) on the decision path.
 */

const DEFAULT_ALPHA = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Hybrid-vs-importance blend (MemoryPort contract v1 §5.1):
 * score = 0.7 × hybrid + 0.3 × importance.
 */
const IMPORTANCE_WEIGHT = 0.3;

/** Facts in these statuses participate in recall; dead facts never do. */
const INDEXABLE_STATUSES: ReadonlySet<FactStatus> = new Set(['active', 'disputed']);

/**
 * How many dirty facts sync embeds at once. The hub embed call is an
 * authorised external round trip with a 15s timeout, so the pool bounds a
 * cold cache to ceil(N / 4) rounds instead of N serial waits, while never
 * opening an unbounded fan-out at the hub.
 */
const EMBED_CONCURRENCY = 4;

/**
 * How many content hashes keep their vector for reuse. Decay evicts stale
 * episodic docs from the index on every buildRecall, and the next sync would
 * otherwise re-embed them just to evict them again; this cache makes a
 * resurrection free. Bounded like the hub embedder's own vector cache.
 */
const VECTOR_CACHE_LIMIT = 10_000;

const HAN = /[一-鿿]/;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const runs = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const run of runs) {
    if (HAN.test(run)) {
      // Individual Han characters plus adjacent bigrams give a small
      // token-space leverage without any segmenter dependency.
      for (const ch of run) tokens.push(ch);
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    } else {
      tokens.push(run);
    }
  }
  return tokens;
}

/** 32-bit FNV-1a; the deterministic basis of the local hashing embedder. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Local, network-free embedder: each token is feature-hashed to a dimension
 * with a sign, accumulated, then L2-normalised. It carries no semantics beyond
 * token overlap — it is the offline-safe default and the fallback when the
 * hub embedder degrades (MemoryPort contract v1 §4).
 */
export class LocalHashingEmbedder implements Embedder {
  readonly dimension: number;

  constructor(dimension = 256) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimension).fill(0);
    for (const token of tokenize(text)) {
      const hash = fnv1a(token);
      const bucket = hash % this.dimension;
      const sign = (hash & 0x800000) === 0 ? 1 : -1;
      // bucket = hash % dimension, so it always indexes within the vector.
      vector[bucket]! += sign;
    }
    const norm = Math.hypot(...vector);
    return norm > 0 ? vector.map(v => v / norm) : vector;
  }
}

function cosine(a: number[], b: number[]): number {
  let sum = 0;
  // Both vectors come from the same embedder dimension; `?? 0` keeps a
  // length mismatch from leaking NaN into a rank.
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function factText(fact: FactRecord): string {
  return `${fact.subject} ${fact.predicate} ${stableStringify(fact.object)}`;
}

/** Effective importance at ranking time; episodic entries age down. */
export function effectiveImportance(fact: FactRecord, nowMs: number): number {
  const base = fact.importance ?? DEFAULT_FACT_IMPORTANCE;
  if (fact.kind !== 'episodic') return base;
  const last = fact.lastAccessAt ? Date.parse(fact.lastAccessAt) : Date.parse(fact.updatedAt);
  if (!Number.isFinite(last)) return base;
  const ageDays = Math.max(0, (nowMs - last) / 86_400_000);
  // Fourteen-day half-life (MemoryPort contract v1 §5.2); never destructive —
  // the stored importance stays the base, only the ranking discounts it.
  return base * Math.pow(0.5, ageDays / 14);
}

interface IndexedDoc {
  fact: FactRecord;
  tokens: string[];
  vector: number[];
  /** SHA-256 of factText(fact) at index time; the incremental-sync dirty marker. */
  hash: string;
}

/** A fact whose indexed vector is missing or no longer matches its content. */
interface DirtyFact {
  fact: FactRecord;
  text: string;
  hash: string;
  realmId: string;
}

export class RecallIndex {
  private docs = new Map<string, IndexedDoc>();
  /** Content hash -> vector, so unchanged text never embeds twice. */
  private readonly vectorsByHash = new Map<string, number[]>();

  /** Vector dimension of the embedder this index was built with. */
  readonly dimension: number;

  /**
   * The index serves exactly one realm (the store keeps one index per realm),
   * so every embed call carries the realm scope for the external-call audit
   * line (P2-5); absent only in bare constructed indexes (tests).
   */
  constructor(
    private readonly embedder: Embedder = new LocalHashingEmbedder(),
    private readonly realmId?: string,
  ) {
    this.dimension = embedder.dimension;
  }

  /**
   * Replace the index contents from the fact source (acceptance #5), embedding
   * only what changed. A fact whose factText still hashes to the stored doc's
   * hash keeps its vector — repeated syncs (the store rebuilds on every
   * searchRecall) cost a hashing pass, not N embed calls. Facts absent from
   * the list and facts outside INDEXABLE_STATUSES drop out, exactly as a full
   * rebuild would; a status flip to superseded/retracted removes the doc even
   * though its text hash is unchanged. A single embed failure is contained:
   * that fact keeps (or leaves) its previous doc as-is and a later sync
   * retries it, instead of one unembeddable fact aborting the whole sync.
   */
  async sync(facts: FactRecord[]): Promise<void> {
    const keep = new Set<string>();
    const dirty = new Map<string, DirtyFact>();
    for (const fact of facts) {
      if (!INDEXABLE_STATUSES.has(fact.status)) continue;
      keep.add(fact.factId);
      const text = factText(fact);
      const hash = sha256Hex(text);
      const existing = this.docs.get(fact.factId);
      if (existing && existing.hash === hash && existing.vector.length === this.dimension) {
        // Consolidation rebuilds fact objects each run; refresh the reference
        // so hits carry current metadata while the vector is reused as-is.
        existing.fact = fact;
        continue;
      }
      dirty.set(fact.factId, { fact, text, hash, realmId: fact.realmId ?? this.realmId });
    }
    for (const factId of [...this.docs.keys()]) {
      if (!keep.has(factId)) this.docs.delete(factId);
    }
    await this.embedDirty([...dirty.values()]);
  }

  async upsert(fact: FactRecord): Promise<void> {
    if (!INDEXABLE_STATUSES.has(fact.status)) {
      this.docs.delete(fact.factId);
      return;
    }
    const text = factText(fact);
    await this.embedEntry({ fact, text, hash: sha256Hex(text), realmId: fact.realmId ?? this.realmId });
  }

  /**
   * Embed the dirty facts through a bounded worker pool. Each worker pulls the
   * next index until the list is drained, so at most EMBED_CONCURRENCY embeds
   * are in flight; a per-fact failure is contained inside its worker and the
   * remaining dirty facts still land.
   */
  private async embedDirty(dirty: DirtyFact[]): Promise<void> {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(EMBED_CONCURRENCY, dirty.length) },
      async () => {
        while (next < dirty.length) {
          const entry = dirty[next++]!;
          try {
            await this.embedEntry(entry);
          } catch {
            // Fail soft: the index is derived, so leaving this fact out (or on
            // its previous vector) until the next sync beats aborting sync.
          }
        }
      },
    );
    await Promise.all(workers);
  }

  /** Reuse the cached vector for this content when possible, else embed. */
  private async embedEntry(entry: DirtyFact): Promise<void> {
    const cached = this.vectorsByHash.get(entry.hash);
    const vector = cached && cached.length === this.dimension
      ? cached
      : await this.embedder.embed(entry.text, { realmId: entry.realmId });
    this.cacheVector(entry.hash, vector);
    this.docs.set(entry.fact.factId, {
      fact: entry.fact,
      tokens: tokenize(entry.text),
      vector,
      hash: entry.hash,
    });
  }

  private cacheVector(hash: string, vector: number[]): void {
    if (this.vectorsByHash.has(hash)) return;
    if (this.vectorsByHash.size >= VECTOR_CACHE_LIMIT) {
      // Insertion-order eviction, the same policy as the hub embedder's cache.
      const oldest = this.vectorsByHash.keys().next().value;
      if (oldest !== undefined) this.vectorsByHash.delete(oldest);
    }
    this.vectorsByHash.set(hash, vector);
  }

  remove(factId: string): void {
    this.docs.delete(factId);
  }

  get size(): number {
    return this.docs.size;
  }

  async search(
    query: string,
    options: RecallSearchOptions = {},
    nowMs: number = Date.now(),
  ): Promise<RecallHit[]> {
    const alpha = options.alpha ?? DEFAULT_ALPHA;
    const limit = options.limit ?? 10;
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const queryVector = await this.embedder.embed(query, ...(this.realmId !== undefined ? [{ realmId: this.realmId }] : []));

    const docs = [...this.docs.values()];
    const lexicalById = this.bm25(queryTokens, docs);
    let maxLexical = 0;
    for (const score of lexicalById.values()) {
      if (score > maxLexical) maxLexical = score;
    }

    const hits: RecallHit[] = [];
    for (const doc of docs) {
      const rawLexical = lexicalById.get(doc.fact.factId) ?? 0;
      const lexical = maxLexical > 0 ? rawLexical / maxLexical : 0;
      const semantic = cosine(queryVector, doc.vector);
      const hybrid = alpha * semantic + (1 - alpha) * lexical;
      const importance = effectiveImportance(doc.fact, nowMs);
      const score = (1 - IMPORTANCE_WEIGHT) * hybrid + IMPORTANCE_WEIGHT * importance;
      // Relevance is decided by the hybrid term alone; importance only
      // re-ranks relevant hits (contract v1 §5.1). Gating on the blended
      // score would summon every indexed fact into every query — a legacy
      // fact's 0.5 baseline already clears zero on its own.
      if (hybrid > 0) hits.push({ fact: doc.fact, score, lexical, semantic });
    }

    return hits
      .sort((a, b) =>
        b.score - a.score ||
        a.fact.factId.localeCompare(b.fact.factId),
      )
      .slice(0, limit);
  }

  private bm25(queryTokens: string[], docs: IndexedDoc[]): Map<string, number> {
    const n = docs.length;
    const avgLength = n > 0
      ? docs.reduce((sum, d) => sum + d.tokens.length, 0) / n
      : 0;
    const queryTerms = new Set(queryTokens);
    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const documentFrequency = docs.filter(d => d.tokens.includes(term)).length;
      if (documentFrequency === 0) continue;
      const idf = Math.log(1 + (n - documentFrequency + 0.5) / (documentFrequency + 0.5));

      for (const doc of docs) {
        const tf = doc.tokens.filter(t => t === term).length;
        if (tf === 0) continue;
        const norm = 1 - BM25_B + BM25_B * (avgLength > 0 ? doc.tokens.length / avgLength : 0);
        const contribution = (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm);
        scores.set(doc.fact.factId, (scores.get(doc.fact.factId) ?? 0) + contribution);
      }
    }
    return scores;
  }
}

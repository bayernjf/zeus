import { stableStringify } from './consolidate.js';
import type {
  Embedder,
  FactRecord,
  FactStatus,
  RecallHit,
  RecallSearchOptions,
} from './types.js';

/**
 * Hybrid recall index (design-memory-consolidation.md §2, §4.2).
 *
 * The index is a derived, rebuildable artifact: it is never persisted and can
 * always be reconstructed from the fact store. It combines a BM25 lexical
 * score with a vector cosine score. Embeddings stay local/same-domain — the
 * default embedder is a deterministic signed-hashing bag-of-words; a real
 * local model can be injected through the Embedder port.
 */

const DEFAULT_ALPHA = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Facts in these statuses participate in recall; dead facts never do. */
const INDEXABLE_STATUSES: ReadonlySet<FactStatus> = new Set(['active', 'disputed']);

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
 * token overlap — it is the offline-safe default until a same-domain model is
 * available (deferred #10).
 */
export class LocalHashingEmbedder implements Embedder {
  readonly dimension: number;

  constructor(dimension = 256) {
    this.dimension = dimension;
  }

  embed(text: string): number[] {
    const vector = new Array<number>(this.dimension).fill(0);
    for (const token of tokenize(text)) {
      const hash = fnv1a(token);
      const bucket = hash % this.dimension;
      const sign = (hash & 0x800000) === 0 ? 1 : -1;
      vector[bucket] += sign;
    }
    const norm = Math.hypot(...vector);
    return norm > 0 ? vector.map(v => v / norm) : vector;
  }
}

function cosine(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function factText(fact: FactRecord): string {
  return `${fact.subject} ${fact.predicate} ${stableStringify(fact.object)}`;
}

interface IndexedDoc {
  fact: FactRecord;
  tokens: string[];
  vector: number[];
}

export class RecallIndex {
  private docs = new Map<string, IndexedDoc>();

  constructor(private readonly embedder: Embedder = new LocalHashingEmbedder()) {}

  /** Replace the whole index from the fact source (acceptance #5). */
  sync(facts: FactRecord[]): void {
    this.docs.clear();
    for (const fact of facts) this.upsert(fact);
  }

  upsert(fact: FactRecord): void {
    if (!INDEXABLE_STATUSES.has(fact.status)) {
      this.docs.delete(fact.factId);
      return;
    }
    const text = factText(fact);
    this.docs.set(fact.factId, {
      fact,
      tokens: tokenize(text),
      vector: this.embedder.embed(text),
    });
  }

  remove(factId: string): void {
    this.docs.delete(factId);
  }

  get size(): number {
    return this.docs.size;
  }

  search(query: string, options: RecallSearchOptions = {}): RecallHit[] {
    const alpha = options.alpha ?? DEFAULT_ALPHA;
    const limit = options.limit ?? 10;
    const queryTokens = tokenize(query);
    const queryVector = this.embedder.embed(query);
    if (queryTokens.length === 0) return [];

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
      const score = alpha * semantic + (1 - alpha) * lexical;
      if (score > 0) hits.push({ fact: doc.fact, score, lexical, semantic });
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

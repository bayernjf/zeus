import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DecisionAuditChain,
  verifyDecisionAuditChain,
  type DecisionAuditChainSigner,
  type DecisionAuditChainVerifier,
} from '../../core/audit/audit-chain.js';
import { decodeAuditJsonl, encodeAuditLine } from '../../core/audit/jsonl.js';
import type { DecisionAuditEntry, DecisionAuditInput } from '../../core/audit/types.js';

/** Raised when an existing audit file cannot be trusted on open. Fail-closed:
 *  the process must not keep writing decisions onto a trail that already
 *  failed verification. */
export class DecisionAuditStoreError extends Error {}

/**
 * Shell-side JSONL persistence for the decision audit chain (ADR-04).
 * The sealing/verification logic lives in core; this class only owns the
 * file: 0600-permissioned, append-only, verified on every open.
 */
export class JsonlDecisionAuditStore {
  private readonly chain: DecisionAuditChain;

  private constructor(
    private readonly path: string,
    signer: DecisionAuditChainSigner,
    entries: DecisionAuditEntry[],
    clock?: () => string,
  ) {
    this.chain = DecisionAuditChain.hydrate(signer, entries, clock);
  }

  /**
   * Open (or create) the trail. Existing entries are decoded and verified
   * before anything is appended; any tamper, gap or unknown key aborts open.
   */
  static async open(
    path: string,
    signer: DecisionAuditChainSigner,
    verifier: DecisionAuditChainVerifier,
    options: { clock?: () => string } = {},
  ): Promise<JsonlDecisionAuditStore> {
    ensureAuditFile(path);
    const text = readFileSync(path, 'utf8');
    const entries = text.trim() === '' ? [] : decodeAuditJsonl(text);
    const result = await verifyDecisionAuditChain(entries, verifier);
    if (!result.ok) {
      throw new DecisionAuditStoreError(
        `decision audit at ${path} fails verification at seq ${result.seq}: ${result.reason}`,
      );
    }
    return new JsonlDecisionAuditStore(path, signer, entries, options.clock);
  }

  /** Seal an event, append its line, and return the envelope. */
  async append(input: DecisionAuditInput): Promise<DecisionAuditEntry> {
    const entry = await this.chain.append(input);
    // The file is kept 0600 at every write (a recreate/rotation race must not
    // relax it), matching the dispatch audit sink's discipline.
    appendFileSync(this.path, `${encodeAuditLine(entry)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
    return entry;
  }

  list(): readonly DecisionAuditEntry[] {
    return this.chain.list();
  }

  get length(): number {
    return this.chain.length;
  }

  headHash(): string {
    return this.chain.headHash();
  }
}

/** Create the trail directory and file with owner-only permissions. */
function ensureAuditFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) appendFileSync(path, '', { mode: 0o600 });
  chmodSync(path, 0o600);
}

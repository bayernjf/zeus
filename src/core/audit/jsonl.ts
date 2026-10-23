import { validateAuditEntry } from './audit-chain.js';
import type { DecisionAuditEntry } from './types.js';

/** JSONL codec for sealed decision audit entries. Pure: no filesystem here;
 *  the shell-side file store lives in `src/app/audit/`. */
export class DecisionAuditCodecError extends Error {
  constructor(
    message: string,
    /** Line number (1-based) of the offending record. */
    readonly line: number,
  ) {
    super(message);
    this.name = 'DecisionAuditCodecError';
  }
}

/** One sealed entry as a single JSONL line (no trailing newline). */
export function encodeAuditLine(entry: DecisionAuditEntry): string {
  return JSON.stringify(entry);
}

/** A chain as JSONL text: one entry per line, trailing newline. */
export function encodeAuditJsonl(entries: readonly DecisionAuditEntry[]): string {
  return entries.map(entry => `${encodeAuditLine(entry)}\n`).join('');
}

/**
 * Parse one JSONL line into a sealed entry, structurally validating it.
 * Shape validation only — chain/hash/signature verification is
 * {@link verifyDecisionAuditChain}'s job.
 */
export function decodeAuditLine(line: string, lineNumber = 1): DecisionAuditEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new DecisionAuditCodecError(
      `audit line ${lineNumber}: unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      lineNumber,
    );
  }
  const issues = validateAuditEntry(parsed);
  if (issues.length > 0) {
    throw new DecisionAuditCodecError(`audit line ${lineNumber}: ${issues.join('; ')}`, lineNumber);
  }
  return parsed as DecisionAuditEntry;
}

/**
 * Parse whole JSONL text. A single trailing empty line (files end with a
 * newline) is tolerated; a gap or empty line in the middle is corruption, and
 * so is any malformed or structurally invalid record.
 */
export function decodeAuditJsonl(text: string): DecisionAuditEntry[] {
  const lines = text.split('\n');
  // text ending in '\n' produces one trailing '' element — that is the only
  // empty segment allowed.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const entries: DecisionAuditEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') {
      throw new DecisionAuditCodecError(`audit line ${i + 1}: empty line inside the trail (gap/rewrite detected)`, i + 1);
    }
    entries.push(decodeAuditLine(raw, i + 1));
  }
  return entries;
}

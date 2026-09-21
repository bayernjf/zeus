import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable whole-realm fingerprint: order-independent over itemIds, sensitive
 *  to both item paths and contents. Used as the backup/drift baseline. */
export function digestManifest(entries: Array<{ itemId: string; content: Buffer | string }>): string {
  const hash = createHash('sha256');
  const sorted = [...entries].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  for (const entry of sorted) {
    hash.update(entry.itemId);
    hash.update('\0');
    hash.update(sha256Hex(entry.content));
    hash.update('\n');
  }
  return hash.digest('hex');
}

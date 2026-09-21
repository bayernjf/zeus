import { createHash } from 'node:crypto';

/** SHA-256 hex digest shared by Realm fingerprints and roster signing. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

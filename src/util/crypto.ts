import { createHash } from 'node:crypto';

/** Algorithm label a digest that names its primitive carries in front of the hex body. */
export const SHA256_LABEL = 'sha256:';

/** SHA-256 hex digest shared by Realm fingerprints and roster signing. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * The same digest, tagged with the algorithm that produced it.
 *
 * The label used to be retyped by the signing module while the primitive lived
 * here, so the two could drift: swapping the hash would leave every signature
 * still claiming `sha256:`. Keeping both in one place makes the label a property
 * of the function rather than a string each caller has to remember.
 */
export function sha256Labeled(input: string | Buffer): string {
  return SHA256_LABEL + sha256Hex(input);
}

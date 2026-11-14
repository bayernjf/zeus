import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { BackupDecryptError, BackupFormatError, type SealedEnvelope } from './types.js';

const ALG = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

/**
 * scrypt cost for a passphrase-derived key. OWASP's current recommendation for
 * scrypt at r=8, p=1 is N=2^17; the earlier 2^14 was below it. `maxmem` must
 * cover 128*N*r, which is why it rises together with N.
 */
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Cost this tool used before the parameters were recorded in the envelope. */
const LEGACY_SCRYPT_N = 16_384;

type ScryptParams = { N: number; r: number; p: number };

/** Highest N a hostile envelope may ask us to pay for (2^20 ≈ 1 GiB at r=8). */
const MAX_ACCEPTED_SCRYPT_N = 1_048_576;

/** The cost an envelope was sealed with. Absent means it predates the field. */
function scryptParamsOf(envelope: SealedEnvelope): ScryptParams {
  return envelope.kdfParams ?? { N: LEGACY_SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
}

/** A passphrase (scrypt-derived) or a raw 32-byte key (KMS-style, KDF skipped). */
export type BackupKey = string | Buffer | Uint8Array;

function resolveKey(key: BackupKey, salt: Buffer, params: ScryptParams): Buffer {
  if (typeof key === 'string') {
    const maxmem = Math.max(SCRYPT_MAXMEM, 128 * params.N * params.r * 2);
    return scryptSync(key, salt, KEY_LEN, { ...params, maxmem });
  }
  if (key.length !== KEY_LEN) throw new BackupFormatError('raw backup key must be 32 bytes');
  return Buffer.from(key);
}

function b64(field: string, label: string): Buffer {
  const buf = Buffer.from(field, 'base64');
  if (field.length === 0) throw new BackupFormatError(`envelope ${label} is empty`);
  return buf;
}

/** Validate the envelope shape before touching crypto. */
export function validateEnvelopeShape(envelope: unknown): asserts envelope is SealedEnvelope {
  if (!envelope || typeof envelope !== 'object') throw new BackupFormatError('envelope is not an object');
  const e = envelope as Partial<SealedEnvelope>;
  if (e.alg !== ALG) throw new BackupFormatError(`unsupported envelope alg: ${String(e.alg)}`);
  if (e.kdf !== 'scrypt' && e.kdf !== 'none') throw new BackupFormatError(`unsupported kdf: ${String(e.kdf)}`);
  if (typeof e.format !== 'string' || !e.format) throw new BackupFormatError('envelope format is missing');
  for (const field of ['salt', 'iv', 'tag', 'ciphertext'] as const) {
    if (typeof e[field] !== 'string') throw new BackupFormatError(`envelope ${field} is missing`);
  }
  // The KDF cost is read from the envelope and then paid for, so it is
  // validated here: an envelope must not be able to pick a cost that is not a
  // legal scrypt N (a power of two) or that no operator would agree to.
  if (e.kdfParams !== undefined) {
    const { N, r, p } = e.kdfParams as Partial<ScryptParams>;
    const legal = (value: unknown, ceiling: number): boolean =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= ceiling;
    const isPowerOfTwo = typeof N === 'number' && Number.isInteger(N) && N > 0 && (N & (N - 1)) === 0;
    if (!legal(N, MAX_ACCEPTED_SCRYPT_N) || !isPowerOfTwo || !legal(r, 64) || !legal(p, 16)) {
      throw new BackupFormatError(`envelope kdfParams are not a usable scrypt cost: ${JSON.stringify(e.kdfParams)}`);
    }
  }
}

/** Encrypt UTF-8 plaintext into an authenticated envelope. */
export function seal(plaintext: string, format: string, key: BackupKey): SealedEnvelope {
  const salt = randomBytes(SALT_LEN);
  const params: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const derived = resolveKey(key, salt, params);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, derived, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const isPassphrase = typeof key === 'string';
  return {
    alg: ALG,
    kdf: isPassphrase ? 'scrypt' : 'none',
    format,
    // Record the cost, so raising N later does not orphan existing backups: an
    // envelope is opened with the parameters it was sealed with, not with
    // today's defaults.
    ...(isPassphrase ? { kdfParams: params } : {}),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt and authenticate an envelope; throws BackupDecryptError on any mismatch. */
export function open(envelope: SealedEnvelope, key: BackupKey): string {
  validateEnvelopeShape(envelope);
  const salt = b64(envelope.salt, 'salt');
  const derived = resolveKey(key, salt, scryptParamsOf(envelope));
  const iv = b64(envelope.iv, 'iv');
  const tag = b64(envelope.tag, 'tag');
  const data = b64(envelope.ciphertext, 'ciphertext');
  try {
    const decipher = createDecipheriv(ALG, derived, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new BackupDecryptError('failed to decrypt envelope (wrong key or tampered content)');
  }
}

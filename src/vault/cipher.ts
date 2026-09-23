import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { VaultDecryptError, VaultFormatError, type SealedEnvelope } from './types.js';

const ALG = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** A passphrase (scrypt-derived) or a raw 32-byte key (KMS-style, KDF skipped). */
export type VaultKey = string | Buffer | Uint8Array;

function resolveKey(key: VaultKey, salt: Buffer): Buffer {
  if (typeof key === 'string') return scryptSync(key, salt, KEY_LEN, SCRYPT_OPTS);
  if (key.length !== KEY_LEN) throw new VaultFormatError('raw vault key must be 32 bytes');
  return Buffer.from(key);
}

function b64(field: string, label: string): Buffer {
  const buf = Buffer.from(field, 'base64');
  if (field.length === 0) throw new VaultFormatError(`envelope ${label} is empty`);
  return buf;
}

/** Validate the envelope shape before touching crypto. */
export function validateEnvelopeShape(envelope: unknown): asserts envelope is SealedEnvelope {
  if (!envelope || typeof envelope !== 'object') throw new VaultFormatError('envelope is not an object');
  const e = envelope as Partial<SealedEnvelope>;
  if (e.alg !== ALG) throw new VaultFormatError(`unsupported envelope alg: ${String(e.alg)}`);
  if (e.kdf !== 'scrypt' && e.kdf !== 'none') throw new VaultFormatError(`unsupported kdf: ${String(e.kdf)}`);
  if (typeof e.format !== 'string' || !e.format) throw new VaultFormatError('envelope format is missing');
  for (const field of ['salt', 'iv', 'tag', 'ciphertext'] as const) {
    if (typeof e[field] !== 'string') throw new VaultFormatError(`envelope ${field} is missing`);
  }
}

/** Encrypt UTF-8 plaintext into an authenticated envelope. */
export function seal(plaintext: string, format: string, key: VaultKey): SealedEnvelope {
  const salt = randomBytes(SALT_LEN);
  const derived = resolveKey(key, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, derived, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: ALG,
    kdf: typeof key === 'string' ? 'scrypt' : 'none',
    format,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt and authenticate an envelope; throws VaultDecryptError on any mismatch. */
export function open(envelope: SealedEnvelope, key: VaultKey): string {
  validateEnvelopeShape(envelope);
  const salt = b64(envelope.salt, 'salt');
  const derived = resolveKey(key, salt);
  const iv = b64(envelope.iv, 'iv');
  const tag = b64(envelope.tag, 'tag');
  const data = b64(envelope.ciphertext, 'ciphertext');
  try {
    const decipher = createDecipheriv(ALG, derived, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultDecryptError('failed to decrypt envelope (wrong key or tampered content)');
  }
}

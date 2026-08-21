import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';

// Encrypts secrets that must be readable again later (Cloud API access tokens,
// app secrets) — unlike passwords (hashed, one-way), these have to round-trip
// so the Graph API client can use them. AES-256-GCM: authenticated, so a
// tampered/corrupted ciphertext fails to decrypt instead of silently returning
// garbage bytes.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM's recommended nonce size

function getKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CREDENTIALS_ENCRYPTION_KEY must be set in production');
    }
    // Dev/test fallback only — every restart re-derives the same fixed key, so
    // local data stays decryptable across restarts without a real secret.
    return Buffer.from('dev-only-insecure-credentials-key-32b', 'utf8').subarray(0, 32);
  }
  // Accept either a 32-byte hex string (64 chars) or any string, hashed down to 32 bytes.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw.padEnd(32, '0').slice(0, 32), 'utf8');
}

/** Encrypts `plain`, returning `v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>`. */
export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Reverses `encryptSecret`. Throws if the format is unrecognized or the auth tag doesn't match. */
export function decryptSecret(encoded: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unrecognized encrypted-secret format');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return plain.toString('utf8');
}

/** Last 4 characters of a plaintext secret, for display without ever storing/logging the full value. */
export function last4(plain: string): string {
  return plain.slice(-4);
}

/** Constant-time string comparison — for verify-token / signature checks where a
 *  timing side-channel could help an attacker guess the secret byte-by-byte. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

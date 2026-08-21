import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, safeEqual, last4 } from './crypto';

describe('crypto (secret-at-rest encryption)', () => {
  it('round-trips a secret', () => {
    const plain = 'EAAG_test_access_token_123456789';
    const enc = encryptSecret(plain);
    expect(enc).not.toBe(plain);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const plain = 'same-secret';
    expect(encryptSecret(plain)).not.toBe(encryptSecret(plain));
  });

  it('rejects a tampered ciphertext', () => {
    const enc = encryptSecret('some-secret');
    const parts = enc.split(':');
    // Flip a hex character in the ciphertext part.
    parts[3] = (parts[3][0] === '0' ? '1' : '0') + parts[3].slice(1);
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('rejects an unrecognized format', () => {
    expect(() => decryptSecret('not-encrypted')).toThrow();
  });

  it('safeEqual matches equal strings and rejects different ones', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('last4 returns only the last 4 characters', () => {
    expect(last4('EAAG1234567890')).toBe('7890');
  });
});

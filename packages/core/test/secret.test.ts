import { describe, it, expect } from 'vitest';
import { sha256 } from 'viem';
import { isValidSecret, assertValidSecret } from '../src/secret.js';

describe('Secret Safety & HashLock Validation', () => {
  const secret =
    '0x047d4023f91247f41f1f0d054cf4dc1c81de4b629928a308e14e23fde24a3079';
  const hashLock = sha256(secret);
  const zeroSecret = `0x${'00'.repeat(32)}`;

  it('accepts valid 32-byte secret matching hashLock', () => {
    expect(isValidSecret(secret, hashLock)).toBe(true);
    expect(isValidSecret(secret.slice(2), hashLock)).toBe(true);
    expect(isValidSecret(secret, hashLock.slice(2))).toBe(true);
    expect(isValidSecret(secret.toUpperCase(), hashLock.toLowerCase())).toBe(
      true,
    );
    expect(() => assertValidSecret(secret, hashLock)).not.toThrow();
  });

  it('rejects all-zero secret when hashLock is from non-zero secret', () => {
    expect(isValidSecret(zeroSecret, hashLock)).toBe(false);
    expect(() => assertValidSecret(zeroSecret, hashLock)).toThrow(
      /Invalid secret/,
    );
  });

  it('rejects mismatched secret and hashLock', () => {
    const wrongSecret = `0x${'11'.repeat(32)}`;
    expect(isValidSecret(wrongSecret, hashLock)).toBe(false);
    expect(() => assertValidSecret(wrongSecret, hashLock)).toThrow(
      /does not match/,
    );
  });

  it('rejects null, undefined, and non-string secrets', () => {
    expect(isValidSecret(null, hashLock)).toBe(false);
    expect(isValidSecret(undefined, hashLock)).toBe(false);
    expect(isValidSecret('', hashLock)).toBe(false);
    expect(isValidSecret(secret, null)).toBe(false);
    expect(isValidSecret(secret, undefined)).toBe(false);
    expect(isValidSecret(secret, '')).toBe(false);
  });

  it('rejects malformed hex and wrong length secrets', () => {
    expect(isValidSecret('0x1234', hashLock)).toBe(false);
    expect(isValidSecret(`0x${'00'.repeat(31)}`, hashLock)).toBe(false);
    expect(isValidSecret(`0x${'00'.repeat(33)}`, hashLock)).toBe(false);
    expect(
      isValidSecret(
        'not-hex-at-all-0000000000000000000000000000000000000000000000000000',
        hashLock,
      ),
    ).toBe(false);
  });
});

import { sha256 } from 'viem';

/**
 * Validates that a secret is a well-formed 32-byte hex string (with or without 0x prefix)
 * and that sha256(secret) strictly matches the expected hashLock.
 *
 * Rejects:
 * - null, undefined, empty strings, non-string values
 * - lengths other than 32 bytes (64 or 66 chars with 0x)
 * - invalid hex characters
 * - any secret where sha256(secret) does not strictly match hashLock (case-insensitive hex compare)
 */
export function isValidSecret(
  secret: string | null | undefined,
  hashLock: string | null | undefined,
): boolean {
  if (!secret || typeof secret !== 'string') return false;
  if (!hashLock || typeof hashLock !== 'string') return false;

  const cleanSecretHex = secret.toLowerCase().startsWith('0x')
    ? secret.slice(2)
    : secret;
  if (
    cleanSecretHex.length !== 64 ||
    !/^[0-9a-fA-F]{64}$/.test(cleanSecretHex)
  ) {
    return false;
  }

  const cleanHashHex = hashLock.toLowerCase().startsWith('0x')
    ? hashLock.slice(2)
    : hashLock;
  if (cleanHashHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(cleanHashHex)) {
    return false;
  }

  try {
    const computedHash = sha256(`0x${cleanSecretHex}` as `0x${string}`);
    const computedHex = computedHash.slice(2).toLowerCase();
    return computedHex === cleanHashHex.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Asserts that a secret is valid and matches the given hashLock, throwing an Error if not.
 */
export function assertValidSecret(
  secret: string | null | undefined,
  hashLock: string | null | undefined,
  context = 'secret',
): asserts secret is `0x${string}` {
  if (!isValidSecret(secret, hashLock)) {
    throw new Error(
      `Invalid ${context}: secret is missing, malformed, or sha256(secret) does not match expected hashLock`,
    );
  }
}

import { hexToBin, binToHex } from '@bitauth/libauth';

/**
 * Convert category hex from display (RPC) byte order to internal (introspection) byte order.
 * Display order is big-endian; internal introspection returns little-endian (reversed bytes).
 */
export function displayHexToInternalHex(displayHex: string): string {
  const clean = displayHex.startsWith('0x') ? displayHex.slice(2) : displayHex;
  if (clean.length !== 64) {
    throw new Error(
      `Invalid category hex length: expected 64 hex chars, got ${clean.length}`,
    );
  }
  const bytes = hexToBin(clean);
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    reversed[i] = bytes[bytes.length - 1 - i]!;
  }
  return binToHex(reversed);
}

/**
 * Convert category hex from internal (introspection) byte order to display (RPC) byte order.
 */
export function internalHexToDisplayHex(internalHex: string): string {
  // Reversal is symmetric
  return displayHexToInternalHex(internalHex);
}

/**
 * Convert display category hex string to internal category Uint8Array (32 bytes).
 */
export function displayToInternalCategory(displayHex: string): Uint8Array {
  const internalHex = displayHexToInternalHex(displayHex);
  return hexToBin(internalHex);
}

/**
 * Convert internal category Uint8Array (32 bytes) to display category hex string.
 */
export function internalToDisplayCategory(internalBytes: Uint8Array): string {
  if (internalBytes.length !== 32) {
    throw new Error(
      `Invalid internal category length: expected 32 bytes, got ${internalBytes.length}`,
    );
  }
  const internalHex = binToHex(internalBytes);
  return internalHexToDisplayHex(internalHex);
}

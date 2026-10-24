import { hexToBin, binToHex } from '@bitauth/libauth';
import {
  categoryDisplayToInternal,
  categoryInternalToDisplay,
} from '@ferry/core';

export { categoryDisplayToInternal, categoryInternalToDisplay };

/**
 * Convert category hex from display (RPC) byte order to internal (introspection) byte order.
 * Display order is big-endian; internal introspection returns little-endian (reversed bytes).
 * Uses @ferry/core's canonical categoryDisplayToInternal representation.
 */
export function displayHexToInternalHex(displayHex: string): string {
  const normalized = displayHex.startsWith('0x')
    ? displayHex
    : `0x${displayHex}`;
  const internalHex = categoryDisplayToInternal(normalized);
  return internalHex.slice(2);
}

/**
 * Convert category hex from internal (introspection) byte order to display (RPC) byte order.
 */
export function internalHexToDisplayHex(internalHex: string): string {
  const normalized = internalHex.startsWith('0x')
    ? internalHex
    : `0x${internalHex}`;
  const displayHex = categoryInternalToDisplay(normalized);
  return displayHex.slice(2);
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

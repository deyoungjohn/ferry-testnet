import { hexToBytes, bytesToHex } from 'viem';
import { assertHex32 } from './signing.js';
import type { Hex32 } from './terms.js';
/** Only representation conversion; script/introspection construction belongs to @ferry/htlc-bch. */
export function categoryDisplayToInternal(display: string): Hex32 {
  const normalized = display.startsWith('0x') ? display : `0x${display}`;
  assertHex32(normalized);
  return bytesToHex(hexToBytes(normalized).reverse());
}
export function categoryInternalToDisplay(internal: string): Hex32 {
  return categoryDisplayToInternal(internal);
}

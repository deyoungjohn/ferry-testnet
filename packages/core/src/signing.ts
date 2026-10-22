import { isAddress, verifyMessage } from 'viem';
import type { Hex, Hex32 } from './terms.js';
export interface OrderSigner {
  signMessage(args: { message: { raw: Hex32 } }): Promise<Hex>;
}
export function assertHex32(value: string): asserts value is Hex32 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError('Expected 32 raw bytes');
}
/** EIP-191 personal-sign over the 32 RAW bytes of orderId, never the 66-character hex text. */
export async function signOrderId(
  orderId: Hex32,
  signer: OrderSigner,
): Promise<Hex> {
  assertHex32(orderId);
  return signer.signMessage({ message: { raw: orderId } });
}
/** Uses the identical raw-byte convention; malformed signatures/addresses return false. */
export async function verifyOrderSignature(
  orderId: Hex32,
  signature: Hex,
  address: string,
): Promise<boolean> {
  assertHex32(orderId);
  if (!isAddress(address)) return false;
  try {
    return await verifyMessage({
      address,
      message: { raw: orderId },
      signature,
    });
  } catch {
    return false;
  }
}

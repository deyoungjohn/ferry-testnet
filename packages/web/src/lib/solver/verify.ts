import {
  orderId as computeOrderId,
  verifyOrderSignature,
  type OrderTerms,
} from '@ferry/core';
import type { Address } from 'viem';
import type { SignedQuote } from './types';

export async function verifySignedQuote(
  quote: SignedQuote,
  trustedSigner: Address,
): Promise<boolean> {
  if (quote.signerAddress.toLowerCase() !== trustedSigner.toLowerCase()) {
    return false;
  }
  const id = computeOrderId(quote.terms);
  if (id !== quote.orderId) return false;
  return verifyOrderSignature(id, quote.signature, trustedSigner);
}

export function isQuoteExpired(
  terms: OrderTerms,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return nowSeconds >= terms.quoteExpiry;
}

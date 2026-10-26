import type { OrderTerms } from '@ferry/core';

export function assertQuoteStillOpen(
  terms: OrderTerms,
  nowSeconds = Math.floor(Date.now() / 1_000),
): void {
  if (nowSeconds >= terms.quoteExpiry) {
    throw new Error(
      'The quote expired while your wallet was signing. Nothing was locked; get a fresh quote.',
    );
  }
}

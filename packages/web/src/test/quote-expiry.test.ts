import { describe, expect, it } from 'vitest';
import type { OrderTerms } from '@ferry/core';
import { assertQuoteStillOpen } from '../lib/quote/expiry';

const terms = { quoteExpiry: 1_000 } as OrderTerms;

describe('quote expiry while signing', () => {
  it('allows a live quote', () => {
    expect(() => assertQuoteStillOpen(terms, 999)).not.toThrow();
  });

  it('refuses a quote that expired during wallet signing', () => {
    expect(() => assertQuoteStillOpen(terms, 1_000)).toThrow(
      /expired while your wallet was signing. Nothing was locked/i,
    );
  });
});

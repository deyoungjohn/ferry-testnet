import { beforeEach, describe, expect, it } from 'vitest';
import { bchClaimConfirmationCopy } from '../lib/bch/confirmations';
import {
  loadOrderSource,
  payeeName,
  saveOrderSource,
  statusWording,
} from '../lib/orders/context';

describe('pay-link wording', () => {
  beforeEach(() => window.localStorage.clear());

  it('invoice pages say invoice, pay and they receive', () => {
    expect(statusWording('invoice')).toEqual({
      eyebrow: 'Invoice Status',
      sendLabel: 'You pay',
      receiveLabel: 'They receive',
    });
  });

  it('tips have their own words', () => {
    expect(statusWording('tip').eyebrow).toBe('Tip Status');
    expect(statusWording('tip').sendLabel).toBe('You tip');
    expect(payeeName('tip')).toBe('Recipient');
  });

  it('plain swaps keep the swap words', () => {
    expect(statusWording('swap').eyebrow).toBe('Swap status');
    expect(loadOrderSource(`0x${'11'.repeat(32)}`)).toBe('swap');
  });

  it('remembers the source of an order', () => {
    const id = `0x${'22'.repeat(32)}`;
    saveOrderSource(id, 'invoice');
    expect(loadOrderSource(id)).toBe('invoice');
  });

  it('names the invoice owner and the amount in the claim card', () => {
    const payment = { source: 'invoice', amount: '5.00' } as const;
    expect(bchClaimConfirmationCopy(0, false, payment).body).toBe(
      'Invoice owner receives 5.00 tPUSD after 1 confirmation; chipnet blocks can take several minutes.',
    );
    expect(bchClaimConfirmationCopy(1, false, payment).body).toBe(
      'Invoice owner has received 5.00 tPUSD.',
    );
    expect(
      bchClaimConfirmationCopy(1, false, { source: 'tip', amount: '1.00' })
        .body,
    ).toBe('Recipient has received 1.00 tPUSD.');
  });
});

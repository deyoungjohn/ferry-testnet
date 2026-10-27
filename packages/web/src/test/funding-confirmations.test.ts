import { describe, expect, it } from 'vitest';
import { bchClaimConfirmationCopy } from '../lib/bch/confirmations';

describe('BCH claim confirmation copy', () => {
  it('explains the mempool wait and the confirmed state', () => {
    expect(bchClaimConfirmationCopy(null).title).toBe('BCH claim confirmation');
    expect(bchClaimConfirmationCopy(0)).toMatchObject({
      title: 'BCH claim in the mempool',
      confirmed: false,
    });
    expect(bchClaimConfirmationCopy(0).body).toMatch(/chipnet blocks/i);
    expect(bchClaimConfirmationCopy(1)).toMatchObject({
      title: 'BCH claim confirmed · 1 confirmation',
      confirmed: true,
    });
    expect(bchClaimConfirmationCopy(2).title).toBe(
      'BCH claim confirmed · 2 confirmations',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { bchClaimConfirmationCopy } from '../lib/bch/confirmations';

describe('BCH claim card copy by direction', () => {
  it('forward: the user claims PUSD and sees it in the wallet after one confirmation', () => {
    expect(bchClaimConfirmationCopy(0).title).toBe('BCH claim in the mempool');
    expect(bchClaimConfirmationCopy(1).body).toContain(
      'wallet should now show',
    );
  });

  it('reverse: the claim is the solver’s and nothing is asked of the user', () => {
    const pending = bchClaimConfirmationCopy(0, true);
    expect(pending.title).toBe('Solver tPUSD claim in the mempool');
    expect(pending.body).toContain('nothing more is needed from you');
    expect(pending.body).not.toContain('wallet should');
    const done = bchClaimConfirmationCopy(1, true);
    expect(done.confirmed).toBe(true);
    expect(done.body).not.toContain('wallet should');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRememberedBchWallet,
  readRememberedBchWallet,
  saveRememberedBchWallet,
} from '../lib/wallet/remembered';
import { parseBchAddress } from '../lib/bch/address';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';

beforeEach(() => {
  localStorage.clear();
});

describe('remembered BCH wallet', () => {
  it('saves and restores the paired name and token-aware address', () => {
    const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
    if (!parsed.ok) throw new Error(parsed.error);
    saveRememberedBchWallet('Paytaca', parsed.value);
    expect(readRememberedBchWallet()).toMatchObject({
      name: 'Paytaca',
      address: {
        address: parsed.value.address,
        lockingBytecode: parsed.value.lockingBytecode,
        tokenAware: true,
      },
    });
  });

  it('forgets the identity explicitly', () => {
    const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
    if (!parsed.ok) throw new Error(parsed.error);
    saveRememberedBchWallet('Paytaca', parsed.value);
    clearRememberedBchWallet();
    expect(readRememberedBchWallet()).toBeNull();
  });
});

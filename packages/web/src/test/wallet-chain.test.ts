import { describe, expect, it } from 'vitest';
import { isWrongEvmChain, wrongEvmChainMessage } from '../lib/wallet/chain';

describe('EVM wallet chain guard', () => {
  it('accepts Base Sepolia and rejects another chain', () => {
    expect(isWrongEvmChain(84_532, 84_532)).toBe(false);
    expect(isWrongEvmChain(1, 84_532)).toBe(true);
    expect(isWrongEvmChain(undefined, 84_532)).toBe(false);
  });

  it('names the expected chain in the message', () => {
    expect(wrongEvmChainMessage(84_532)).toBe(
      'Switch your wallet to Base Sepolia (chain 84532).',
    );
  });
});

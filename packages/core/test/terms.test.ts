import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalCBOR, orderId, parseOrderTerms } from '../src/terms.js';
import { baseTerms } from './fixtures/terms.js';

describe('OrderTerms deterministic encoding', () => {
  it('normalizes hex and EVM addresses, and rejects malformed terms', () => {
    expect(parseOrderTerms({ ...baseTerms, hashLock: baseTerms.hashLock.toUpperCase().replace('0X','0x') })).toEqual(baseTerms);
    for (const patch of [
      { version: 2 }, { extra: 1 }, { hashLock: '0x00' }, { bchTokenCategory: '0x' },
      { bchTokenAmount: 0n }, { counterAmount: -1n }, { counterAmount: 1n << 256n },
      { counterAsset: { ...baseTerms.counterAsset, decimals: 37 } },
      { counterAsset: { ...baseTerms.counterAsset, extra: true } },
      { counterHtlc: 'bad' }, { counterNetworkId: '84532' },
      { userBchLockingBytecode: '0x0' }, { quoteId: '\ud800' },
      { bchMaxFee: 3001n }, { counterDeadline: 1.5 },
    ]) expect(() => parseOrderTerms({ ...baseTerms, ...patch })).toThrow();
  });
  it('supports Solana and Tron base58 addresses with explicit network labels', () => {
    for (const chain of ['solana','tron'] as const) {
      const address=chain === 'tron' ? `T${'1'.repeat(33)}` : '1'.repeat(32);
      const terms={...baseTerms,counterChain:chain,counterNetworkId:chain==='tron'?'nile':'devnet',counterHtlc:address,userCounterAddress:address,solverCounterAddress:address,counterAsset:{...baseTerms.counterAsset,address}};
      expect(parseOrderTerms(terms).counterChain).toBe(chain);
      expect(() => parseOrderTerms({...terms,counterHtlc:'0OIl'})).toThrow();
    }
  });
  it('ignores insertion order and uses byte strings for declared hex fields', () => {
    expect(canonicalCBOR(Object.fromEntries(Object.entries(baseTerms).reverse()))).toEqual(canonicalCBOR(baseTerms));
    const encoded=Buffer.from(canonicalCBOR(baseTerms)).toString('hex');
    expect(encoded).toContain(`5820${baseTerms.hashLock.slice(2)}`);
    expect(encoded).not.toContain(Buffer.from(baseTerms.hashLock).toString('hex'));
  });
  for (const name of ['forward','reverse','bsc18']) {
    it(`matches independent committed ${name} golden vector`, () => {
      const fixture=JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url),'utf8'));
      const terms={...fixture.terms};
      for (const field of ['bchTokenAmount','counterAmount','bchCarrySats','bchMaxFee']) terms[field]=BigInt(terms[field]);
      expect(Buffer.from(canonicalCBOR(terms)).toString('hex')).toBe(fixture.cborHex);
      expect(orderId(terms)).toBe(fixture.orderId);
    });
  }
  it('uses tag 2 only above uint64; handles all shortest integer boundaries', () => {
    for(const amount of [1n,23n,24n,255n,256n,65535n,65536n,4294967295n,4294967296n,(1n<<64n)-1n,1n<<64n]) {
      const encoded=Buffer.from(canonicalCBOR({...baseTerms,counterAmount:amount})).toString('hex');
      expect(encoded.length).toBeGreaterThan(1);
      if(amount===1n<<64n) expect(encoded).toContain('c249010000000000000000');
    }
  });
});

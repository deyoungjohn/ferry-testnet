import { describe, expect, it, vi } from 'vitest';
import {
  ElectrumBchTipReader,
  bchQuoteConfigError,
  fetchBchTip,
  type ElectrumTipFactory,
} from '../lib/bch/tip';
import { rejectionMessage } from './rejection';

const factory: ElectrumTipFactory = (url) => ({
  connect: async () => {
    if (url.includes('down')) throw new Error('connection refused');
  },
  tipHeight: async () => (url.includes('high') ? 120 : 100),
  close: () => undefined,
});

describe('independent BCH tip', () => {
  it('takes the lower height when more than one Electrum endpoint answers', async () => {
    await expect(
      fetchBchTip(['wss://high', 'wss://low'], factory),
    ).resolves.toEqual({
      height: 100,
      source: 'wss://low',
    });
  });

  it('fails closed when every endpoint is unreachable', async () => {
    expect(await rejectionMessage(fetchBchTip(['wss://down'], factory))).toBe(
      'BCH tip unavailable from every Electrum endpoint: connection refused',
    );
  });

  it('caches a successful tip for the configured TTL', async () => {
    const read = vi.fn(factory);
    let now = 1_000;
    const reader = new ElectrumBchTipReader(
      ['wss://tip'],
      30_000,
      () => now,
      read,
    );

    await expect(reader.read()).resolves.toBe(100);
    await expect(reader.read()).resolves.toBe(100);
    expect(read).toHaveBeenCalledTimes(1);
    now += 30_001;
    await expect(reader.read()).resolves.toBe(100);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('BCH quote network validation', () => {
  it('refuses mainnet quoting with a single Electrum endpoint', () => {
    expect(bchQuoteConfigError('mainnet', [])).toMatch(
      /two independent BCH Electrum endpoints/i,
    );
    expect(bchQuoteConfigError('mainnet', ['wss://one'])).toMatch(
      /two independent BCH Electrum endpoints/i,
    );
    expect(bchQuoteConfigError('mainnet', ['wss://one', 'wss://one'])).toMatch(
      /two independent BCH Electrum endpoints/i,
    );
    expect(
      bchQuoteConfigError('mainnet', [
        'wss://ONE.example:50004',
        'wss://one.example:50005/',
      ]),
    ).toMatch(/two independent BCH Electrum endpoints/i);
  });

  it('allows mainnet quoting with two independent endpoints', () => {
    expect(
      bchQuoteConfigError('mainnet', ['wss://one', 'wss://two']),
    ).toBeNull();
  });

  it('leaves chipnet quoting unchanged', () => {
    expect(bchQuoteConfigError('chipnet', ['wss://one'])).toBeNull();
  });
});

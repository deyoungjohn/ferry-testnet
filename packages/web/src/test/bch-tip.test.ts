import { describe, expect, it, vi } from 'vitest';
import {
  ElectrumBchTipReader,
  fetchBchTip,
  type ElectrumTipFactory,
} from '../lib/bch/tip';

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
    await expect(fetchBchTip(['wss://down'], factory)).rejects.toThrow(
      'BCH tip unavailable from every Electrum endpoint',
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

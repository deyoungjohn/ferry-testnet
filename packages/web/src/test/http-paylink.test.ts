import { serializeApiJson } from '@ferry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BchTipReader } from '../lib/bch/tip';
import { parseBchAddress } from '../lib/bch/address';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';
import { createMockSolverClient } from '../lib/solver/mock';
import { HttpSolverClient } from '../lib/solver/http';
import { generateSecret, hashLockForSecret } from '../lib/swap';

const bchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!bchResult.ok) throw new Error(bchResult.error);
const bchAddress = bchResult.value;

const payer = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
const reader: BchTipReader = { read: async () => 123_456 };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function invoice() {
  const solver = createMockSolverClient();
  const link = await solver.createPayLink({
    kind: 'invoice',
    recipientCashaddr: bchAddress.address,
    recipientLockingBytecode: bchAddress.lockingBytecode,
    token: 'PUSD',
    amountOut: 4_000n,
  });
  return { solver, link };
}

describe('HttpSolverClient pay links', () => {
  it('parses create, get, list and cancel responses', async () => {
    const { link } = await invoice();
    const cancelled = { ...link, status: 'cancelled' as const };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/links?')) {
        return new Response(serializeApiJson({ links: [link] }));
      }
      if (url.endsWith('/cancel')) {
        return new Response(serializeApiJson(cancelled));
      }
      return new Response(serializeApiJson(link));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpSolverClient('http://solver.test', reader);

    const created = await client.createPayLink({
      kind: 'invoice',
      recipientCashaddr: bchAddress.address,
      recipientLockingBytecode: bchAddress.lockingBytecode,
      token: 'PUSD',
      amountOut: 4_000n,
    });
    expect(created.id).toBe(link.id);

    expect((await client.getPayLink(link.id)).amountOut).toBe(4_000n);
    expect(
      (
        await client.listPayLinks({
          owner: bchAddress.address,
          challenge: 'a'.repeat(32),
          sig: 'b'.repeat(64),
        })
      ).length,
    ).toBe(1);
    expect(
      (
        await client.cancelPayLink(link.id, {
          owner: bchAddress.address,
          challenge: 'a'.repeat(32),
          sig: 'b'.repeat(64),
        })
      ).status,
    ).toBe('cancelled');
  });

  it('attaches an independent tip to a pay-link quote', async () => {
    const { solver, link } = await invoice();
    const request = {
      counterChain: 'base' as const,
      counterSymbol: 'USDC' as const,
      userCounterAddress: payer,
      hashLock: hashLockForSecret(generateSecret()),
      lane: 'safe' as const,
    };
    const quote = await solver.quotePayLink(link.id, request);
    const { bchTipHeight, ...response } = quote;
    void bchTipHeight;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(serializeApiJson(response))),
    );
    const client = new HttpSolverClient('http://solver.test', reader);

    const result = await client.quotePayLink(link.id, request);
    expect(result.bchTipHeight).toBe(123_456);
    expect(result.terms.bchTokenAmount).toBe(4_000n);
  });
});

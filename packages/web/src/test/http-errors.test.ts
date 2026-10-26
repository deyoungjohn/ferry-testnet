import { serializeApiJson } from '@ferry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBchAddress } from '../lib/bch/address';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';
import { HttpSolverClient } from '../lib/solver/http';
import { describeSolverError } from '../lib/solver/errors';
import { rejectionMessage } from './rejection';

const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!parsed.ok) throw new Error(parsed.error);
const bchAddress = parsed.value;

function request() {
  return {
    direction: 'COUNTER_TO_BCH' as const,
    bchToken: 'PUSD' as const,
    counterChain: 'base' as const,
    counterSymbol: 'USDC' as const,
    amountIn: 10_000_000n,
    userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' as const,
    userBchLockingBytecode: bchAddress.lockingBytecode,
    hashLock: `0x${'11'.repeat(32)}` as const,
    lane: 'safe' as const,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTTP solver errors', () => {
  it('separates a network failure from a solver response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const client = new HttpSolverClient('http://solver.test');
    const failure = describeSolverError(
      new Error(await rejectionMessage(client.quote(request()))),
    );
    expect(failure.kind).toBe('local');
  });

  it('treats a proxy 502 as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>bad gateway</html>', { status: 502 }),
      ),
    );
    const client = new HttpSolverClient('http://solver.test');
    try {
      await client.quote(request());
      throw new Error('expected failure');
    } catch (cause) {
      expect(describeSolverError(cause)).toMatchObject({
        kind: 'unreachable',
        code: 'UNREACHABLE',
      });
    }
  });

  it('maps a typed solver error and keeps its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            serializeApiJson({
              code: 'BCH_TIP_UNHEALTHY',
              message: 'BCH quorum is unhealthy',
            }),
            { status: 503 },
          ),
      ),
    );
    const client = new HttpSolverClient('http://solver.test');
    try {
      await client.quote(request());
      throw new Error('expected failure');
    } catch (cause) {
      const failure = describeSolverError(cause);
      expect(failure.kind).toBe('solver');
      expect(failure.code).toBe('BCH_TIP_UNHEALTHY');
      expect(failure.sentence).toMatch(/healthy Bitcoin Cash tip/i);
      expect(failure.nextStep).toMatch(/check the solver health line/i);
    }
  });

  it('keeps an unknown solver code visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            serializeApiJson({ code: 'FUTURE_CODE', message: 'new failure' }),
            { status: 400 },
          ),
      ),
    );
    const client = new HttpSolverClient('http://solver.test');
    try {
      await client.quote(request());
      throw new Error('expected failure');
    } catch (cause) {
      expect(describeSolverError(cause)).toMatchObject({
        kind: 'unknown',
        code: 'FUTURE_CODE',
      });
    }
  });
});

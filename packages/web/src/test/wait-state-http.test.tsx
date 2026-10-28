// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeApiJson } from '@ferry/core';
import { SwapStatusPage } from '../routes/SwapStatusPage';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';
import { parseBchAddress } from '../lib/bch/address';
import { generateSecret, hashLockForSecret } from '../lib/swap';
import { createMockSolverClient } from '../lib/solver/mock';
import { HttpSolverClient } from '../lib/solver/http';
import { SolverContext } from '../lib/solver/context';
import { MockWalletProvider } from '../lib/wallet/mock';

const bchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!bchResult.ok) throw new Error(bchResult.error);
const bchAddress = bchResult.value;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wait-state with the solver millisecond timestamp', () => {
  it('shows a real elapsed time from the HTTP response format and the stall hint', async () => {
    const quote = await createMockSolverClient().quote({
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      counterChain: 'base',
      counterSymbol: 'USDC',
      amountIn: 1_000n,
      userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
      userBchLockingBytecode: bchAddress.lockingBytecode,
      hashLock: hashLockForSecret(generateSecret()),
      lane: 'safe',
    });
    const response = {
      orderId: quote.orderId,
      status: 'USER_LOCK_SEEN' as const,
      lane: 'safe' as const,
      terms: quote.terms,
      signature: quote.signature,
      signerAddress: quote.signerAddress,
      txIds: {
        userLockTxId:
          '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
      },
      deadlines: {
        quoteExpiry: quote.terms.quoteExpiry,
        counterDeadline: quote.terms.counterDeadline,
        bchRefundHeight: quote.terms.bchRefundHeight,
      },
      // The solver stores Date.now() milliseconds; do not hand-write a
      // seconds value here.
      updatedAt: Date.now() - 4 * 60_000,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(serializeApiJson(response))),
    );
    const client = new HttpSolverClient('http://solver.test', {
      read: async () => 100,
    });

    render(
      <MemoryRouter initialEntries={[`/swap/${quote.orderId}`]}>
        <MockWalletProvider>
          <SolverContext.Provider value={client}>
            <Routes>
              <Route path="/swap/:orderId" element={<SwapStatusPage />} />
            </Routes>
          </SolverContext.Provider>
        </MockWalletProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Waiting for 1 BCH confirmation (0 of 1)'),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Elapsed: 4m/)).toBeInTheDocument();
    expect(
      screen.getByText(/This step is taking longer than expected/i),
    ).toBeInTheDocument();
  });
});

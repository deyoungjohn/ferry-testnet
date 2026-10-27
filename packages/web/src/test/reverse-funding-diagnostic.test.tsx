// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { OrderTerms } from '@ferry/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReverseFundingPanel } from '../components/ReverseFundingPanel';
import { parseBchAddress } from '../lib/bch/address';
import { MOCK_BCH_USER_ADDRESS, PUSD_CATEGORY } from '../lib/config';
import { createMockSolverClient } from '../lib/solver/mock';
import { generateSecret, hashLockForSecret } from '../lib/swap';
import { WalletSignedTransactionError } from '../lib/wallet/signed-check';
import { WalletContext } from '../lib/wallet/context';

afterEach(cleanup);

const user = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!user.ok) throw new Error(user.error);
const userInfo = user.value;

async function reverseTerms(): Promise<OrderTerms> {
  const quote = await createMockSolverClient().quote({
    direction: 'BCH_TO_COUNTER',
    bchToken: 'PUSD',
    counterChain: 'base',
    counterSymbol: 'USDC',
    amountIn: 100n,
    userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    userBchLockingBytecode: userInfo.lockingBytecode,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe',
  });
  return quote.terms;
}

function renderPanel(terms: OrderTerms) {
  const bch = {
    status: 'connected',
    address: userInfo,
    error: null,
    walletName: 'Paytaca',
    pendingRequest: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    setAddress: vi.fn(),
    listUtxos: vi.fn(async () => [
      {
        txid: 'aa'.repeat(32),
        vout: 0,
        satoshis: 10_000n,
        lockingBytecode: userInfo.lockingBytecode,
        token: { category: PUSD_CATEGORY, amount: 100n },
      },
    ]),
    signTransaction: vi.fn(async () => {
      throw new WalletSignedTransactionError({
        ok: false,
        problems: ['Input 1 came back unsigned (empty unlocking script).'],
        failedInput: 1,
        diagnostic: {
          unsignedHex: '00',
          signedHex: '00',
          problems: ['Input 1 came back unsigned (empty unlocking script).'],
          failedInput: 1,
          inputs: [],
          sourceOutputs: [],
        },
      });
    }),
    broadcastTransaction: vi.fn(async () => 'cc'.repeat(32)),
  };
  render(
    <WalletContext.Provider
      value={
        {
          usingMocks: true,
          bch,
          evm: {
            status: 'disconnected',
            address: null,
            error: null,
            pendingRequest: null,
          },
        } as never
      }
    >
      <ReverseFundingPanel terms={terms} onFunded={vi.fn()} />
    </WalletContext.Provider>,
  );
}

describe('reverse funding diagnostic', () => {
  it('names the failed input and exposes copyable diagnostics', async () => {
    const terms = await reverseTerms();
    renderPanel(terms);
    await screen.findByText('Fund the BCH lock');
    screen.getByRole('button', { name: 'Sign with BCH wallet' }).click();
    expect(
      await screen.findByText(/Input 1 failed the local check/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy diagnostic' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Signed transaction diagnostic · input 1/),
    ).toBeInTheDocument();
  });
});

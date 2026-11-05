import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveOrderSource } from '../lib/orders/context';
import type { PersistedOrder } from '../lib/orders/store';
import { createMockSolverClient } from '../lib/solver/mock';
import { generateSecret, hashLockForSecret } from '../lib/swap';
import { parseBchAddress } from '../lib/bch/address';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';

const records: PersistedOrder[] = [];
vi.mock('../lib/orders/store', async (original) => ({
  ...(await original<typeof import('../lib/orders/store')>()),
  listOrderRecords: async () => records,
}));
vi.mock('../lib/solver/kind', () => ({ solverIsLive: () => false }));

import { ActivityPage } from '../routes/ActivityPage';

async function order(): Promise<PersistedOrder> {
  const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
  if (!parsed.ok) throw new Error(parsed.error);
  const quote = await createMockSolverClient().quote({
    direction: 'COUNTER_TO_BCH',
    bchToken: 'PUSD',
    counterChain: 'base',
    counterSymbol: 'USDC',
    amountIn: 10_000_000n,
    userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    userBchLockingBytecode: parsed.value.lockingBytecode,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe',
  });
  return {
    orderId: quote.orderId,
    status: 'DONE',
    terms: quote.terms,
    lane: quote.lane,
    bchTipHeight: quote.bchTipHeight,
    bchTipError: null,
    updatedAt: 1,
    transactions: [
      {
        label: 'USDC locked on Base',
        chain: 'base',
        hash: `0x${'ab'.repeat(32)}`,
      },
    ],
    bchLockUtxo: null,
    claimAvailable: false,
    refundAvailable: false,
    bchRefundAvailable: false,
    createdAt: 1_793_000_000,
    solverLive: false,
  } as PersistedOrder;
}

describe('My Activity', () => {
  beforeEach(() => {
    records.length = 0;
    window.localStorage.clear();
  });

  it('says so when there is nothing yet', async () => {
    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it('lists orders with the kind, a status link and explorer links', async () => {
    const record = await order();
    records.push(record);
    saveOrderSource(record.orderId, 'invoice');
    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Invoice payment/)).toBeTruthy();
    const open = screen.getByRole('link', { name: 'Open status' });
    expect(open.getAttribute('href')).toBe(`/swap/${record.orderId}`);
    expect(screen.getByText(/USDC locked on Base/)).toBeTruthy();
  });
});

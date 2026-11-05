import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecentSwaps, RECENT_SWAPS_PAGE_SIZE } from '../components/RecentSwaps';
import type { RecentSwap } from '../lib/stats/types';

function swap(index: number): RecentSwap {
  return {
    orderId: `0x${index.toString(16).padStart(64, '0')}`,
    direction: 'COUNTER_TO_BCH',
    counterSymbol: 'USDC',
    counterAmount: BigInt(1_000_000 + index),
    counterDecimals: 6,
    bchSymbol: 'tPUSD',
    bchTokenAmount: BigInt(100 + index),
    bchDecimals: 2,
    settledAt: 1_793_000_000 + index,
    durationSeconds: 30,
    baseTxId: `0x${'aa'.repeat(32)}`,
    bchTxId: 'bb'.repeat(32),
  } as RecentSwap;
}

describe('RecentSwaps pagination', () => {
  it('shows one page at a time and moves with Next and Previous', () => {
    const data = Array.from({ length: RECENT_SWAPS_PAGE_SIZE + 3 }, (_, i) =>
      swap(i),
    );
    render(<RecentSwaps resource={{ status: 'ready', data }} />);
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(screen.getAllByRole('time').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
  });

  it('has no pager when everything fits on one page', () => {
    render(
      <RecentSwaps resource={{ status: 'ready', data: [swap(1), swap(2)] }} />,
    );
    expect(screen.queryByText(/Page 1 of/)).toBeNull();
  });
});

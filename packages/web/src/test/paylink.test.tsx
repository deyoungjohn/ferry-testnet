// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { quoteExactOut, type PayLinkQuoteRequest } from '@ferry/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { parseBchAddress } from '../lib/bch/address';
import {
  MOCK_BCH_USER_ADDRESS,
  FIXED_FEE_USD_MICROS,
  PUSD_DECIMALS,
  SPREAD_BPS,
  USDC_DECIMALS,
} from '../lib/config';
import {
  MOCK_EXPIRED_LINK_ID,
  MOCK_PAY_LINK_ID,
  MOCK_RESERVED_LINK_ID,
  mockMessageSignature,
  payLinkMessage,
  verifyPayLinkSignature,
} from '../lib/paylink/link';
import { createMockSolverClient } from '../lib/solver/mock';
import { SolverProvider } from '../lib/solver/SolverProvider';
import { generateSecret, hashLockForSecret } from '../lib/swap';
import { MockWalletProvider } from '../lib/wallet/mock';
import { rejectionMessage } from './rejection';

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MockWalletProvider>
        <SolverProvider>
          <App />
        </SolverProvider>
      </MockWalletProvider>
    </MemoryRouter>,
  );
}

const payer = '0x2222222222222222222222222222222222222222' as const;
const ROUTE_WAIT = { timeout: 10_000 } as const;

function quoteRequest(
  amountOut?: bigint,
  userCounterAddress: `0x${string}` = payer,
): PayLinkQuoteRequest {
  return {
    counterChain: 'base',
    counterSymbol: 'USDC',
    userCounterAddress,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe',
    ...(amountOut !== undefined ? { amountOut } : {}),
  };
}

describe('pay link quotes', () => {
  it('prices an invoice with the exact inverse quote and reserves it', async () => {
    const solver = createMockSolverClient();
    const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
    if (!parsed.ok) throw new Error(parsed.error);
    const link = await solver.createPayLink({
      kind: 'invoice',
      recipientCashaddr: parsed.value.address,
      recipientLockingBytecode: parsed.value.lockingBytecode,
      token: 'PUSD',
      amountOut: 4_000n,
    });

    const quote = await solver.quotePayLink(link.id, quoteRequest());
    expect(quote.terms.bchTokenAmount).toBe(4_000n);
    expect(quote.terms.counterAmount).toBe(
      quoteExactOut(4_000n, USDC_DECIMALS, PUSD_DECIMALS, {
        spreadBps: SPREAD_BPS,
        fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
      }),
    );

    const reserved = await solver.getPayLink(link.id);
    expect(reserved.status).toBe('reserved');
    expect(
      await rejectionMessage(
        solver.quotePayLink(
          link.id,
          quoteRequest(undefined, '0x3333333333333333333333333333333333333333'),
        ),
      ),
    ).toMatch(/LINK_RESERVED/);
  });

  it('allows the same payer to refresh a reserved invoice', async () => {
    const solver = createMockSolverClient();
    const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
    if (!parsed.ok) throw new Error(parsed.error);
    const link = await solver.createPayLink({
      kind: 'invoice',
      recipientCashaddr: parsed.value.address,
      recipientLockingBytecode: parsed.value.lockingBytecode,
      token: 'PUSD',
      amountOut: 4_000n,
    });
    const first = await solver.quotePayLink(link.id, quoteRequest());
    const firstHash = first.terms.hashLock;

    const refreshed = await solver.quotePayLink(link.id, quoteRequest());
    expect(refreshed.terms.hashLock).not.toBe(firstHash);
    expect(refreshed.terms.bchTokenAmount).toBe(4_000n);
  });

  it('accepts an open-link amount', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quotePayLink(
      MOCK_PAY_LINK_ID,
      quoteRequest(1_234n),
    );
    expect(quote.terms.bchTokenAmount).toBe(1_234n);
    expect((await solver.getPayLink(MOCK_PAY_LINK_ID)).status).toBe('open');
  });
});

describe('pay link signatures', () => {
  it('only verifies the signed challenge and locking bytecode', () => {
    const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
    if (!parsed.ok) throw new Error(parsed.error);
    const challenge = 'a'.repeat(32);
    const message = payLinkMessage(challenge, parsed.value.lockingBytecode);
    expect(
      verifyPayLinkSignature(
        challenge,
        mockMessageSignature(message),
        parsed.value.lockingBytecode,
      ),
    ).toBe(true);
    expect(
      verifyPayLinkSignature(
        challenge,
        mockMessageSignature('ferry:paylink:v1:other'),
        parsed.value.lockingBytecode,
      ),
    ).toBe(false);
  });
});

describe('pay link pages', () => {
  it('creates a signed link and keeps the URL to the id only', async () => {
    renderAt('/pay');

    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: /connect bch wallet/i },
        ROUTE_WAIT,
      ),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /create pay link/i }),
    );

    expect(
      await screen.findByText(/10 tPUSD invoice/i, undefined, {
        timeout: 20_000,
      }),
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText('Test-mode signature')).length,
    ).toBeGreaterThan(0);

    const url = await screen.findByText(
      (content) => content.startsWith('http') && content.includes('/p/'),
    );
    expect(url.textContent).not.toContain('bchtest:');
    expect(url.textContent).not.toContain('10.00');
  }, 30_000);

  it('shows an invoice with its exact amount and test-mode signature label', async () => {
    renderAt(`/p/${MOCK_RESERVED_LINK_ID}`);

    expect(
      await screen.findByRole(
        'heading',
        {
          level: 1,
          name: /pay 40 tPUSD/i,
        },
        ROUTE_WAIT,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Test-mode signature').length).toBeGreaterThan(
      0,
    );
  }, 30_000);

  it('blocks a reserved invoice before a second payer can quote', async () => {
    renderAt(`/p/${MOCK_RESERVED_LINK_ID}`);

    expect(
      await screen.findByText(
        'This invoice is being paid.',
        undefined,
        ROUTE_WAIT,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /get exact quote/i }),
    ).toBeDisabled();
  }, 30_000);

  it('blocks an expired link before quoting', async () => {
    renderAt(`/p/${MOCK_EXPIRED_LINK_ID}`);

    expect(
      await screen.findByText(/this link has expired/i, undefined, ROUTE_WAIT),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /get exact quote/i }),
    ).toBeDisabled();
  }, 30_000);

  it('quotes an open link for a Base payer without a BCH wallet', async () => {
    renderAt(`/p/${MOCK_PAY_LINK_ID}`);

    fireEvent.click(
      await screen.findByRole('button', { name: /connect base/i }, ROUTE_WAIT),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /get exact quote/i }),
    );

    expect(
      await screen.findByText('You pay', undefined, { timeout: 20_000 }),
    ).toBeInTheDocument();
    expect(
      (
        await screen.findAllByText(/10 tPUSD/, undefined, {
          timeout: 20_000,
        })
      ).length,
    ).toBeGreaterThan(0);
  }, 30_000);
});

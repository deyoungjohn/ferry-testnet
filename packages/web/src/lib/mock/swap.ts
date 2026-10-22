/**
 * MOCK DATA — L0 scaffold only.
 *
 * Everything the home page displays comes from this module. No chain is
 * queried and no wallet is connected. The quote follows blueprint §3.5 with
 * the §8 defaults, but it will be replaced by @ferry/core pricing.
 */

export interface MockToken {
  readonly symbol: string;
  readonly name: string;
  readonly chain: string;
  readonly chainShort: string;
}

export const MOCK_PRICING = {
  spreadBps: 40,
  fixedFeeUsd: 0.05,
  maxSwapUsd: 50,
} as const;

export interface MockQuote {
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly rate: number;
  readonly spreadBps: number;
  readonly fixedFeeUsd: number;
}

export function quoteMockUsdToPusd(inputUsd: number): MockQuote {
  if (!Number.isFinite(inputUsd) || inputUsd <= 0) {
    throw new RangeError('Input must be a positive finite USD amount');
  }

  if (inputUsd > MOCK_PRICING.maxSwapUsd) {
    throw new RangeError(`Mock swap cap is $${MOCK_PRICING.maxSwapUsd}`);
  }

  const inputCents = Math.round(inputUsd * 100);
  const feeCents = Math.round(MOCK_PRICING.fixedFeeUsd * 100);
  const afterSpreadCents = Math.floor(
    (inputCents * (10_000 - MOCK_PRICING.spreadBps)) / 10_000,
  );
  const outputCents = afterSpreadCents - feeCents;

  if (outputCents <= 0) {
    throw new RangeError('Output is zero after the spread and fixed fee');
  }

  const roundedInputUsd = inputCents / 100;
  const outputUsd = outputCents / 100;

  return {
    inputUsd: roundedInputUsd,
    outputUsd,
    rate: outputUsd / roundedInputUsd,
    spreadBps: MOCK_PRICING.spreadBps,
    fixedFeeUsd: MOCK_PRICING.fixedFeeUsd,
  };
}

export function formatUsd(value: number): string {
  return value.toFixed(2);
}

export const MOCK_TOKENS = {
  usdcBase: {
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'Base',
    chainShort: 'BASE',
  },
  pusd: {
    symbol: 'PUSD',
    name: 'PUSD',
    chain: 'Bitcoin Cash',
    chainShort: 'BCH',
  },
} as const satisfies Record<string, MockToken>;

const MOCK_QUOTE = quoteMockUsdToPusd(42.5);

export const MOCK_SWAP = {
  isMock: true,
  maxSwapUsd: MOCK_PRICING.maxSwapUsd,
  lane: 'safe',
  send: {
    label: 'You send',
    amount: formatUsd(MOCK_QUOTE.inputUsd),
    fiat: `≈ $${formatUsd(MOCK_QUOTE.inputUsd)}`,
    balance: '96.40 USDC',
    token: MOCK_TOKENS.usdcBase,
  },
  receive: {
    label: 'You receive',
    amount: formatUsd(MOCK_QUOTE.outputUsd),
    fiat: `≈ $${formatUsd(MOCK_QUOTE.outputUsd)}`,
    balance: '0.00 PUSD',
    token: MOCK_TOKENS.pusd,
    pinned: true,
  },
  quote: {
    rate: `1 USDC = ${MOCK_QUOTE.rate.toFixed(4)} PUSD`,
    spread: `${MOCK_QUOTE.spreadBps / 100}%`,
    fee: `$${formatUsd(MOCK_QUOTE.fixedFeeUsd)}`,
    lane: 'Safe lane · ~1 BCH block',
    arrival: '~10 min',
  },
} as const;

export const MOCK_BANNER = {
  priorWork: 'old repo / pre-BLAZE demo',
  emberAddress: 'not set',
} as const;

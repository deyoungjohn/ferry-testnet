/**
 * MOCK DATA — L0 scaffold only.
 *
 * Everything the home page displays comes from this module. No chain is
 * queried, no quote is priced and no wallet is connected. Replace these
 * values with solver quotes in a later phase.
 */

export interface MockToken {
  readonly symbol: string;
  readonly name: string;
  readonly chain: string;
  readonly chainShort: string;
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

export const MOCK_SWAP = {
  isMock: true,
  lane: 'safe',
  send: {
    label: 'You send',
    amount: '250.00',
    fiat: '≈ $250.00',
    balance: '1,204.50 USDC',
    token: MOCK_TOKENS.usdcBase,
  },
  receive: {
    label: 'You receive',
    amount: '248.80',
    fiat: '≈ $248.80',
    balance: '0.00 PUSD',
    token: MOCK_TOKENS.pusd,
    pinned: true,
  },
  quote: {
    rate: '1 USDC = 0.9952 PUSD',
    spread: '0.4%',
    lane: 'Safe lane · ~1 BCH block',
    arrival: '~10 min',
  },
} as const;

export const MOCK_BANNER = {
  priorWork: 'old repo / pre-BLAZE demo',
  emberAddress: 'not set',
} as const;

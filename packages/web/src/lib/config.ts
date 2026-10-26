export const NETWORK_LABEL = 'Testnet';

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_RPC_URL =
  import.meta.env?.VITE_BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
export const BASE_EXPLORER_URL = 'https://sepolia.basescan.org';
export const BCH_EXPLORER_URL = 'https://blockexplorer.cash/chipnet';

export const FERRY_HTLC_ADDRESS =
  '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641' as const;
export const FERRY_HTLC_CODE_HASH =
  '0x684ed535a307fb57a0ee587c1421b9534a19138e2d18f8f91ab8ad3bc069440d' as const;

export const USDC_ADDRESS =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const USDC_DECIMALS = 6;
export const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: BASE_SEPOLIA_CHAIN_ID,
  verifyingContract: USDC_ADDRESS,
} as const;

export const BCH_NETWORK = 'chipnet' as const;
export const BCH_PREFIX = 'bchtest' as const;
export const BCH_ELECTRUM_URL =
  import.meta.env?.VITE_BCH_ELECTRUM_URL ||
  'wss://chipnet.imaginary.cash:50004';
export const PUSD_CATEGORY =
  '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac' as const;
export const PUSD_DECIMALS = 2;
export const PUSD_SYMBOL = 'tPUSD';

export const MAX_SWAP_USD_MICROS = 50_000_000n;
export const MIN_SWAP_USD_MICROS = 1_000_000n;
export const SPREAD_BPS = 40;
export const FIXED_FEE_USD_MICROS = 50_000n;
export const QUOTE_TTL_S = 60;
export const MAX_QUOTE_FUTURE_S = 300;
export const BCH_CARRY_SATS = 3_000n;
export const BCH_MAX_FEE_SATS = 1_500n;
export const FWD_BCH_REFUND_BLOCKS = 36;
export const FWD_EVM_DEADLINE_S = 86_400;
export const REV_BCH_REFUND_BLOCKS = 144;
export const REV_EVM_DEADLINE_S = 21_600;
export const BCH_BLOCK_SECONDS = 600;
export const FAST_LANE_MAX_USD_MICROS = 25_000_000n;

export const MOCK_SOLVER_SIGNING_ADDRESS =
  '0x1Ec1DB9462247d5A2F48C224472591e222A20aF2' as const;
export const MOCK_BCH_USER_ADDRESS =
  'bchtest:zznldca5825k6le8hpnwxhzugn82j2gm8uzgy6y6j8' as const;
export const MOCK_BCH_SOLVER_ADDRESS =
  'bchtest:zz3r8kfgl8qs94pyswepj6dylqf5avuf9ygs8308u4' as const;
export const SOLVER_SIGNING_ADDRESS = (
  import.meta.env?.VITE_SOLVER_SIGNING_ADDRESS ?? ''
).trim();
export const SOLVER_COUNTER_ADDRESS = (SOLVER_SIGNING_ADDRESS ||
  MOCK_SOLVER_SIGNING_ADDRESS) as `0x${string}`;
export const SOLVER_BCH_ADDRESS = (
  import.meta.env?.VITE_SOLVER_BCH_ADDRESS || MOCK_BCH_SOLVER_ADDRESS
).trim();

export function requireSolverSigner(): `0x${string}` {
  if (import.meta.env?.VITE_SOLVER_URL && !SOLVER_SIGNING_ADDRESS) {
    throw new Error(
      'Set VITE_SOLVER_SIGNING_ADDRESS to the solver signer address when using VITE_SOLVER_URL',
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(SOLVER_COUNTER_ADDRESS)) {
    throw new Error('VITE_SOLVER_SIGNING_ADDRESS is not a valid EVM address');
  }
  return SOLVER_COUNTER_ADDRESS;
}

export const REOWN_PROJECT_ID = import.meta.env?.VITE_REOWN_PROJECT_ID ?? '';

export function explorerTxUrl(chain: 'base' | 'bch', txid: string): string {
  return chain === 'base'
    ? `${BASE_EXPLORER_URL}/tx/${txid}`
    : `${BCH_EXPLORER_URL}/tx/${txid}`;
}

export const BANNER = {
  priorWork: 'old repo / pre-BLAZE demo',
  emberAddress: 'not set',
} as const;

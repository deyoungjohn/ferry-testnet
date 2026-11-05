import {
  MAINNET_PROFILE,
  TESTNET_PROFILE,
  readNetworkSetting,
  networkConfigErrors,
  type NetworkProfile,
} from './network';

const setting = readNetworkSetting(import.meta.env?.VITE_NETWORK);

export const NETWORK_KIND = setting.kind;
export const NETWORK_PROFILE: NetworkProfile =
  setting.kind === 'mainnet' ? MAINNET_PROFILE : TESTNET_PROFILE;
export const IS_MAINNET = NETWORK_PROFILE.isMainnet;
export const NETWORK_LABEL = NETWORK_PROFILE.label;
export const NETWORK_CONFIG_ERRORS = networkConfigErrors(
  NETWORK_PROFILE,
  setting.error,
);

function env(key: string): string {
  return (import.meta.env?.[key] ?? '').trim();
}

function testnetEnv(key: string): string {
  return IS_MAINNET ? '' : env(key);
}

export const BASE_CHAIN_ID = NETWORK_PROFILE.base.chainId;
export const BASE_CHAIN_NAME = NETWORK_PROFILE.base.chainName;
export const BASE_RPC_URL =
  testnetEnv('VITE_BASE_SEPOLIA_RPC_URL') || NETWORK_PROFILE.base.rpcUrl;
export const BASE_EXPLORER_URL = NETWORK_PROFILE.base.explorerUrl;
export const BCH_CHAIN_NAME = NETWORK_PROFILE.bch.chainName;
export const BCH_EXPLORER_URL = NETWORK_PROFILE.bch.explorerUrl;
export const BCH_NETWORK = NETWORK_PROFILE.bch.network;
export const BCH_PREFIX = NETWORK_PROFILE.bch.prefix;

const configuredElectrum = IS_MAINNET
  ? NETWORK_PROFILE.bch.electrumUrls
  : [
      testnetEnv('VITE_BCH_ELECTRUM_URL') ||
        NETWORK_PROFILE.bch.electrumUrls[0] ||
        '',
      ...NETWORK_PROFILE.bch.electrumUrls.slice(1),
      testnetEnv('VITE_BCH_ELECTRUM_URL_2'),
    ];
export const BCH_ELECTRUM_URLS = [
  ...new Set(configuredElectrum.filter((url) => url.length > 0)),
] as readonly string[];
export const BCH_ELECTRUM_URL = BCH_ELECTRUM_URLS[0] ?? '';

export const FERRY_HTLC_ADDRESS = NETWORK_PROFILE.base
  .htlcAddress as `0x${string}`;
export const FERRY_HTLC_DEPLOY_BLOCK = NETWORK_PROFILE.base.htlcDeployBlock;
export const FERRY_HTLC_CODE_HASH = NETWORK_PROFILE.base
  .htlcCodeHash as `0x${string}`;

export const USDC_ADDRESS = NETWORK_PROFILE.base.usdcAddress as `0x${string}`;
export const USDC_DECIMALS = NETWORK_PROFILE.base.usdcDecimals;
export const USDC_DOMAIN = {
  name: NETWORK_PROFILE.base.usdcDomainName,
  version: NETWORK_PROFILE.base.usdcDomainVersion,
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_ADDRESS,
} as const;

export const PUSD_CATEGORY = NETWORK_PROFILE.bch.pusdCategory;
export const MUSD_CATEGORY = NETWORK_PROFILE.bch.musdCategory;
export const PUSD_DECIMALS = NETWORK_PROFILE.bch.decimals;
export const MUSD_DECIMALS = NETWORK_PROFILE.bch.decimals;
export const PUSD_SYMBOL = NETWORK_PROFILE.bch.pusdSymbol;
export const MUSD_SYMBOL = NETWORK_PROFILE.bch.musdSymbol;

export const MAX_SWAP_USD_MICROS = NETWORK_PROFILE.limits.maxUsdMicros;
export const MIN_SWAP_USD_MICROS = NETWORK_PROFILE.limits.minUsdMicros;
export const FAST_LANE_MAX_USD_MICROS =
  NETWORK_PROFILE.limits.fastLaneMaxUsdMicros;
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

export const MOCK_SOLVER_SIGNING_ADDRESS =
  TESTNET_PROFILE.solver.signingAddress;
export const MOCK_BCH_USER_ADDRESS = TESTNET_PROFILE.bch.mockUserAddress;
export const MOCK_BCH_SOLVER_ADDRESS = TESTNET_PROFILE.bch.mockSolverAddress;
export const SOLVER_SIGNING_ADDRESS = testnetEnv('VITE_SOLVER_SIGNING_ADDRESS');
export const SOLVER_COUNTER_ADDRESS = (SOLVER_SIGNING_ADDRESS ||
  NETWORK_PROFILE.solver.signingAddress) as `0x${string}`;
export const SOLVER_BCH_ADDRESS =
  testnetEnv('VITE_SOLVER_BCH_ADDRESS') || NETWORK_PROFILE.solver.bchAddress;

export function requireSolverSigner(): `0x${string}` {
  if (import.meta.env?.VITE_SOLVER_URL && !SOLVER_SIGNING_ADDRESS) {
    throw new Error(
      'Set VITE_SOLVER_SIGNING_ADDRESS to the solver signer address when using VITE_SOLVER_URL',
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(SOLVER_COUNTER_ADDRESS)) {
    throw new Error('The solver signer address is not a valid EVM address');
  }
  return SOLVER_COUNTER_ADDRESS;
}

export const REOWN_PROJECT_ID = env('VITE_REOWN_PROJECT_ID');

export function explorerTxUrl(chain: 'base' | 'bch', txid: string): string {
  if (chain === 'base') {
    return BASE_EXPLORER_URL ? `${BASE_EXPLORER_URL}/tx/${txid}` : '#';
  }
  return BCH_EXPLORER_URL ? `${BCH_EXPLORER_URL}/tx/${txid}` : '#';
}

export const BANNER = {
  priorWork: 'old repo / pre-BLAZE demo',
  emberAddress: 'not set',
} as const;

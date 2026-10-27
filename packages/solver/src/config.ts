import { z } from 'zod';

export const DEFAULT_DEV_EVM_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export const SolverConfigSchema = z
  .object({
    port: z.coerce.number().default(8787),
    host: z.string().default('127.0.0.1'),
    dbPath: z.string().default(':memory:'),
    network: z.enum(['testnet', 'mainnet']).default('testnet'),
    bchElectrumUrls: z
      .string()
      .default(
        'wss://chipnet.imaginary.cash:50004,wss://blackie.c3-soft.com:64004',
      ),
    baseRpcUrl: z.string().default('https://sepolia.base.org'),
    baseChainId: z.coerce.number().default(84532),
    baseHtlcAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .default('0x5A0C062f4B7b8fF2263530e12bc15De9C836a641'),
    baseUsdcAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .default('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
    solverEvmPrivateKey: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .default(DEFAULT_DEV_EVM_PRIVATE_KEY),
    solverBchWif: z.string().optional(),
    userBchWif: z.string().optional(),
    userEvmPrivateKey: z.string().optional(),
    tpusdCategory: z
      .string()
      .default(
        'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
      ),
    tmusdCategory: z
      .string()
      .default(
        'c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d',
      ),
    pusdCategory: z.string().optional(),
    musdCategory: z.string().optional(),
    quotingEnabled: z.coerce.boolean().default(true),
    spreadBps: z.coerce.number().default(40),
    fixedFeeUsdMicros: z.coerce.bigint().default(50000n), // $0.05
    minSwapUsdMicros: z.coerce.bigint().default(1000000n), // $1.00
    maxSwapUsdMicros: z.coerce.bigint().default(50000000n), // $50.00
    maxExposureUsdMicros: z.coerce.bigint().default(250000000n), // $250.00
    zeroConfMaxUsdMicros: z.coerce.bigint().default(25000000n), // $25.00
    quoteTtlSeconds: z.coerce.number().default(60),
    pegTolerance: z.coerce.number().default(0.01),
    evmConfs: z.coerce.number().default(10),
    dsproofWindowMs: z.coerce.number().default(5000),
    fwdBchRefundBlocks: z.coerce.number().default(36),
    fwdEvmDeadlineSeconds: z.coerce.number().default(86400),
    revBchRefundBlocks: z.coerce.number().default(144),
    revEvmDeadlineSeconds: z.coerce.number().default(21600),
    revMinRemainingBlocks: z.coerce.number().default(108),
    bchCarrySats: z.coerce.bigint().default(3000n),
    bchMaxFeeSats: z.coerce.bigint().default(1500n),
    skewMaxBps: z.coerce.number().default(50),
    tipMaxAgeBchSeconds: z.coerce.number().default(7200),
    tipMaxAgeBaseSeconds: z.coerce.number().default(60),
    allowMockPaylinkSignatures: z.coerce.boolean().default(false),
    trustedProxy: z.coerce.boolean().default(false),
    quoteRateLimitWindowMs: z.coerce.number().default(60_000),
    quoteRateLimitMaxPerAddress: z.coerce.number().default(30),
    quoteRateLimitMaxPerIp: z.coerce.number().default(60),
    quoteRateLimitMaxEntries: z.coerce.number().default(10_000),
    quoteRateLimitPruneIntervalMs: z.coerce.number().default(60_000),
    maxUnfundedQuotesPerAddress: z.coerce.number().default(10),
    maxGlobalUnfundedQuotes: z.coerce.number().default(500),
    operatorToken: z.string().min(32).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.network === 'mainnet') {
      if (!data.operatorToken || data.operatorToken.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'OPERATOR_TOKEN with at least 32 characters is required on mainnet. Refusing to start.',
          path: ['operatorToken'],
        });
      }
    }
  });

export type SolverConfig = z.infer<typeof SolverConfigSchema>;

export function loadConfigFromEnv(
  env: Record<string, string | undefined>,
): SolverConfig {
  const network = (env.NETWORK || 'testnet').toLowerCase() as
    'testnet' | 'mainnet';
  const isMainnet = network === 'mainnet';

  const bchElectrumUrls = isMainnet
    ? env.BCH_ELECTRUM_URLS
    : env.BCH_CHIPNET_ELECTRUM_URLS || env.BCH_ELECTRUM_URLS;

  const baseRpcUrl = isMainnet
    ? env.BASE_RPC_URL
    : env.BASE_SEPOLIA_RPC_URL || env.BASE_RPC_URL;

  const baseChainId = isMainnet
    ? env.BASE_CHAIN_ID
      ? Number(env.BASE_CHAIN_ID)
      : 8453
    : env.BASE_SEPOLIA_CHAIN_ID
      ? Number(env.BASE_SEPOLIA_CHAIN_ID)
      : env.BASE_CHAIN_ID
        ? Number(env.BASE_CHAIN_ID)
        : 84532;

  const baseHtlcAddress = isMainnet
    ? env.FERRY_HTLC_ADDRESS || env.BASE_FERRY_HTLC_ADDRESS
    : env.BASE_SEPOLIA_FERRY_HTLC_ADDRESS ||
      env.FERRY_HTLC_ADDRESS ||
      env.BASE_FERRY_HTLC_ADDRESS;

  const baseUsdcAddress = isMainnet
    ? env.USDC_ADDRESS || env.BASE_USDC_ADDRESS
    : env.BASE_SEPOLIA_USDC_ADDRESS ||
      env.USDC_ADDRESS ||
      env.BASE_USDC_ADDRESS;

  const rawSolverKey = env.SOLVER_EVM_PRIVATE_KEY;
  const allowDevKeys =
    env.ALLOW_DEV_KEYS === '1' ||
    env.ALLOW_DEV_KEYS === 'true' ||
    env.FERRY_ALLOW_DEV_KEYS === '1';

  const allowMockPaylinkSignatures =
    env.ALLOW_MOCK_PAYLINK_SIGNATURES === '1' ||
    env.ALLOW_MOCK_PAYLINK_SIGNATURES === 'true';

  if (isMainnet && allowMockPaylinkSignatures) {
    throw new Error(
      'ALLOW_MOCK_PAYLINK_SIGNATURES is not permitted on mainnet; real BCH signed messages required',
    );
  }

  let solverEvmPrivateKey: string;
  if (!rawSolverKey) {
    if (isMainnet) {
      throw new Error(
        'SOLVER_EVM_PRIVATE_KEY is required on mainnet. Refusing to start.',
      );
    }
    if (!allowDevKeys) {
      throw new Error(
        'SOLVER_EVM_PRIVATE_KEY is not set. Refusing to fall back to default dev key on testnet without explicit ALLOW_DEV_KEYS=1 (specify keys via --env-file=.env.local).',
      );
    }
    solverEvmPrivateKey = DEFAULT_DEV_EVM_PRIVATE_KEY;
  } else {
    if (
      isMainnet &&
      rawSolverKey.toLowerCase() === DEFAULT_DEV_EVM_PRIVATE_KEY.toLowerCase()
    ) {
      throw new Error(
        'Default dev private key cannot be used on mainnet. Refusing to start.',
      );
    }
    solverEvmPrivateKey = rawSolverKey;
  }

  return SolverConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    dbPath: env.DATABASE_PATH || env.DATABASE_URL,
    network,
    bchElectrumUrls: bchElectrumUrls || undefined,
    baseRpcUrl: baseRpcUrl || undefined,
    baseChainId: baseChainId || undefined,
    baseHtlcAddress: baseHtlcAddress || undefined,
    baseUsdcAddress: baseUsdcAddress || undefined,
    solverEvmPrivateKey,
    solverBchWif: env.SOLVER_BCH_WIF || undefined,
    userBchWif: env.USER_BCH_WIF || undefined,
    userEvmPrivateKey: env.USER_EVM_PRIVATE_KEY || undefined,
    tpusdCategory: env.TPUSD_CATEGORY || undefined,
    tmusdCategory: env.TMUSD_CATEGORY || undefined,
    pusdCategory: env.PUSD_CATEGORY || undefined,
    musdCategory: env.MUSD_CATEGORY || undefined,
    quotingEnabled:
      env.QUOTING_ENABLED !== undefined
        ? env.QUOTING_ENABLED === 'true'
        : undefined,
    spreadBps: env.SPREAD_BPS,
    fixedFeeUsdMicros: env.FIXED_FEE_USD
      ? BigInt(Math.round(parseFloat(env.FIXED_FEE_USD) * 1e6))
      : undefined,
    minSwapUsdMicros: env.MIN_SWAP_USD
      ? BigInt(Math.round(parseFloat(env.MIN_SWAP_USD) * 1e6))
      : undefined,
    maxSwapUsdMicros: env.MAX_SWAP_USD
      ? BigInt(Math.round(parseFloat(env.MAX_SWAP_USD) * 1e6))
      : undefined,
    maxExposureUsdMicros: env.MAX_OPEN_EXPOSURE_USD
      ? BigInt(Math.round(parseFloat(env.MAX_OPEN_EXPOSURE_USD) * 1e6))
      : undefined,
    zeroConfMaxUsdMicros: env.ZERO_CONF_MAX_USD
      ? BigInt(Math.round(parseFloat(env.ZERO_CONF_MAX_USD) * 1e6))
      : undefined,
    quoteTtlSeconds: env.QUOTE_TTL_S,
    pegTolerance: env.PEG_TOLERANCE ? parseFloat(env.PEG_TOLERANCE) : undefined,
    evmConfs: env.EVM_CONFS,
    dsproofWindowMs: env.DSPROOF_WINDOW_MS,
    fwdBchRefundBlocks: env.FWD_BCH_REFUND_BLOCKS,
    fwdEvmDeadlineSeconds: env.FWD_EVM_DEADLINE_S,
    revBchRefundBlocks: env.REV_BCH_REFUND_BLOCKS,
    revEvmDeadlineSeconds: env.REV_EVM_DEADLINE_S,
    revMinRemainingBlocks: env.REV_MIN_REMAINING_BLOCKS,
    bchCarrySats: env.BCH_CARRY_SATS ? BigInt(env.BCH_CARRY_SATS) : undefined,
    bchMaxFeeSats: env.BCH_MAX_FEE_SATS
      ? BigInt(env.BCH_MAX_FEE_SATS)
      : undefined,
    skewMaxBps: env.SKEW_MAX_BPS,
    tipMaxAgeBchSeconds: env.TIP_MAX_AGE_BCH_SECONDS,
    tipMaxAgeBaseSeconds: env.TIP_MAX_AGE_BASE_SECONDS,
    allowMockPaylinkSignatures,
    trustedProxy:
      env.TRUSTED_PROXY === '1' || env.TRUSTED_PROXY === 'true'
        ? true
        : undefined,
    quoteRateLimitWindowMs: env.QUOTE_RATE_LIMIT_WINDOW_MS
      ? Number(env.QUOTE_RATE_LIMIT_WINDOW_MS)
      : undefined,
    quoteRateLimitMaxPerAddress: env.QUOTE_RATE_LIMIT_MAX_PER_ADDRESS
      ? Number(env.QUOTE_RATE_LIMIT_MAX_PER_ADDRESS)
      : undefined,
    quoteRateLimitMaxPerIp: env.QUOTE_RATE_LIMIT_MAX_PER_IP
      ? Number(env.QUOTE_RATE_LIMIT_MAX_PER_IP)
      : undefined,
    quoteRateLimitMaxEntries: env.QUOTE_RATE_LIMIT_MAX_ENTRIES
      ? Number(env.QUOTE_RATE_LIMIT_MAX_ENTRIES)
      : undefined,
    quoteRateLimitPruneIntervalMs: env.QUOTE_RATE_LIMIT_PRUNE_INTERVAL_MS
      ? Number(env.QUOTE_RATE_LIMIT_PRUNE_INTERVAL_MS)
      : undefined,
    maxUnfundedQuotesPerAddress: env.MAX_UNFUNDED_QUOTES_PER_ADDRESS
      ? Number(env.MAX_UNFUNDED_QUOTES_PER_ADDRESS)
      : undefined,
    maxGlobalUnfundedQuotes: env.MAX_GLOBAL_UNFUNDED_QUOTES
      ? Number(env.MAX_GLOBAL_UNFUNDED_QUOTES)
      : undefined,
    operatorToken: env.OPERATOR_TOKEN ? env.OPERATOR_TOKEN.trim() : undefined,
  });
}

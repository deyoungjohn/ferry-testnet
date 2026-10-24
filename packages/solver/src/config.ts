import { z } from 'zod';

export const SolverConfigSchema = z.object({
  port: z.coerce.number().default(8787),
  host: z.string().default('127.0.0.1'),
  dbPath: z.string().default(':memory:'),
  bchElectrumUrls: z
    .string()
    .default(
      'wss://chipnet.imaginary.cash:50004,wss://blackie.c3-soft.com:50004',
    ),
  baseRpcUrl: z.string().default('http://127.0.0.1:8546'),
  baseChainId: z.coerce.number().default(31337),
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
    .default(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ),
  solverBchWif: z.string().optional(),
  tpusdCategory: z
    .string()
    .default(
      '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
    ),
  tmusdCategory: z
    .string()
    .default(
      '0xc99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d',
    ),
  spreadBps: z.coerce.number().default(50),
  fixedFeeUsdMicros: z.coerce.bigint().default(100000n), // $0.10
  minSwapUsdMicros: z.coerce.bigint().default(5000000n), // $5.00
  maxSwapUsdMicros: z.coerce.bigint().default(250000000n), // $250.00
  maxExposureUsdMicros: z.coerce.bigint().default(1000000000n), // $1000.00
  tipMaxAgeBchSeconds: z.coerce.number().default(7200),
  tipMaxAgeBaseSeconds: z.coerce.number().default(60),
});

export type SolverConfig = z.infer<typeof SolverConfigSchema>;

export function loadConfigFromEnv(
  env: Record<string, string | undefined>,
): SolverConfig {
  return SolverConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    dbPath: env.DATABASE_PATH || env.DATABASE_URL,
    bchElectrumUrls: env.BCH_ELECTRUM_URLS,
    baseRpcUrl: env.BASE_RPC_URL,
    baseChainId: env.BASE_CHAIN_ID,
    baseHtlcAddress: env.BASE_FERRY_HTLC_ADDRESS,
    baseUsdcAddress: env.BASE_USDC_ADDRESS,
    solverEvmPrivateKey: env.SOLVER_EVM_PRIVATE_KEY,
    solverBchWif: env.SOLVER_BCH_WIF,
    tpusdCategory: env.TPUSD_CATEGORY,
    tmusdCategory: env.TMUSD_CATEGORY,
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
    tipMaxAgeBchSeconds: env.TIP_MAX_AGE_BCH_SECONDS,
    tipMaxAgeBaseSeconds: env.TIP_MAX_AGE_BASE_SECONDS,
  });
}

import { z } from 'zod';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const wireBigInt = z
  .union([
    z.bigint(),
    z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/, 'Expected unsigned base-10 integer'),
  ])
  .transform((value) => (typeof value === 'bigint' ? value : BigInt(value)));
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const bchTxId = z.string().regex(/^[0-9a-fA-F]{64}$/);

export const QuotePolicySchema = z.strictObject({
  spreadBps: uint,
  fixedFeeUsdMicros: wireBigInt,
});
export type QuotePolicy = z.infer<typeof QuotePolicySchema>;

export const StatsSummarySchema = z.strictObject({
  completedSwaps: uint.nullable(),
  volumeUsdMicros: wireBigInt.nullable(),
  medianFastSeconds: uint.nullable(),
  quotePolicy: QuotePolicySchema.nullable(),
  asOf: uint.nullable(),
});
export type StatsSummary = z.infer<typeof StatsSummarySchema>;

export const RecentSwapSchema = z.strictObject({
  orderId: hex32,
  settledAt: uint,
  direction: z.enum(['COUNTER_TO_BCH', 'BCH_TO_COUNTER']),
  counterSymbol: z.string().min(1).max(12),
  counterDecimals: z.number().int().min(0).max(18),
  counterAmount: wireBigInt,
  bchSymbol: z.string().min(1).max(12),
  bchDecimals: z.number().int().min(0).max(18),
  bchTokenAmount: wireBigInt,
  durationSeconds: uint,
  baseTxId: hex32,
  bchTxId,
});
export type RecentSwap = z.infer<typeof RecentSwapSchema>;

export const RecentSwapsResponseSchema = z.strictObject({
  swaps: z.array(RecentSwapSchema),
});

export const PegPointSchema = z.strictObject({
  at: uint,
  priceUsdMicros: wireBigInt.refine(
    (value) => value > 0n,
    'Peg price must be positive',
  ),
});
export type PegPoint = z.infer<typeof PegPointSchema>;

export const PegSnapshotSchema = z.strictObject({
  token: z.enum(['PUSD', 'MUSD']),
  priceUsdMicros: wireBigInt
    .refine((value) => value > 0n, 'Peg price must be positive')
    .nullable(),
  points: z.array(PegPointSchema).max(1_440),
  source: z.string().min(1).nullable(),
  asOf: uint.nullable(),
});
export type PegSnapshot = z.infer<typeof PegSnapshotSchema>;
export type PegToken = PegSnapshot['token'];

export const PegsResponseSchema = z.strictObject({
  pegs: z.array(PegSnapshotSchema),
});

export interface StatsClient {
  getStats(): Promise<StatsSummary>;
  getRecentSwaps(): Promise<readonly RecentSwap[]>;
  getPegs(): Promise<readonly PegSnapshot[]>;
}

export type DataResource<T> =
  | { readonly status: 'loading'; readonly data: null }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly data: null };

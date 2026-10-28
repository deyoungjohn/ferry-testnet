import { z } from 'zod';
import {
  COUNTER_CHAINS,
  OrderTermsSchema,
  orderId as computeOrderId,
  unixTimestampSeconds,
} from '../terms.js';
import type { CounterChain, Hex, OrderTerms } from '../terms.js';

export { unixTimestampSeconds };

const wellFormed = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
const text = z.string().min(1).max(256).refine(wellFormed, 'Invalid Unicode');
const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .max(20002)
  .transform((value) => value.toLowerCase() as Hex);
const hex32 = hex.refine(
  (value) => value.length === 66,
  'Expected exactly 32 bytes',
);
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const evmAddress = z
  .string()
  .regex(evmAddressPattern, 'Malformed EVM address')
  .transform((value) => value.toLowerCase() as Hex);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uint8 = z.number().int().min(0).max(255);
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

const wireBigInt = z
  .union([
    z.bigint(),
    z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/, 'Expected unsigned base-10 integer'),
  ])
  .transform((value) => (typeof value === 'bigint' ? value : BigInt(value)));

const nonNegativeUint256 = wireBigInt.refine(
  (value) => value >= 0n && value <= MAX_UINT256,
  'Expected uint256',
);
const positiveUint256 = nonNegativeUint256.refine(
  (value) => value > 0n,
  'Expected positive uint256',
);
const positiveUint64 = wireBigInt.refine(
  (value) => value > 0n && value <= MAX_UINT64,
  'Expected positive uint64',
);

function validChainAddress(chain: CounterChain, value: string): boolean {
  if (chain === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  if (chain === 'tron') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
  return evmAddressPattern.test(value);
}

function normalizeChainAddress(chain: CounterChain, value: string): string {
  return chain === 'solana' || chain === 'tron' ? value : value.toLowerCase();
}

export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'INVALID_SIGNATURE',
  'TERMS_MISMATCH',
  'AMOUNT_OUT_OF_RANGE',
  'UNSUPPORTED_ROUTE',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'ORDER_NOT_FOUND',
  'LINK_NOT_FOUND',
  'CONFLICT',
  'LINK_RESERVED',
  'LINK_CLOSED',
  'INVALID_ORDER_STATE',
  'QUOTE_EXPIRED',
  'LINK_EXPIRED',
  'REVEAL_NOT_READY',
  'TIMING_INVARIANT_FAILED',
  'RATE_LIMITED',
  'QUOTING_DISABLED',
  'PEG_DEVIATION',
  'STALE_CHAIN_TIP',
  'BCH_TIP_UNHEALTHY',
  'EVM_TIP_UNHEALTHY',
  'INSUFFICIENT_INVENTORY',
  'EXPOSURE_LIMIT_EXCEEDED',
  'UPSTREAM_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> =
  Object.freeze({
    BAD_REQUEST: 400,
    VALIDATION_ERROR: 400,
    INVALID_SIGNATURE: 400,
    TERMS_MISMATCH: 400,
    AMOUNT_OUT_OF_RANGE: 400,
    UNSUPPORTED_ROUTE: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    ORDER_NOT_FOUND: 404,
    LINK_NOT_FOUND: 404,
    CONFLICT: 409,
    LINK_RESERVED: 409,
    LINK_CLOSED: 409,
    INVALID_ORDER_STATE: 409,
    QUOTE_EXPIRED: 410,
    LINK_EXPIRED: 410,
    REVEAL_NOT_READY: 422,
    TIMING_INVARIANT_FAILED: 422,
    RATE_LIMITED: 429,
    QUOTING_DISABLED: 503,
    PEG_DEVIATION: 503,
    STALE_CHAIN_TIP: 503,
    BCH_TIP_UNHEALTHY: 503,
    EVM_TIP_UNHEALTHY: 503,
    INSUFFICIENT_INVENTORY: 503,
    EXPOSURE_LIMIT_EXCEEDED: 503,
    UPSTREAM_ERROR: 502,
    INTERNAL_ERROR: 500,
  });

export function apiErrorStatus(code: ApiErrorCode): number {
  return API_ERROR_HTTP_STATUS[code];
}

export const ApiErrorResponseSchema = z.strictObject({
  code: ApiErrorCodeSchema,
  message: text,
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const ORDER_STATUSES = [
  'QUOTED',
  'USER_LOCK_SEEN',
  'USER_LOCK_FINAL',
  'SOLVER_LOCK_BROADCAST',
  'SOLVER_LOCK_SEEN',
  'SECRET_KNOWN',
  'USER_CLAIM_SEEN',
  'SOLVER_CLAIM_BROADCAST',
  'SOLVER_CLAIM_FINAL',
  'DONE',
  'EXPIRED',
  'REJECTED',
  'SOLVER_REFUND_BROADCAST',
  'SOLVER_REFUNDED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export const TERMINAL_ORDER_STATUSES = [
  'DONE',
  'EXPIRED',
  'REJECTED',
  'SOLVER_REFUNDED',
] as const;

export type TerminalOrderStatus = (typeof TERMINAL_ORDER_STATUSES)[number];

export function isTerminalOrderStatus(
  status: OrderStatus,
): status is TerminalOrderStatus {
  return (TERMINAL_ORDER_STATUSES as readonly string[]).includes(status);
}

export const LaneSchema = z.enum(['fast', 'safe']);

function coerceTermsBigInts(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = { ...(input as Record<string, unknown>) };
  for (const field of [
    'bchTokenAmount',
    'counterAmount',
    'bchCarrySats',
    'bchMaxFee',
  ]) {
    const raw = record[field];
    if (typeof raw === 'string' && /^(?:0|[1-9][0-9]*)$/.test(raw)) {
      record[field] = BigInt(raw);
    }
  }
  return record;
}

export const ApiOrderTermsSchema: z.ZodType<OrderTerms> = z.preprocess(
  coerceTermsBigInts,
  OrderTermsSchema,
);

export const QuoteRequestSchema = z
  .strictObject({
    direction: z.enum(['COUNTER_TO_BCH', 'BCH_TO_COUNTER']),
    bchToken: z.enum(['PUSD', 'MUSD']),
    counterChain: z.enum(COUNTER_CHAINS),
    counterSymbol: z.enum(['USDC', 'USDT']),
    amountIn: positiveUint256,
    userCounterAddress: text,
    userBchLockingBytecode: hex,
    hashLock: hex32,
    lane: LaneSchema,
    fastOptIn: z.boolean().optional(),
  })
  .superRefine((req, ctx) => {
    if (!validChainAddress(req.counterChain, req.userCounterAddress)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Malformed counter-chain address',
        path: ['userCounterAddress'],
      });
    }
    if (req.lane === 'fast' && req.fastOptIn === false) {
      ctx.addIssue({
        code: 'custom',
        message: 'Fast lane requires explicit opt-in',
        path: ['fastOptIn'],
      });
    }
  })
  .transform((req) => ({
    ...req,
    userCounterAddress: normalizeChainAddress(
      req.counterChain,
      req.userCounterAddress,
    ),
  }));
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteResponseSchema = z
  .strictObject({
    orderId: hex32,
    terms: ApiOrderTermsSchema,
    lane: LaneSchema,
    signature: hex,
    signerAddress: evmAddress,
  })
  .superRefine((res, ctx) => {
    if (computeOrderId(res.terms) !== res.orderId) {
      ctx.addIssue({
        code: 'custom',
        message: 'orderId does not match canonical OrderTerms',
        path: ['orderId'],
      });
    }
  });
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export const OrderParamsSchema = z.strictObject({
  orderId: hex32,
});
export type OrderParams = z.infer<typeof OrderParamsSchema>;

export const OrderTxIdsSchema = z.strictObject({
  userLockTxId: text.optional(),
  solverLockTxId: text.optional(),
  userClaimTxId: text.optional(),
  solverClaimTxId: text.optional(),
  solverRefundTxId: text.optional(),
});
export type OrderTxIds = z.infer<typeof OrderTxIdsSchema>;

export const OrderDeadlinesSchema = z.strictObject({
  quoteExpiry: unixTimestampSeconds,
  counterDeadline: unixTimestampSeconds,
  bchRefundHeight: uint.positive().max(499999999),
});
export type OrderDeadlines = z.infer<typeof OrderDeadlinesSchema>;

export const BchLockUtxoSchema = z.strictObject({
  txid: text,
  vout: uint,
  satoshis: positiveUint64,
});
export type BchLockUtxo = z.infer<typeof BchLockUtxoSchema>;

export const OrderStatusResponseSchema = z
  .strictObject({
    orderId: hex32,
    status: OrderStatusSchema,
    lane: LaneSchema,
    terms: ApiOrderTermsSchema,
    signature: hex,
    signerAddress: evmAddress,
    txIds: OrderTxIdsSchema,
    bchLock: BchLockUtxoSchema.optional(),
    secret: hex32.optional(),
    deadlines: OrderDeadlinesSchema,
    rejectionReason: text.optional(),
    updatedAt: unixTimestampSeconds,
  })
  .superRefine((res, ctx) => {
    if (computeOrderId(res.terms) !== res.orderId) {
      ctx.addIssue({
        code: 'custom',
        message: 'orderId does not match canonical OrderTerms',
        path: ['orderId'],
      });
    }
    if (
      res.deadlines.quoteExpiry !== res.terms.quoteExpiry ||
      res.deadlines.counterDeadline !== res.terms.counterDeadline ||
      res.deadlines.bchRefundHeight !== res.terms.bchRefundHeight
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'deadlines do not match terms',
        path: ['deadlines'],
      });
    }
  });
export type OrderStatusResponse = z.infer<typeof OrderStatusResponseSchema>;

export const RevealSecretRequestSchema = z.strictObject({
  secret: hex32,
});
export type RevealSecretRequest = z.infer<typeof RevealSecretRequestSchema>;

export const RevealSecretResponseSchema = z.strictObject({
  orderId: hex32,
  status: OrderStatusSchema,
  accepted: z.literal(true),
});
export type RevealSecretResponse = z.infer<typeof RevealSecretResponseSchema>;

export const LOCK_WITH_INTENT_PARAM_NAMES = [
  'owner',
  'token',
  'recipient',
  'amount',
  'hashLock',
  'deadline',
  'intentDeadline',
  'intentSig',
  'permitDeadline',
  'v',
  'r',
  's',
] as const;

export const RelayLockRequestSchema = z.strictObject({
  owner: evmAddress,
  token: evmAddress,
  recipient: evmAddress,
  amount: positiveUint256,
  hashLock: hex32,
  deadline: positiveUint64,
  intentDeadline: positiveUint256,
  intentSig: hex,
  permitDeadline: nonNegativeUint256,
  v: uint8,
  r: hex32,
  s: hex32,
});
export type RelayLockRequest = z.infer<typeof RelayLockRequestSchema>;

export const TxRefSchema = z.strictObject({
  chain: z.enum(COUNTER_CHAINS),
  txId: text,
});

export const RelayLockResponseSchema = z.strictObject({
  orderId: hex32,
  status: OrderStatusSchema,
  tx: TxRefSchema,
});
export type RelayLockResponse = z.infer<typeof RelayLockResponseSchema>;

export const RelayClaimRequestSchema = z.strictObject({
  lockId: text.optional(),
  secret: hex32,
});
export type RelayClaimRequest = z.infer<typeof RelayClaimRequestSchema>;

export const RelayClaimResponseSchema = RelayLockResponseSchema;
export type RelayClaimResponse = z.infer<typeof RelayClaimResponseSchema>;

export const ChainTipStatusSchema = z.strictObject({
  height: uint,
  ageSeconds: z.number().nonnegative(),
  stale: z.boolean(),
});
export type ChainTipStatus = z.infer<typeof ChainTipStatusSchema>;

export const BchTipStatusSchema = z.strictObject({
  height: uint,
  ageSeconds: z.number().nonnegative(),
  stale: z.boolean(),
  quorum: z.boolean(),
});
export type BchTipStatus = z.infer<typeof BchTipStatusSchema>;

export const InventoryItemSchema = z.strictObject({
  chain: z.union([z.literal('bch'), z.enum(COUNTER_CHAINS)]),
  symbol: z.enum(['BCH', 'PUSD', 'MUSD', 'USDC', 'USDT']),
  decimals: uint.max(36),
  balance: nonNegativeUint256,
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const HealthResponseSchema = z.strictObject({
  ok: z.boolean(),
  quotingEnabled: z.boolean(),
  quoting: z.boolean(),
  bchTip: BchTipStatusSchema,
  counterTips: z.partialRecord(z.enum(COUNTER_CHAINS), ChainTipStatusSchema),
  inventory: z.array(InventoryItemSchema),
  timestamp: unixTimestampSeconds,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const base58Id = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{16,32}$/, 'Expected base58 link id');
const memoText = z
  .string()
  .min(1)
  .max(140)
  .refine(wellFormed, 'Invalid Unicode');

export const PayLinkKindSchema = z.enum(['invoice', 'open']);
export type PayLinkKind = z.infer<typeof PayLinkKindSchema>;

export const PayLinkStatusSchema = z.enum([
  'open',
  'reserved',
  'paid',
  'expired',
  'cancelled',
]);
export type PayLinkStatus = z.infer<typeof PayLinkStatusSchema>;

function validateLinkAmounts(
  link: {
    kind: PayLinkKind;
    amountOut?: bigint | undefined;
    minAmountOut?: bigint | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (link.kind === 'invoice') {
    if (link.amountOut === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invoice links require amountOut',
        path: ['amountOut'],
      });
    }
    if (link.minAmountOut !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invoice links cannot specify minAmountOut',
        path: ['minAmountOut'],
      });
    }
  } else if (link.amountOut !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Open links cannot fix amountOut',
      path: ['amountOut'],
    });
  }
}

export const PayLinkSchema = z
  .strictObject({
    id: base58Id,
    kind: PayLinkKindSchema,
    recipientCashaddr: text,
    recipientLockingBytecode: hex,
    token: z.enum(['PUSD', 'MUSD']),
    amountOut: positiveUint256.optional(),
    minAmountOut: positiveUint256.optional(),
    memo: memoText.optional(),
    reference: text.optional(),
    expiresAt: unixTimestampSeconds.optional(),
    verified: z.boolean(),
    status: PayLinkStatusSchema,
    createdAt: unixTimestampSeconds,
    orderId: hex32.optional(),
  })
  .superRefine(validateLinkAmounts);
export type PayLink = z.infer<typeof PayLinkSchema>;

export const PayLinkParamsSchema = z.strictObject({
  id: base58Id,
});
export type PayLinkParams = z.infer<typeof PayLinkParamsSchema>;

export const CreatePayLinkRequestSchema = z
  .strictObject({
    kind: PayLinkKindSchema,
    recipientCashaddr: text,
    recipientLockingBytecode: hex,
    token: z.enum(['PUSD', 'MUSD']),
    amountOut: positiveUint256.optional(),
    minAmountOut: positiveUint256.optional(),
    memo: memoText.optional(),
    reference: text.optional(),
    expiresAt: unixTimestampSeconds.optional(),
    verification: z
      .strictObject({
        challenge: text,
        signature: text,
      })
      .optional(),
  })
  .superRefine(validateLinkAmounts);
export type CreatePayLinkRequest = z.infer<typeof CreatePayLinkRequestSchema>;

export const CreatePayLinkResponseSchema = PayLinkSchema;
export type CreatePayLinkResponse = z.infer<typeof CreatePayLinkResponseSchema>;

export const GetPayLinkResponseSchema = PayLinkSchema;
export type GetPayLinkResponse = z.infer<typeof GetPayLinkResponseSchema>;

export const PayLinkQuoteRequestSchema = z
  .strictObject({
    counterChain: z.enum(COUNTER_CHAINS),
    counterSymbol: z.enum(['USDC', 'USDT']),
    userCounterAddress: text,
    hashLock: hex32,
    lane: LaneSchema,
    fastOptIn: z.boolean().optional(),
    amountOut: positiveUint256.optional(),
  })
  .superRefine((req, ctx) => {
    if (!validChainAddress(req.counterChain, req.userCounterAddress)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Malformed counter-chain address',
        path: ['userCounterAddress'],
      });
    }
    if (req.lane === 'fast' && req.fastOptIn === false) {
      ctx.addIssue({
        code: 'custom',
        message: 'Fast lane requires explicit opt-in',
        path: ['fastOptIn'],
      });
    }
  })
  .transform((req) => ({
    ...req,
    userCounterAddress: normalizeChainAddress(
      req.counterChain,
      req.userCounterAddress,
    ),
  }));
export type PayLinkQuoteRequest = z.infer<typeof PayLinkQuoteRequestSchema>;

export const PayLinkQuoteResponseSchema = QuoteResponseSchema;
export type PayLinkQuoteResponse = z.infer<typeof PayLinkQuoteResponseSchema>;

export const ListPayLinksQuerySchema = z.strictObject({
  owner: text,
  challenge: text,
  sig: text,
});
export type ListPayLinksQuery = z.infer<typeof ListPayLinksQuerySchema>;

export const ListPayLinksResponseSchema = z.strictObject({
  links: z.array(PayLinkSchema),
});
export type ListPayLinksResponse = z.infer<typeof ListPayLinksResponseSchema>;

export const CancelPayLinkRequestSchema = z.strictObject({
  owner: text,
  challenge: text,
  sig: text,
});
export type CancelPayLinkRequest = z.infer<typeof CancelPayLinkRequestSchema>;

export const CancelPayLinkResponseSchema = PayLinkSchema;
export type CancelPayLinkResponse = z.infer<typeof CancelPayLinkResponseSchema>;

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
  asOf: unixTimestampSeconds.nullable(),
});
export type StatsSummary = z.infer<typeof StatsSummarySchema>;

export const RecentSwapSchema = z.strictObject({
  orderId: hex32,
  settledAt: unixTimestampSeconds,
  direction: z.enum(['COUNTER_TO_BCH', 'BCH_TO_COUNTER']),
  counterSymbol: z.string().min(1).max(12),
  counterDecimals: z.number().int().min(0).max(18),
  counterAmount: wireBigInt,
  bchSymbol: z.string().min(1).max(12),
  bchDecimals: z.number().int().min(0).max(18),
  bchTokenAmount: wireBigInt,
  durationSeconds: uint,
  baseTxId: hex32,
  bchTxId: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'Expected 64-character hex txid'),
});
export type RecentSwap = z.infer<typeof RecentSwapSchema>;

export const RecentSwapsResponseSchema = z.strictObject({
  swaps: z.array(RecentSwapSchema),
});
export type RecentSwapsResponse = z.infer<typeof RecentSwapsResponseSchema>;

export const PegPointSchema = z.strictObject({
  at: unixTimestampSeconds,
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
  asOf: unixTimestampSeconds.nullable(),
});
export type PegSnapshot = z.infer<typeof PegSnapshotSchema>;
export type PegToken = PegSnapshot['token'];

export const PegsResponseSchema = z.strictObject({
  pegs: z.array(PegSnapshotSchema),
});
export type PegsResponse = z.infer<typeof PegsResponseSchema>;

/** Convert in-memory API values (including bigint fields) to JSON wire text. */
export function serializeApiJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    typeof field === 'bigint' ? field.toString(10) : field,
  );
}

/** Parse JSON wire text and validate against a schema, restoring bigint fields. */
export function parseApiJson<T>(schema: z.ZodType<T>, json: string): T {
  return schema.parse(JSON.parse(json));
}

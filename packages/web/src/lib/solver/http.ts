import {
  ApiErrorResponseSchema,
  OrderStatusResponseSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  RelayClaimResponseSchema,
  RelayLockResponseSchema,
  RevealSecretResponseSchema,
  serializeApiJson,
  type Hex32,
  type OrderStatus,
  type QuoteRequest,
} from '@ferry/core';
import type { z } from 'zod';
import { FWD_BCH_REFUND_BLOCKS, REV_BCH_REFUND_BLOCKS } from '../config';
import type {
  OrderTransaction,
  OrderView,
  RelayLockRequest,
  SignedQuote,
  SolverClient,
} from './types';

function splitPermitSignature(signature: `0x${string}`): {
  v: number;
  r: Hex32;
  s: Hex32;
} {
  const body = signature.slice(2);
  if (!/^[0-9a-fA-F]{130}$/.test(body)) {
    throw new Error('Permit signature must be 65 bytes');
  }
  return {
    r: `0x${body.slice(0, 64)}` as Hex32,
    s: `0x${body.slice(64, 128)}` as Hex32,
    v: Number.parseInt(body.slice(128, 130), 16),
  };
}

function txList(input: {
  userLockTxId?: string | undefined;
  solverLockTxId?: string | undefined;
  userClaimTxId?: string | undefined;
  solverClaimTxId?: string | undefined;
  solverRefundTxId?: string | undefined;
}): OrderTransaction[] {
  const out: OrderTransaction[] = [];
  if (input.userLockTxId) {
    out.push({ label: 'Base lock', chain: 'base', hash: input.userLockTxId });
  }
  if (input.solverLockTxId) {
    out.push({ label: 'BCH lock', chain: 'bch', hash: input.solverLockTxId });
  }
  if (input.userClaimTxId) {
    out.push({ label: 'BCH claim', chain: 'bch', hash: input.userClaimTxId });
  }
  if (input.solverClaimTxId) {
    out.push({
      label: 'Base claim',
      chain: 'base',
      hash: input.solverClaimTxId,
    });
  }
  if (input.solverRefundTxId) {
    out.push({
      label: 'Base refund',
      chain: 'base',
      hash: input.solverRefundTxId,
    });
  }
  return out;
}

function claimAvailable(status: OrderStatus): boolean {
  return status === 'SOLVER_LOCK_SEEN';
}

function refundAvailable(status: OrderStatus): boolean {
  return status === 'REJECTED';
}

export class HttpSolverClient implements SolverClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async #json<T>(
    schema: z.ZodType<T>,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(body);
      throw new Error(
        parsed.success
          ? `${parsed.data.code}: ${parsed.data.message}`
          : `Solver request failed (${response.status})`,
      );
    }
    return schema.parse(body);
  }

  async quote(request: QuoteRequest): Promise<SignedQuote> {
    const parsed = QuoteRequestSchema.parse(request);
    const response = await this.#json(QuoteResponseSchema, '/v1/quotes', {
      method: 'POST',
      body: serializeApiJson(parsed),
    });
    return {
      ...response,
      bchTipHeight:
        response.terms.bchRefundHeight -
        (response.terms.direction === 'BCH_TO_COUNTER'
          ? REV_BCH_REFUND_BLOCKS
          : FWD_BCH_REFUND_BLOCKS),
    };
  }

  async relayLock(request: RelayLockRequest): Promise<{ txHash: string }> {
    const permit = splitPermitSignature(request.permitSignature);
    const response = await this.#json(
      RelayLockResponseSchema,
      `/v1/orders/${request.orderId}/relay-lock`,
      {
        method: 'POST',
        body: serializeApiJson({
          owner: request.userEvmAddress,
          token: request.terms.counterAsset.address,
          recipient: request.terms.solverCounterAddress,
          amount: request.terms.counterAmount,
          hashLock: request.terms.hashLock,
          deadline: BigInt(request.terms.counterDeadline),
          intentDeadline: BigInt(request.terms.quoteExpiry),
          intentSig: request.intentSignature,
          permitDeadline: BigInt(request.permitDeadline),
          ...permit,
        }),
      },
    );
    return { txHash: response.tx.txId };
  }

  async getOrder(orderId: Hex32): Promise<OrderView> {
    const response = await this.#json(
      OrderStatusResponseSchema,
      `/v1/orders/${orderId}`,
    );
    return {
      orderId: response.orderId,
      status: response.status,
      terms: response.terms,
      lane: response.lane,
      bchTipHeight:
        response.terms.bchRefundHeight -
        (response.terms.direction === 'BCH_TO_COUNTER'
          ? REV_BCH_REFUND_BLOCKS
          : FWD_BCH_REFUND_BLOCKS),
      updatedAt: response.updatedAt,
      transactions: txList(response.txIds),
      bchLockUtxo: null,
      claimAvailable: claimAvailable(response.status),
      refundAvailable:
        response.terms.direction === 'COUNTER_TO_BCH' &&
        refundAvailable(response.status),
      bchRefundAvailable: false,
    };
  }

  async relayClaim(orderId: Hex32, secret: Hex32): Promise<void> {
    await this.#json(
      RelayClaimResponseSchema,
      `/v1/orders/${orderId}/relay-claim`,
      {
        method: 'POST',
        body: serializeApiJson({ secret }),
      },
    );
  }

  async submitSecret(orderId: Hex32, secret: Hex32): Promise<void> {
    await this.#json(
      RevealSecretResponseSchema,
      `/v1/orders/${orderId}/secret`,
      {
        method: 'POST',
        body: serializeApiJson({ secret }),
      },
    );
  }
}

export function createHttpSolverClient(baseUrl: string): SolverClient {
  return new HttpSolverClient(baseUrl);
}

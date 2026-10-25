import { isTerminalOrderStatus } from '@ferry/core';
import { BCH_BLOCK_SECONDS } from '../config';
import type { OrderStatus, OrderTransaction, OrderView } from './types';
import { STATUS_LABELS } from './types';

export type StepState = 'done' | 'current' | 'pending' | 'error';

export interface TimelineStep {
  readonly key: string;
  readonly label: string;
  readonly state: StepState;
  readonly transaction: OrderTransaction | null;
}

export interface OrderViewModel {
  readonly statusLabel: string;
  readonly terminal: boolean;
  readonly steps: readonly TimelineStep[];
  readonly blocksRemaining: number;
  readonly bchTimeRemainingSeconds: number;
  readonly counterTimeRemainingSeconds: number;
  readonly claimAvailable: boolean;
  readonly refundAvailable: boolean;
  readonly bchLockUtxo: OrderView['bchLockUtxo'];
}

const STEP_STATUS: readonly {
  readonly key: string;
  readonly label: string;
  readonly reached: readonly OrderStatus[];
  readonly txLabel: string | null;
}[] = [
  {
    key: 'quote',
    label: 'Quote signed',
    reached: [
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
    ],
    txLabel: null,
  },
  {
    key: 'user-lock',
    label: 'USDC locked on Base',
    reached: [
      'USER_LOCK_SEEN',
      'USER_LOCK_FINAL',
      'SOLVER_LOCK_BROADCAST',
      'SOLVER_LOCK_SEEN',
      'SECRET_KNOWN',
      'USER_CLAIM_SEEN',
      'SOLVER_CLAIM_BROADCAST',
      'SOLVER_CLAIM_FINAL',
      'DONE',
    ],
    txLabel: 'Base lock',
  },
  {
    key: 'solver-lock',
    label: 'tPUSD locked on BCH',
    reached: [
      'SOLVER_LOCK_BROADCAST',
      'SOLVER_LOCK_SEEN',
      'SECRET_KNOWN',
      'USER_CLAIM_SEEN',
      'SOLVER_CLAIM_BROADCAST',
      'SOLVER_CLAIM_FINAL',
      'DONE',
    ],
    txLabel: 'BCH lock',
  },
  {
    key: 'secret',
    label: 'Secret revealed',
    reached: [
      'SECRET_KNOWN',
      'USER_CLAIM_SEEN',
      'SOLVER_CLAIM_BROADCAST',
      'SOLVER_CLAIM_FINAL',
      'DONE',
    ],
    txLabel: null,
  },
  {
    key: 'settled',
    label: 'Both sides settled',
    reached: ['DONE'],
    txLabel: 'Base claim',
  },
];

function statusIndex(status: OrderStatus): number {
  for (let index = STEP_STATUS.length - 1; index >= 0; index -= 1) {
    if (STEP_STATUS[index]?.reached.includes(status)) return index;
  }
  return -1;
}

function findTx(
  transactions: readonly OrderTransaction[],
  label: string,
): OrderTransaction | null {
  return transactions.find((tx) => tx.label === label) ?? null;
}

export function buildOrderViewModel(
  order: OrderView,
  nowSeconds = Math.floor(Date.now() / 1000),
): OrderViewModel {
  const index = statusIndex(order.status);
  const terminal = isTerminalOrderStatus(order.status);
  const failedAt =
    order.status === 'REJECTED'
      ? 2
      : order.status === 'EXPIRED'
        ? 1
        : order.status === 'SOLVER_REFUND_BROADCAST' ||
            order.status === 'SOLVER_REFUNDED'
          ? 2
          : -1;

  const steps = STEP_STATUS.map<TimelineStep>((step, position) => ({
    key: step.key,
    label: step.label,
    state:
      failedAt >= 0
        ? position < failedAt
          ? 'done'
          : position === failedAt
            ? 'error'
            : 'pending'
        : index > position
          ? 'done'
          : index === position
            ? terminal
              ? 'done'
              : 'current'
            : 'pending',
    transaction:
      step.txLabel === null ? null : findTx(order.transactions, step.txLabel),
  }));

  const blocksRemaining = Math.max(
    0,
    order.terms.bchRefundHeight - order.bchTipHeight,
  );

  return {
    statusLabel: STATUS_LABELS[order.status],
    terminal,
    steps,
    blocksRemaining,
    bchTimeRemainingSeconds: blocksRemaining * BCH_BLOCK_SECONDS,
    counterTimeRemainingSeconds: Math.max(
      0,
      order.terms.counterDeadline - nowSeconds,
    ),
    claimAvailable: order.claimAvailable && !terminal && failedAt < 0,
    refundAvailable: order.refundAvailable,
    bchLockUtxo: order.bchLockUtxo,
  };
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

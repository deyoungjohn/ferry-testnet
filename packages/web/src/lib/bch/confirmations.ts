import { PUSD_SYMBOL } from '../config';
import { payeeName, type OrderSource } from '../orders/context';

export interface ClaimConfirmationCopy {
  readonly title: string;
  readonly body: string;
  readonly confirmed: boolean;
}

export function bchClaimConfirmationCopy(
  confirmations: number | null,
  reverse = false,
  payment?: { readonly source: OrderSource; readonly amount: string },
): ClaimConfirmationCopy {
  if (reverse) {
    // The BCH claim in a BCH→Base order is the solver's; the user receives USDC.
    if (confirmations === null) {
      return {
        title: `Solver ${PUSD_SYMBOL} claim`,
        body: 'Checking the solver’s BCH claim on chipnet…',
        confirmed: false,
      };
    }
    if (confirmations < 1) {
      return {
        title: `Solver ${PUSD_SYMBOL} claim in the mempool`,
        body: `The solver’s claim of your ${PUSD_SYMBOL} is in the mempool. Your USDC has already arrived; nothing more is needed from you.`,
        confirmed: false,
      };
    }
    return {
      title: `Solver ${PUSD_SYMBOL} claim confirmed · ${confirmations.toString()} confirmation${confirmations === 1 ? '' : 's'}`,
      body: `The solver’s claim of your ${PUSD_SYMBOL} is confirmed. Nothing more is needed from you.`,
      confirmed: true,
    };
  }
  if (confirmations === null) {
    return {
      title: 'BCH claim confirmation',
      body: 'Checking the BCH claim on chipnet…',
      confirmed: false,
    };
  }
  if (payment && payment.source !== 'swap') {
    const payee = payeeName(payment.source);
    const amount = `${payment.amount} ${PUSD_SYMBOL}`;
    return confirmations < 1
      ? {
          title: 'BCH claim in the mempool',
          body: `${payee} receives ${amount} after 1 confirmation; chipnet blocks can take several minutes.`,
          confirmed: false,
        }
      : {
          title: `BCH claim confirmed · ${confirmations.toString()} confirmation${confirmations === 1 ? '' : 's'}`,
          body: `${payee} has received ${amount}.`,
          confirmed: true,
        };
  }
  if (confirmations < 1) {
    return {
      title: 'BCH claim in the mempool',
      body: `Your ${PUSD_SYMBOL} claim is in the mempool. Most wallets show it after 1 confirmation; chipnet blocks can take several minutes.`,
      confirmed: false,
    };
  }
  return {
    title: `BCH claim confirmed · ${confirmations.toString()} confirmation${confirmations === 1 ? '' : 's'}`,
    body: `Your ${PUSD_SYMBOL} claim is confirmed. Your wallet should now show the tokens.`,
    confirmed: true,
  };
}

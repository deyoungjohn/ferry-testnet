import { PUSD_SYMBOL } from '../config';

export interface ClaimConfirmationCopy {
  readonly title: string;
  readonly body: string;
  readonly confirmed: boolean;
}

export function bchClaimConfirmationCopy(
  confirmations: number | null,
): ClaimConfirmationCopy {
  if (confirmations === null) {
    return {
      title: 'BCH claim confirmation',
      body: 'Checking the BCH claim on chipnet…',
      confirmed: false,
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

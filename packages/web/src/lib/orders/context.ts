export type OrderSource = 'swap' | 'invoice' | 'tip';

const KEY_PREFIX = 'ferry-order-source:';

/** Remember where an order came from. The solver's order view does not carry it yet. */
export function saveOrderSource(orderId: string, source: OrderSource): void {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${orderId}`, source);
  } catch {
    // Storage can be blocked; the page then falls back to swap wording.
  }
}

export function loadOrderSource(orderId: string): OrderSource {
  try {
    const value = window.localStorage.getItem(`${KEY_PREFIX}${orderId}`);
    return value === 'invoice' || value === 'tip' ? value : 'swap';
  } catch {
    return 'swap';
  }
}

export interface StatusWording {
  readonly eyebrow: string;
  readonly sendLabel: string;
  readonly receiveLabel: string;
}

export function statusWording(source: OrderSource): StatusWording {
  if (source === 'invoice') {
    return {
      eyebrow: 'Invoice Status',
      sendLabel: 'You pay',
      receiveLabel: 'They receive',
    };
  }
  if (source === 'tip') {
    return {
      eyebrow: 'Tip Status',
      sendLabel: 'You tip',
      receiveLabel: 'They receive',
    };
  }
  return {
    eyebrow: 'Swap status',
    sendLabel: 'You send',
    receiveLabel: 'You receive',
  };
}

/** Who gets the tokens, in the sentence the payer reads. */
export function payeeName(source: OrderSource): string {
  return source === 'tip' ? 'Recipient' : 'Invoice owner';
}

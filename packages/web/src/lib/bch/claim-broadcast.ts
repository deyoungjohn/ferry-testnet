const ALREADY_BROADCAST = [
  'already in block chain',
  'already in blockchain',
  'txn-already-known',
  'already known',
  'bad-txns-inputs-missingorspent',
  'txn-mempool-conflict',
  'missing inputs',
  'already spent',
] as const;

export function isAlreadyBroadcastError(cause: unknown): boolean {
  const message = (
    cause !== null &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof cause.message === 'string'
      ? cause.message
      : String(cause)
  ).toLowerCase();
  return ALREADY_BROADCAST.some((needle) => message.includes(needle));
}

export interface ClaimBroadcastResult {
  readonly txid: string;
  readonly already: boolean;
}

export async function broadcastClaimIdempotent(
  broadcast: (txHex: string) => Promise<string>,
  txHex: string,
  expectedTxid: string,
): Promise<ClaimBroadcastResult> {
  try {
    return { txid: await broadcast(txHex), already: false };
  } catch (cause) {
    if (isAlreadyBroadcastError(cause)) {
      return { txid: expectedTxid, already: true };
    }
    throw cause;
  }
}

const PROVEN_BROADCAST = [
  'already in block chain',
  'already in blockchain',
  'txn-already-known',
  'already known',
] as const;

const AMBIGUOUS_SPENT = [
  'bad-txns-inputs-missingorspent',
  'txn-mempool-conflict',
  'missing inputs',
  'already spent',
] as const;

function messageOf(cause: unknown): string {
  return (
    cause !== null &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof cause.message === 'string'
      ? cause.message
      : String(cause)
  ).toLowerCase();
}

export function isProvenBroadcastError(cause: unknown): boolean {
  const message = messageOf(cause);
  return PROVEN_BROADCAST.some((needle) => message.includes(needle));
}

export function isAmbiguousSpentError(cause: unknown): boolean {
  const message = messageOf(cause);
  return AMBIGUOUS_SPENT.some((needle) => message.includes(needle));
}

export class ClaimSpentError extends Error {
  readonly nextStep =
    'Do not reveal your secret. Open Recovery and inspect both chains.';

  constructor() {
    super('The BCH lock was spent by a different transaction.');
    this.name = 'ClaimSpentError';
  }
}

export class ClaimVerificationError extends Error {
  readonly nextStep =
    'Do not reveal your secret. Open Recovery and check both chains.';

  constructor(cause: unknown) {
    super(
      `The BCH lock may have been spent, but the claim txid could not be verified. (${messageOf(cause)})`,
    );
    this.name = 'ClaimVerificationError';
  }
}

export interface ClaimBroadcastResult {
  readonly txid: string;
  readonly already: boolean;
}

export async function broadcastClaimIdempotent({
  broadcast,
  transactionExists,
  txHex,
  expectedTxid,
}: {
  readonly broadcast: (txHex: string) => Promise<string>;
  readonly transactionExists: (txid: string) => Promise<boolean>;
  readonly txHex: string;
  readonly expectedTxid: string;
}): Promise<ClaimBroadcastResult> {
  try {
    return { txid: await broadcast(txHex), already: false };
  } catch (cause) {
    if (isProvenBroadcastError(cause)) {
      return { txid: expectedTxid, already: true };
    }
    if (isAmbiguousSpentError(cause)) {
      const exists = await transactionExists(expectedTxid).catch(
        (lookupCause: unknown) => {
          throw new ClaimVerificationError(lookupCause);
        },
      );
      if (exists) return { txid: expectedTxid, already: true };
      throw new ClaimSpentError();
    }
    throw cause;
  }
}

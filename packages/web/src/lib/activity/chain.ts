import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';

export const lockedEvent = parseAbiItem(
  'event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 hashLock, uint64 deadline)',
);
export const claimedEvent = parseAbiItem(
  'event Claimed(bytes32 indexed id, bytes32 secret)',
);
export const refundedEvent = parseAbiItem('event Refunded(bytes32 indexed id)');

const MIN_CHUNK = 200n;
const MAX_CHUNK = 50_000n;
const PARALLEL = 4;

/**
 * Scan a block range in chunks. Public RPCs cap `eth_getLogs` ranges (200 to
 * 50,000 blocks), so a refused chunk halves the chunk size and retries.
 */
export async function scanRange<T>(
  fetch: (from: bigint, to: bigint) => Promise<readonly T[]>,
  from: bigint,
  to: bigint,
): Promise<T[]> {
  const out: T[] = [];
  let chunk = MAX_CHUNK;
  let cursor = from;
  while (cursor <= to) {
    const batch: Array<[bigint, bigint]> = [];
    let start = cursor;
    for (let i = 0; i < PARALLEL && start <= to; i += 1) {
      const end = start + chunk - 1n > to ? to : start + chunk - 1n;
      batch.push([start, end]);
      start = end + 1n;
    }
    try {
      const results = await Promise.all(batch.map(([a, b]) => fetch(a, b)));
      for (const rows of results) out.push(...rows);
      cursor = start;
    } catch (cause) {
      if (chunk <= MIN_CHUNK) throw cause;
      chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
    }
  }
  return out;
}

export type ChainLockState = 'locked' | 'claimed' | 'refunded';

export interface ChainLock {
  readonly id: Hex;
  /** `sender`: the user locked (USDC to BCH). `recipient`: the solver locked for the user (BCH to USDC). */
  readonly role: 'sender' | 'recipient';
  readonly token: Address;
  readonly amount: bigint;
  readonly hashLock: Hex;
  readonly deadline: bigint;
  readonly blockNumber: bigint;
  readonly lockedAt: number;
  readonly lockTx: Hex;
  readonly state: ChainLockState;
  readonly settleTx: Hex | null;
}

export interface FetchChainLocksOptions {
  readonly client: PublicClient;
  readonly htlc: Address;
  readonly user: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/** Every HTLC lock where `user` is the sender or the recipient, read from the chain. */
export async function fetchChainLocks({
  client,
  htlc,
  user,
  fromBlock,
  toBlock,
}: FetchChainLocksOptions): Promise<ChainLock[]> {
  const [asSender, asRecipient] = await Promise.all([
    scanRange(
      (a, b) =>
        client.getLogs({
          address: htlc,
          event: lockedEvent,
          args: { sender: user },
          fromBlock: a,
          toBlock: b,
        }),
      fromBlock,
      toBlock,
    ),
    scanRange(
      (a, b) =>
        client.getLogs({
          address: htlc,
          event: lockedEvent,
          args: { recipient: user },
          fromBlock: a,
          toBlock: b,
        }),
      fromBlock,
      toBlock,
    ),
  ]);

  const locks = new Map<
    string,
    { log: (typeof asSender)[number]; role: 'sender' | 'recipient' }
  >();
  for (const log of asRecipient)
    locks.set(log.args.id as string, { log, role: 'recipient' });
  for (const log of asSender)
    locks.set(log.args.id as string, { log, role: 'sender' });
  if (locks.size === 0) return [];

  const ids = [...locks.keys()] as Hex[];
  const minBlock = [...locks.values()].reduce(
    (min, { log }) => (log.blockNumber < min ? log.blockNumber : min),
    toBlock,
  );
  const latest = await client.getBlockNumber();
  const [claims, refunds] = await Promise.all([
    scanRange(
      (a, b) =>
        client.getLogs({
          address: htlc,
          event: claimedEvent,
          args: { id: ids },
          fromBlock: a,
          toBlock: b,
        }),
      minBlock,
      latest,
    ),
    scanRange(
      (a, b) =>
        client.getLogs({
          address: htlc,
          event: refundedEvent,
          args: { id: ids },
          fromBlock: a,
          toBlock: b,
        }),
      minBlock,
      latest,
    ),
  ]);
  const claimTx = new Map(
    claims.map((log) => [log.args.id as string, log.transactionHash]),
  );
  const refundTx = new Map(
    refunds.map((log) => [log.args.id as string, log.transactionHash]),
  );

  const blocks = [
    ...new Set([...locks.values()].map(({ log }) => log.blockNumber)),
  ];
  const times = new Map<bigint, number>();
  await Promise.all(
    blocks.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      times.set(blockNumber, Number(block.timestamp));
    }),
  );

  return [...locks.entries()].map(([id, { log, role }]) => {
    const claimed = claimTx.get(id);
    const refunded = refundTx.get(id);
    return {
      id: id as Hex,
      role,
      token: log.args.token as Address,
      amount: log.args.amount as bigint,
      hashLock: log.args.hashLock as Hex,
      deadline: log.args.deadline as bigint,
      blockNumber: log.blockNumber,
      lockedAt: times.get(log.blockNumber) ?? 0,
      lockTx: log.transactionHash,
      state: claimed ? 'claimed' : refunded ? 'refunded' : 'locked',
      settleTx: (claimed ?? refunded ?? null) as Hex | null,
    } satisfies ChainLock;
  });
}

import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import type { Address, Hash, PublicClient, WalletClient } from 'viem';
import { evmLockId, lockIntentTypedData, isValidSecret } from '@ferry/core';
import type {
  ChainAdapter,
  CounterAsset,
  CounterChain,
  Hex,
  Hex32,
  Lane,
  LockData,
  LockEvent,
  LockState,
  OrderTerms,
  SignedLock,
  TxRef,
  UnsignedLock,
  Unsubscribe,
} from '@ferry/core';
import { ferryHtlcAbi } from '@ferry/htlc-evm/abi';

export interface EvmAdapterConfig {
  chain: CounterChain;
  chainId: number;
  rpcUrl: string;
  htlcAddress: Address;
  usdcAddress: Address;
  usdtAddress?: Address | undefined;
  confirmations?: number | undefined;
  client?: PublicClient | undefined;
  walletClient?: WalletClient | undefined;
}

export interface RelayLockPayload {
  owner: Address;
  token: Address;
  recipient: Address;
  amount: bigint;
  hashLock: Hex32;
  deadline: bigint;
  intentDeadline: bigint;
  intentSig: Hex;
  permitDeadline: bigint;
  v: number;
  r: Hex32;
  s: Hex32;
}

const erc20PermitAbi = parseAbi([
  'function name() external view returns (string)',
  'function nonces(address owner) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
]);

export class RelayLockRejectedError extends Error {
  constructor(
    readonly code: 'INSUFFICIENT_USER_BALANCE' | 'RELAY_LOCK_REVERTED',
    message: string,
  ) {
    super(message);
    this.name = 'RelayLockRejectedError';
  }
}

export class EvmChainAdapter implements ChainAdapter {
  readonly id: CounterChain;
  readonly chainId: number;
  readonly htlcAddress: Address;
  readonly usdcAddress: Address;
  readonly usdtAddress?: Address | undefined;
  readonly confirmations: number;
  readonly client: PublicClient;
  readonly walletClient?: WalletClient | undefined;
  readonly assets: readonly CounterAsset[];

  private lastSeenTxByAction = new Map<string, string>();
  private lastSeenSecretByLock = new Map<string, Hex32>();

  constructor(config: EvmAdapterConfig) {
    this.id = config.chain;
    this.chainId = config.chainId;
    this.htlcAddress = getAddress(config.htlcAddress);
    this.usdcAddress = getAddress(config.usdcAddress);
    this.usdtAddress = config.usdtAddress
      ? getAddress(config.usdtAddress)
      : undefined;
    this.confirmations = config.confirmations ?? 10;

    this.client =
      config.client ??
      createPublicClient({
        transport: http(config.rpcUrl),
      });
    this.walletClient = config.walletClient;

    const assets: CounterAsset[] = [
      {
        symbol: 'USDC',
        decimals: 6,
        address: this.usdcAddress.toLowerCase(),
        permit: true,
      },
    ];
    if (this.usdtAddress) {
      assets.push({
        symbol: 'USDT',
        decimals: this.id === 'bsc' ? 18 : 6,
        address: this.usdtAddress.toLowerCase(),
        permit: false,
      });
    }
    this.assets = Object.freeze(assets);
  }

  lockId(owner: string, hashLock: Hex32): string {
    return evmLockId(owner, hashLock);
  }

  async buildUserLock(terms: OrderTerms): Promise<UnsignedLock> {
    const owner = getAddress(terms.userCounterAddress);
    const token = getAddress(terms.counterAsset.address);
    const recipient = getAddress(terms.solverCounterAddress);
    const amount = terms.counterAmount;
    const hashLock = terms.hashLock;
    const deadline = BigInt(terms.counterDeadline);
    const intentDeadline = BigInt(terms.quoteExpiry + 3600);

    const intentData = lockIntentTypedData(
      { chainId: this.chainId, verifyingContract: this.htlcAddress },
      {
        token,
        recipient,
        amount,
        hashLock,
        deadline,
        intentDeadline,
      },
    );

    let permitData: unknown = undefined;
    try {
      const [tokenName, nonce] = await Promise.all([
        this.client.readContract({
          address: token,
          abi: erc20PermitAbi,
          functionName: 'name',
        }),
        this.client.readContract({
          address: token,
          abi: erc20PermitAbi,
          functionName: 'nonces',
          args: [owner],
        }),
      ]);

      permitData = {
        domain: {
          name: tokenName,
          version: '1',
          chainId: this.chainId,
          verifyingContract: token,
        },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: {
          owner,
          spender: this.htlcAddress,
          value: amount,
          nonce,
          deadline: intentDeadline,
        },
      };
    } catch {
      // Non-permit token or mock; proceed without permitData
    }

    return {
      chain: this.id,
      orderId: hashLock,
      payload: {
        lockIntentTypedData: intentData,
        permitTypedData: permitData,
      },
    };
  }

  private sendQueue: Promise<unknown> = Promise.resolve();

  /**
   * One signer, one send queue: a transaction is sent and mined before the next
   * one is built, so concurrent refund, lock and claim paths cannot reuse a
   * nonce.
   */
  private send(
    args: Parameters<WalletClient['writeContract']>[0],
  ): Promise<Hash> {
    const run = async (): Promise<Hash> => {
      if (!this.walletClient) {
        throw new Error('WalletClient required to send a transaction');
      }
      const hash = await this.walletClient.writeContract(args);
      await this.client.waitForTransactionReceipt({ hash });
      return hash;
    };
    const result = this.sendQueue.then(run, run);
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  async relayLock(signed: SignedLock): Promise<TxRef> {
    const payload = signed.payload as RelayLockPayload;
    const lockId = this.lockId(payload.owner, payload.hashLock);

    const actionKey = `relayLock:${lockId}`;
    const cachedTx = this.lastSeenTxByAction.get(actionKey);
    if (cachedTx) {
      return { chain: this.id, txId: cachedTx };
    }

    const currentLock = await this.getLock(lockId);
    if (currentLock.status !== 'absent') {
      return currentLock.lockTx;
    }

    if (!this.walletClient || !this.walletClient.account) {
      throw new Error('WalletClient with account required to relay lock');
    }

    const balance = await this.client.readContract({
      address: getAddress(payload.token),
      abi: erc20PermitAbi,
      functionName: 'balanceOf',
      args: [getAddress(payload.owner)],
    });
    if (balance < payload.amount) {
      throw new RelayLockRejectedError(
        'INSUFFICIENT_USER_BALANCE',
        `Owner holds ${balance} base units but the lock needs ${payload.amount}`,
      );
    }

    let hash: Hash;
    try {
      hash = await this.sendRelayLock(payload);
    } catch (err) {
      throw new RelayLockRejectedError(
        'RELAY_LOCK_REVERTED',
        (err as { shortMessage?: string }).shortMessage ??
          (err as Error).message,
      );
    }

    await this.client.waitForTransactionReceipt({ hash });
    this.lastSeenTxByAction.set(actionKey, hash);
    return { chain: this.id, txId: hash };
  }

  private async sendRelayLock(payload: RelayLockPayload): Promise<Hash> {
    if (!this.walletClient || !this.walletClient.account) {
      throw new Error('WalletClient with account required to relay lock');
    }
    return this.send({
      address: this.htlcAddress,
      abi: ferryHtlcAbi,
      functionName: 'lockWithIntent',
      args: [
        getAddress(payload.owner),
        getAddress(payload.token),
        getAddress(payload.recipient),
        payload.amount,
        payload.hashLock,
        payload.deadline,
        payload.intentDeadline,
        payload.intentSig,
        payload.permitDeadline,
        payload.v,
        payload.r,
        payload.s,
      ],
      chain: null,
      account: this.walletClient.account,
    });
  }

  async lock(terms: OrderTerms): Promise<TxRef> {
    const isForward = terms.direction === 'COUNTER_TO_BCH';
    const owner = getAddress(
      isForward ? terms.userCounterAddress : terms.solverCounterAddress,
    );
    const recipient = getAddress(
      isForward ? terms.solverCounterAddress : terms.userCounterAddress,
    );
    const hashLock = terms.hashLock;
    const lockId = this.lockId(owner, hashLock);

    const actionKey = `lock:${lockId}`;
    const cachedTx = this.lastSeenTxByAction.get(actionKey);
    if (cachedTx) {
      return { chain: this.id, txId: cachedTx };
    }

    const currentLock = await this.getLock(lockId);
    if (currentLock.status !== 'absent') {
      return currentLock.lockTx;
    }

    if (!this.walletClient || !this.walletClient.account) {
      throw new Error('WalletClient with account required to lock');
    }

    // The locker owns its approvals: top up exactly what this lock needs.
    const token = getAddress(terms.counterAsset.address);
    const allowance = await this.client.readContract({
      address: token,
      abi: erc20PermitAbi,
      functionName: 'allowance',
      args: [this.walletClient.account.address, this.htlcAddress],
    });
    if (allowance < terms.counterAmount) {
      const approveHash = await this.send({
        address: token,
        abi: erc20PermitAbi,
        functionName: 'approve',
        args: [this.htlcAddress, terms.counterAmount],
        chain: null,
        account: this.walletClient.account,
      });
      await this.client.waitForTransactionReceipt({ hash: approveHash });
    }

    const hash = await this.send({
      address: this.htlcAddress,
      abi: ferryHtlcAbi,
      functionName: 'lock',
      args: [
        getAddress(terms.counterAsset.address),
        recipient,
        terms.counterAmount,
        terms.hashLock,
        BigInt(terms.counterDeadline),
      ],
      chain: null,
      account: this.walletClient.account,
    });

    await this.client.waitForTransactionReceipt({ hash });
    this.lastSeenTxByAction.set(actionKey, hash);
    return { chain: this.id, txId: hash };
  }

  async claim(lockId: string, secret: Hex32): Promise<TxRef> {
    const actionKey = `claim:${lockId}`;
    const cachedTx = this.lastSeenTxByAction.get(actionKey);
    if (cachedTx) {
      return { chain: this.id, txId: cachedTx };
    }

    const currentLock = await this.getLock(lockId);
    if (currentLock.status === 'claimed') {
      return currentLock.claimTx;
    }
    if (currentLock.status !== 'locked') {
      throw new Error(`Cannot claim lock in state: ${currentLock.status}`);
    }

    if (!this.walletClient || !this.walletClient.account) {
      throw new Error('WalletClient with account required to claim');
    }

    try {
      const hash = await this.send({
        address: this.htlcAddress,
        abi: ferryHtlcAbi,
        functionName: 'claim',
        args: [lockId as Hex32, secret],
        chain: null,
        account: this.walletClient.account,
      });

      await this.client.waitForTransactionReceipt({ hash });
      this.lastSeenTxByAction.set(actionKey, hash);
      this.lastSeenSecretByLock.set(lockId, secret);
      return { chain: this.id, txId: hash };
    } catch (err: unknown) {
      // Re-check on chain state in case of race / double-send / NotLocked()
      const recheck = await this.getLock(lockId);
      if (recheck.status === 'claimed') {
        this.lastSeenTxByAction.set(actionKey, recheck.claimTx.txId);
        this.lastSeenSecretByLock.set(lockId, secret);
        return recheck.claimTx;
      }
      throw err;
    }
  }

  async refund(lockId: string): Promise<TxRef> {
    const actionKey = `refund:${lockId}`;
    const cachedTx = this.lastSeenTxByAction.get(actionKey);
    if (cachedTx) {
      return { chain: this.id, txId: cachedTx };
    }

    const currentLock = await this.getLock(lockId);
    if (currentLock.status === 'refunded') {
      return currentLock.refundTx;
    }
    if (currentLock.status !== 'locked') {
      throw new Error(`Cannot refund lock in state: ${currentLock.status}`);
    }

    if (!this.walletClient || !this.walletClient.account) {
      throw new Error('WalletClient with account required to refund');
    }

    const hash = await this.send({
      address: this.htlcAddress,
      abi: ferryHtlcAbi,
      functionName: 'refund',
      args: [lockId as Hex32],
      chain: null,
      account: this.walletClient.account,
    });

    await this.client.waitForTransactionReceipt({ hash });
    this.lastSeenTxByAction.set(actionKey, hash);
    return { chain: this.id, txId: hash };
  }

  async getLock(lockId: string): Promise<LockState> {
    const lockRaw = await this.client.readContract({
      address: this.htlcAddress,
      abi: ferryHtlcAbi,
      functionName: 'locks',
      args: [lockId as Hex32],
    });

    const [token, sender, recipient, amount, hashLock, deadline, stateNum] =
      lockRaw as [Address, Address, Address, bigint, Hex32, bigint, number];

    if (stateNum === 0 || amount === 0n) {
      return { status: 'absent' };
    }

    const asset = this.assets.find(
      (a) => a.address === token.toLowerCase(),
    ) ?? {
      symbol: 'USDC',
      decimals: 6,
      address: token.toLowerCase(),
      permit: false,
    };

    const lockData: LockData = {
      owner: sender.toLowerCase(),
      recipient: recipient.toLowerCase(),
      asset,
      amount,
      hashLock,
      deadline: Number(deadline),
    };

    const cachedLockTx =
      this.lastSeenTxByAction.get(`lock:${lockId}`) ??
      this.lastSeenTxByAction.get(`relayLock:${lockId}`) ??
      `0x${'00'.repeat(32)}`;
    const lockTx: TxRef = { chain: this.id, txId: cachedLockTx };

    if (stateNum === 1) {
      return { status: 'locked', lockTx, ...lockData };
    }

    if (stateNum === 2) {
      const cachedClaimTx =
        this.lastSeenTxByAction.get(`claim:${lockId}`) ??
        `0x${'00'.repeat(32)}`;
      let claimSecret = this.lastSeenSecretByLock.get(lockId);
      if (!claimSecret) {
        try {
          const logs = await this.client.getLogs({
            address: this.htlcAddress,
            event: {
              type: 'event',
              name: 'Claimed',
              inputs: [
                { name: 'id', type: 'bytes32', indexed: true },
                { name: 'secret', type: 'bytes32', indexed: false },
              ],
            },
            args: { id: lockId as Hex32 },
            fromBlock: 0n,
          });
          if (logs[0]?.args.secret) {
            claimSecret = logs[0].args.secret as Hex32;
            this.lastSeenSecretByLock.set(lockId, claimSecret);
          }
        } catch {
          // ignore log fetch error
        }
      }
      if (claimSecret && !isValidSecret(claimSecret, lockData.hashLock)) {
        claimSecret = undefined;
      }
      return {
        status: 'claimed',
        lockTx,
        claimTx: { chain: this.id, txId: cachedClaimTx },
        secret: claimSecret ?? null,
        ...lockData,
      };
    }

    if (stateNum === 3) {
      const cachedRefundTx =
        this.lastSeenTxByAction.get(`refund:${lockId}`) ??
        `0x${'00'.repeat(32)}`;
      return {
        status: 'refunded',
        lockTx,
        refundTx: { chain: this.id, txId: cachedRefundTx },
        ...lockData,
      };
    }

    return { status: 'absent' };
  }

  watch(onEvent: (event: LockEvent) => void): Unsubscribe {
    const seenEvents = new Set<string>();
    let lastProcessedBlock: bigint | undefined = undefined;
    let active = true;

    const emitEvent = (event: LockEvent) => {
      if (seenEvents.has(event.eventId)) return;
      seenEvents.add(event.eventId);
      onEvent(event);
    };

    const unwatchContract = this.client.watchContractEvent({
      address: this.htlcAddress,
      abi: ferryHtlcAbi,
      onLogs: (logs) => {
        if (!active) return;
        for (const log of logs) {
          const eventId = `${log.blockHash}:${log.logIndex}`;
          const txRef: TxRef = {
            chain: this.id,
            txId: log.transactionHash ?? `0x${'00'.repeat(32)}`,
          };

          if (log.eventName === 'Locked') {
            const args = log.args as unknown as {
              id: Hex32;
              sender: Address;
              recipient: Address;
              token: Address;
              amount: bigint;
              hashLock: Hex32;
              deadline: bigint;
            };
            const asset = this.assets.find(
              (a) => a.address === args.token.toLowerCase(),
            ) ?? {
              symbol: 'USDC',
              decimals: 6,
              address: args.token.toLowerCase(),
              permit: false,
            };
            emitEvent({
              eventId,
              lockId: args.id,
              tx: txRef,
              removed: log.removed ?? false,
              type: 'Locked',
              lock: {
                owner: args.sender.toLowerCase(),
                recipient: args.recipient.toLowerCase(),
                asset,
                amount: args.amount,
                hashLock: args.hashLock,
                deadline: Number(args.deadline),
              },
            });
          } else if (log.eventName === 'Claimed') {
            const args = log.args as unknown as { id: Hex32; secret: Hex32 };
            emitEvent({
              eventId,
              lockId: args.id,
              tx: txRef,
              removed: log.removed ?? false,
              type: 'Claimed',
              secret: args.secret,
            });
          } else if (log.eventName === 'Refunded') {
            const args = log.args as unknown as { id: Hex32 };
            emitEvent({
              eventId,
              lockId: args.id,
              tx: txRef,
              removed: log.removed ?? false,
              type: 'Refunded',
            });
          }
        }
      },
    });

    const pollLogs = async () => {
      if (!active) return;
      try {
        const currentBlock = await this.client.getBlockNumber();
        const fromBlock =
          lastProcessedBlock !== undefined
            ? lastProcessedBlock + 1n
            : currentBlock > 10n
              ? currentBlock - 10n
              : 0n;

        if (fromBlock <= currentBlock) {
          const logs = await this.client.getLogs({
            address: this.htlcAddress,
            fromBlock,
            toBlock: currentBlock,
          });
          lastProcessedBlock = currentBlock;
          for (const log of logs) {
            const eventId = `${log.blockHash}:${log.logIndex}`;
            const txRef: TxRef = {
              chain: this.id,
              txId: log.transactionHash ?? `0x${'00'.repeat(32)}`,
            };
            const topic = log.topics[0];
            if (topic) {
              const lockId = (log.topics[1] ?? `0x${'00'.repeat(32)}`) as Hex32;
              emitEvent({
                eventId,
                lockId,
                tx: txRef,
                removed: false,
                type: 'Locked',
                lock: {
                  owner: '',
                  recipient: '',
                  asset: this.assets[0]!,
                  amount: 0n,
                  hashLock: lockId,
                  deadline: 0,
                },
              });
            }
          }
        }
      } catch {
        // Log polling error ignored on retry
      }
    };

    const intervalId = setInterval(() => {
      void pollLogs();
    }, 15000);

    return () => {
      active = false;
      clearInterval(intervalId);
      unwatchContract();
    };
  }

  async isFinal(tx: TxRef, lane: Lane): Promise<boolean> {
    try {
      const receipt = await this.client.getTransactionReceipt({
        hash: tx.txId as Hash,
      });
      if (!receipt || receipt.status !== 'success') return false;

      const currentBlock = await this.client.getBlockNumber();
      const confirmations = Number(
        currentBlock >= receipt.blockNumber
          ? currentBlock - receipt.blockNumber + 1n
          : 1n,
      );
      if (lane === 'fast') {
        return confirmations >= 1;
      }

      // Safe lane: check safe/finalized block or confirmations
      try {
        const safeBlock = await this.client.getBlock({ blockTag: 'safe' });
        if (safeBlock && receipt.blockNumber <= safeBlock.number) {
          return true;
        }
      } catch {
        // RPC might not support 'safe' tag
      }

      try {
        const finalizedBlock = await this.client.getBlock({
          blockTag: 'finalized',
        });
        if (finalizedBlock && receipt.blockNumber <= finalizedBlock.number) {
          return true;
        }
      } catch {
        // RPC might not support 'finalized' tag
      }

      return confirmations >= this.confirmations;
    } catch {
      return false;
    }
  }

  async isTxMinedOrPending(txId: string): Promise<boolean> {
    try {
      const receipt = await this.client.getTransactionReceipt({
        hash: txId as Hash,
      });
      if (receipt) return true;
    } catch {
      // not mined yet
    }
    try {
      const tx = await this.client.getTransaction({
        hash: txId as Hash,
      });
      return tx !== null && tx !== undefined;
    } catch {
      return false;
    }
  }

  async estimateRelayCostUsd(): Promise<number> {
    try {
      const gasPrice = await this.client.getGasPrice();
      // Estimated gas for lockWithIntent: ~160k gas
      const gasLimit = 180000n;
      const costWei = gasPrice * gasLimit;
      // Assume ETH ~$3,000 for local estimation
      const ethCost = Number(costWei) / 1e18;
      return ethCost * 3000;
    } catch {
      return 0.05; // Fallback 5 cents
    }
  }

  async getTip(): Promise<{
    height: number;
    timestamp: number;
    ageSeconds: number;
  }> {
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const height = Number(block.number);
    const timestamp = Number(block.timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = Math.max(0, nowSeconds - timestamp);
    return { height, timestamp, ageSeconds };
  }
}

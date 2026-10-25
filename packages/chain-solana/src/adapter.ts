import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  type TransactionSignature,
} from '@solana/web3.js';
import anchorPkg, {
  type Idl,
  type Program as ProgramType,
} from '@coral-xyz/anchor';
import {
  orderId,
  type ChainAdapter,
  type CounterAsset,
  type CounterChain,
  type Hex32,
  type Lane,
  type LockData,
  type LockEvent,
  type LockState,
  type OrderTerms,
  type SignedLock,
  type TxRef,
  type UnsignedLock,
  type Unsubscribe,
} from '@ferry/core';
import {
  PROGRAM_ID,
  FERRY_HTLC_IDL,
  deriveLockPda,
  deriveVaultPda,
  buildLockInstruction,
  buildClaimInstruction,
  buildRefundInstruction,
  fetchLockState,
} from '@ferry/htlc-solana';

const { Program, AnchorProvider } = anchorPkg;

export interface SolanaAdapterConfig {
  connection?: Connection;
  rpcUrl?: string;
  programId?: PublicKey | string;
  usdcMint?: PublicKey | string;
  usdtMint?: PublicKey | string;
  relayerPublicKey?: PublicKey | string;
  payerKeypair?: Keypair;
  confirmations?: number;
}

export interface UserLockPayload {
  transactionBase64: string;
  lockPda: string;
  vaultPda: string;
  mint: string;
  owner: string;
  recipient: string;
  amount: string;
  hashLock: Hex32;
  deadline: number;
}

function hexToBytes(hex: Hex32 | string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(clean, 'hex');
}

function bytesToHex32(bytes: Uint8Array | number[]): Hex32 {
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex32;
}

export class SolanaChainAdapter implements ChainAdapter {
  readonly id: CounterChain = 'solana';
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly usdcMint: PublicKey;
  readonly usdtMint: PublicKey;
  readonly relayerPublicKey?: PublicKey | undefined;
  readonly payerKeypair?: Keypair | undefined;
  readonly program: ProgramType;
  readonly assets: readonly CounterAsset[];

  private lastSeenTxByAction = new Map<string, string>();
  private lastSeenSecretByLock = new Map<string, Hex32>();
  private lockStateCache = new Map<string, LockState>();
  private lockPayerByLockId = new Map<string, PublicKey>();

  constructor(config: SolanaAdapterConfig = {}) {
    if (config.connection) {
      this.connection = config.connection;
    } else if (config.rpcUrl) {
      this.connection = new Connection(config.rpcUrl, 'confirmed');
    } else {
      this.connection = new Connection('http://127.0.0.1:8899', 'confirmed');
    }

    this.programId = config.programId
      ? new PublicKey(config.programId)
      : PROGRAM_ID;

    // Devnet / mainnet default USDC & USDT mints
    this.usdcMint = config.usdcMint
      ? new PublicKey(config.usdcMint)
      : new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    this.usdtMint = config.usdtMint
      ? new PublicKey(config.usdtMint)
      : new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

    this.payerKeypair = config.payerKeypair;
    if (config.relayerPublicKey) {
      this.relayerPublicKey = new PublicKey(config.relayerPublicKey);
    } else if (this.payerKeypair) {
      this.relayerPublicKey = this.payerKeypair.publicKey;
    }

    const wallet = {
      publicKey: this.payerKeypair?.publicKey ?? PublicKey.default,
      signTransaction: async (tx: Transaction) => {
        if (this.payerKeypair) tx.partialSign(this.payerKeypair);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        if (this.payerKeypair) {
          txs.forEach((tx) => tx.partialSign(this.payerKeypair!));
        }
        return txs;
      },
    };

    const provider = new AnchorProvider(
      this.connection,
      wallet as unknown as anchorPkg.Wallet,
      {
        commitment: 'confirmed',
      },
    );

    this.program = new Program(FERRY_HTLC_IDL as Idl, provider);

    this.assets = Object.freeze([
      {
        symbol: 'USDC',
        decimals: 6,
        address: this.usdcMint.toBase58(),
        permit: false,
      },
      {
        symbol: 'USDT',
        decimals: 6,
        address: this.usdtMint.toBase58(),
        permit: false,
      },
    ]);
  }

  lockId(owner: string, hashLock: Hex32): string {
    const ownerPubkey = new PublicKey(owner);
    const hashLockBytes = hexToBytes(hashLock);
    const [pda] = deriveLockPda(ownerPubkey, hashLockBytes, this.programId);
    return pda.toBase58();
  }

  async buildUserLock(terms: OrderTerms): Promise<UnsignedLock> {
    const owner = new PublicKey(terms.userCounterAddress);
    const recipient = new PublicKey(terms.solverCounterAddress);
    const mint = new PublicKey(terms.counterAsset.address);
    const hashLockBytes = hexToBytes(terms.hashLock);

    const relayerPubkey = this.relayerPublicKey;
    if (!relayerPubkey) {
      throw new Error('Relayer public key required to build user lock');
    }

    const [lockPda] = deriveLockPda(owner, hashLockBytes, this.programId);
    const [vaultPda] = deriveVaultPda(lockPda, this.programId);

    const { instruction } = await buildLockInstruction({
      program: this.program,
      payer: relayerPubkey,
      owner,
      recipient,
      mint,
      amount: terms.counterAmount,
      hashLock: hashLockBytes,
      deadline: terms.counterDeadline,
    });

    const latestBlockhash =
      await this.connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: relayerPubkey,
      recentBlockhash: latestBlockhash.blockhash,
    });
    transaction.add(instruction);

    const transactionBase64 = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    const payload: UserLockPayload = {
      transactionBase64,
      lockPda: lockPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      recipient: recipient.toBase58(),
      amount: terms.counterAmount.toString(),
      hashLock: terms.hashLock,
      deadline: terms.counterDeadline,
    };

    return {
      chain: this.id,
      orderId: orderId(terms),
      payload,
    };
  }

  async relayLock(signed: SignedLock): Promise<TxRef> {
    const payload = signed.payload as { transactionBase64: string } | string;
    const base64Str =
      typeof payload === 'string' ? payload : payload.transactionBase64;
    const tx = Transaction.from(Buffer.from(base64Str, 'base64'));

    if (!this.payerKeypair) {
      throw new Error('Payer keypair required to relay lock');
    }

    const actionKey = `relayLock:${signed.orderId}`;
    const cachedTx = this.lastSeenTxByAction.get(actionKey);
    if (cachedTx) {
      return { chain: this.id, txId: cachedTx };
    }

    // Check if the lock state already exists on chain
    // The second account of lock instruction is lockState PDA
    const lockStateAccountMeta = tx.instructions[0]?.keys[3];
    if (lockStateAccountMeta) {
      const existing = await this.getLock(
        lockStateAccountMeta.pubkey.toBase58(),
      );
      if (existing.status !== 'absent') {
        return existing.lockTx;
      }
    }

    tx.partialSign(this.payerKeypair);

    const rawTx = tx.serialize();
    const signature = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    const latestBlockhash =
      await this.connection.getLatestBlockhash('confirmed');
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed',
    );

    this.lastSeenTxByAction.set(actionKey, signature);
    if (lockStateAccountMeta) {
      this.lastSeenTxByAction.set(
        `lock:${lockStateAccountMeta.pubkey.toBase58()}`,
        signature,
      );
    }

    return { chain: this.id, txId: signature };
  }

  async lock(terms: OrderTerms): Promise<TxRef> {
    const isForward = terms.direction === 'COUNTER_TO_BCH';
    const owner = new PublicKey(
      isForward ? terms.userCounterAddress : terms.solverCounterAddress,
    );
    const recipient = new PublicKey(
      isForward ? terms.solverCounterAddress : terms.userCounterAddress,
    );
    const mint = new PublicKey(terms.counterAsset.address);
    const hashLockBytes = hexToBytes(terms.hashLock);

    const lockId = this.lockId(owner.toBase58(), terms.hashLock);
    const actionKey = `lock:${lockId}`;
    const cachedTx = this.lastSeenTxByAction.get(actionKey);
    if (cachedTx) {
      return { chain: this.id, txId: cachedTx };
    }

    const currentLock = await this.getLock(lockId);
    if (currentLock.status !== 'absent') {
      return currentLock.lockTx;
    }

    if (!this.payerKeypair) {
      throw new Error('Payer keypair required to lock');
    }

    const { instruction } = await buildLockInstruction({
      program: this.program,
      payer: this.payerKeypair.publicKey,
      owner,
      recipient,
      mint,
      amount: terms.counterAmount,
      hashLock: hashLockBytes,
      deadline: terms.counterDeadline,
    });

    const latestBlockhash =
      await this.connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: this.payerKeypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    });
    transaction.add(instruction);
    transaction.sign(this.payerKeypair);

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      },
    );

    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed',
    );

    this.lastSeenTxByAction.set(actionKey, signature);
    return { chain: this.id, txId: signature };
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

    if (!this.payerKeypair) {
      throw new Error('Payer keypair required to claim');
    }

    const owner = new PublicKey(currentLock.owner);
    const recipient = new PublicKey(currentLock.recipient);
    const mint = new PublicKey(currentLock.asset.address);
    const hashLockBytes = hexToBytes(currentLock.hashLock);
    const secretBytes = hexToBytes(secret);

    // Retrieve original payer of lock rent
    const originalPayer =
      this.lockPayerByLockId.get(lockId) ?? this.payerKeypair.publicKey;

    const { instruction } = await buildClaimInstruction({
      program: this.program,
      payer: this.payerKeypair.publicKey,
      owner,
      recipient,
      mint,
      hashLock: hashLockBytes,
      secret: secretBytes,
      payerRentDest: originalPayer,
    });

    const latestBlockhash =
      await this.connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: this.payerKeypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    });
    transaction.add(instruction);
    transaction.sign(this.payerKeypair);

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      },
    );

    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed',
    );

    this.lastSeenTxByAction.set(actionKey, signature);
    this.lastSeenSecretByLock.set(lockId, secret);

    const claimedState: LockState = {
      status: 'claimed',
      lockTx: currentLock.lockTx,
      claimTx: { chain: this.id, txId: signature },
      secret,
      owner: currentLock.owner,
      recipient: currentLock.recipient,
      asset: currentLock.asset,
      amount: currentLock.amount,
      hashLock: currentLock.hashLock,
      deadline: currentLock.deadline,
    };
    this.lockStateCache.set(lockId, claimedState);

    return { chain: this.id, txId: signature };
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

    const now = Math.floor(Date.now() / 1000);
    if (now < currentLock.deadline) {
      throw new Error(
        `Cannot refund before deadline: current=${now}, deadline=${currentLock.deadline}`,
      );
    }

    if (!this.payerKeypair) {
      throw new Error('Payer keypair required to refund');
    }

    const owner = new PublicKey(currentLock.owner);
    const mint = new PublicKey(currentLock.asset.address);
    const hashLockBytes = hexToBytes(currentLock.hashLock);

    const originalPayer =
      this.lockPayerByLockId.get(lockId) ?? this.payerKeypair.publicKey;

    const { instruction } = await buildRefundInstruction({
      program: this.program,
      payer: this.payerKeypair.publicKey,
      owner,
      mint,
      hashLock: hashLockBytes,
      payerRentDest: originalPayer,
    });

    const latestBlockhash =
      await this.connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: this.payerKeypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    });
    transaction.add(instruction);
    transaction.sign(this.payerKeypair);

    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      },
    );

    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed',
    );

    this.lastSeenTxByAction.set(actionKey, signature);

    const refundedState: LockState = {
      status: 'refunded',
      lockTx: currentLock.lockTx,
      refundTx: { chain: this.id, txId: signature },
      owner: currentLock.owner,
      recipient: currentLock.recipient,
      asset: currentLock.asset,
      amount: currentLock.amount,
      hashLock: currentLock.hashLock,
      deadline: currentLock.deadline,
    };
    this.lockStateCache.set(lockId, refundedState);

    return { chain: this.id, txId: signature };
  }

  async getLock(lockId: string): Promise<LockState> {
    const lockPda = new PublicKey(lockId);

    const decoded = await fetchLockState(this.program, lockPda);
    if (!decoded) {
      const cached = this.lockStateCache.get(lockId);
      if (cached) {
        return cached;
      }
      return { status: 'absent' };
    }

    const mintStr = decoded.mint.toBase58();
    const asset = this.assets.find((a) => a.address === mintStr) ?? {
      symbol: 'USDC',
      decimals: 6,
      address: mintStr,
      permit: false,
    };

    const cachedLockTx =
      this.lastSeenTxByAction.get(`lock:${lockId}`) ??
      this.lastSeenTxByAction.get(`relayLock:${lockId}`) ??
      '';

    const lockData: LockData = {
      owner: decoded.owner.toBase58(),
      recipient: decoded.recipient.toBase58(),
      asset,
      amount: BigInt(decoded.amount.toString()),
      hashLock: bytesToHex32(decoded.hashLock),
      deadline: Number(decoded.deadline.toString()),
    };

    this.lockPayerByLockId.set(lockId, decoded.payer);

    const lockState: LockState = {
      status: 'locked',
      lockTx: { chain: this.id, txId: cachedLockTx },
      ...lockData,
    };
    this.lockStateCache.set(lockId, lockState);
    return lockState;
  }

  watch(onEvent: (event: LockEvent) => void): Unsubscribe {
    let active = true;
    const seenEvents = new Set<string>();

    const emitEvent = (event: LockEvent) => {
      if (!active) return;
      if (seenEvents.has(event.eventId)) return;
      seenEvents.add(event.eventId);
      onEvent(event);
    };

    // WebSocket / subscription listener
    let subId: number | undefined;
    try {
      subId = this.connection.onLogs(
        this.programId,
        (logsContext) => {
          if (!active) return;
          const signature = logsContext.signature;
          this.parseLogsForEvents(signature, logsContext.logs, emitEvent);
        },
        'confirmed',
      );
    } catch {
      // Polling backstop will handle events if websocket fails
    }

    // Polling backstop
    let lastSignature: TransactionSignature | undefined;
    const pollInterval = setInterval(async () => {
      if (!active) return;
      try {
        const options: { limit: number; until?: string } = { limit: 15 };
        if (lastSignature) {
          options.until = lastSignature;
        }

        const signatures = await this.connection.getSignaturesForAddress(
          this.programId,
          options,
          'confirmed',
        );

        if (signatures.length > 0) {
          lastSignature = signatures[0]!.signature;
          for (const sigInfo of signatures) {
            if (seenEvents.has(`${sigInfo.signature}:0`)) continue;
            const parsedTx = await this.connection.getParsedTransaction(
              sigInfo.signature,
              {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
              },
            );
            if (parsedTx?.meta?.logMessages) {
              this.parseLogsForEvents(
                sigInfo.signature,
                parsedTx.meta.logMessages,
                emitEvent,
              );
            }
          }
        }
      } catch {
        // Polling retry on next cycle
      }
    }, 1500);

    return () => {
      if (!active) return;
      active = false;
      clearInterval(pollInterval);
      if (subId !== undefined) {
        this.connection.removeOnLogsListener(subId).catch(() => {});
      }
    };
  }

  private parseLogsForEvents(
    signature: string,
    logs: string[],
    emitEvent: (e: LockEvent) => void,
  ): void {
    let eventIndex = 0;
    for (const log of logs) {
      if (!log.startsWith('Program data: ')) continue;
      const b64Data = log.slice('Program data: '.length).trim();
      const eventId = `${signature}:${eventIndex++}`;
      const txRef: TxRef = { chain: this.id, txId: signature };

      try {
        const event = this.program.coder.events.decode(b64Data);
        if (!event) continue;

        if (event.name === 'Locked') {
          const data = event.data as unknown as {
            lockState: PublicKey;
            owner: PublicKey;
            recipient: PublicKey;
            mint: PublicKey;
            amount: anchorPkg.BN;
            hashLock: number[];
            deadline: anchorPkg.BN;
          };

          const mintStr = data.mint.toBase58();
          const asset = this.assets.find((a) => a.address === mintStr) ?? {
            symbol: 'USDC',
            decimals: 6,
            address: mintStr,
            permit: false,
          };

          const lockId = data.lockState.toBase58();
          emitEvent({
            eventId,
            lockId,
            tx: txRef,
            removed: false,
            type: 'Locked',
            lock: {
              owner: data.owner.toBase58(),
              recipient: data.recipient.toBase58(),
              asset,
              amount: BigInt(data.amount.toString()),
              hashLock: bytesToHex32(data.hashLock),
              deadline: Number(data.deadline.toString()),
            },
          });
        } else if (event.name === 'Claimed') {
          const data = event.data as unknown as {
            lockState: PublicKey;
            recipient: PublicKey;
            amount: anchorPkg.BN;
          };
          const lockId = data.lockState.toBase58();
          const secret =
            this.lastSeenSecretByLock.get(lockId) ??
            (`0x${'00'.repeat(32)}` as Hex32);

          emitEvent({
            eventId,
            lockId,
            tx: txRef,
            removed: false,
            type: 'Claimed',
            secret,
          });
        } else if (event.name === 'Refunded') {
          const data = event.data as unknown as {
            lockState: PublicKey;
            owner: PublicKey;
            amount: anchorPkg.BN;
          };
          const lockId = data.lockState.toBase58();
          emitEvent({
            eventId,
            lockId,
            tx: txRef,
            removed: false,
            type: 'Refunded',
          });
        }
      } catch {
        // Not a decodable event for this program
      }
    }
  }

  async isFinal(tx: TxRef, lane: Lane): Promise<boolean> {
    if (tx.chain !== this.id) {
      return false;
    }

    try {
      const status = await this.connection.getSignatureStatus(tx.txId, {
        searchTransactionHistory: true,
      });

      if (!status || !status.value) {
        return false;
      }

      if (status.value.err) {
        throw new Error(
          `Transaction ${tx.txId} failed on chain: ${JSON.stringify(status.value.err)}`,
        );
      }

      const confirmation = status.value.confirmationStatus;
      if (lane === 'fast') {
        return confirmation === 'confirmed' || confirmation === 'finalized';
      }
      // lane === 'safe'
      return confirmation === 'finalized';
    } catch (err) {
      if (err instanceof Error && err.message.includes('failed on chain')) {
        throw err;
      }
      // Unavailable finality evidence must fail closed
      return false;
    }
  }

  async estimateRelayCostUsd(): Promise<number> {
    // Solana typical fee: 5,000 lamports = 0.000005 SOL (~$0.001)
    // Plus relayer amortized ATA rent allowance
    return 0.002;
  }
}

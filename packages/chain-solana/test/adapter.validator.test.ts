import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseOrderTerms,
  orderId,
  type OrderTerms,
  type Hex32,
} from '@ferry/core';
import { PROGRAM_ID } from '@ferry/htlc-solana';
import { SolanaChainAdapter } from '../src/adapter.js';

const RPC_URL = 'http://127.0.0.1:8899';
const LEDGER_DIR = '/tmp/ferry-chain-solana-ledger';
const SO_PATH = resolve(
  __dirname,
  '../../htlc-solana/target/deploy/ferry_htlc.so',
);

function sha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('SolanaChainAdapter', () => {
  let validatorProcess: ChildProcess | null = null;
  let connection: Connection;
  let payer: Keypair;
  let user: Keypair;
  let solver: Keypair;
  let mint: PublicKey;
  let userAta: PublicKey;
  let adapter: SolanaChainAdapter;
  let readOnlyAdapter: SolanaChainAdapter;

  beforeAll(async () => {
    connection = new Connection(RPC_URL, 'confirmed');
    let isRunning = false;
    try {
      await connection.getSlot();
      isRunning = true;
    } catch {
      // Validator not running yet
    }

    if (!isRunning) {
      if (existsSync(LEDGER_DIR)) {
        rmSync(LEDGER_DIR, { recursive: true, force: true });
      }

      validatorProcess = spawn(
        'solana-test-validator',
        [
          '--bpf-program',
          PROGRAM_ID.toBase58(),
          SO_PATH,
          '--reset',
          '--quiet',
          '--ledger',
          LEDGER_DIR,
        ],
        { stdio: 'ignore', detached: false },
      );

      let attempts = 0;
      while (attempts < 60) {
        try {
          await connection.getSlot();
          break;
        } catch {
          await sleep(500);
          attempts++;
        }
      }
      if (attempts >= 60) {
        throw new Error('solana-test-validator failed to start in 30s');
      }
    }

    payer = Keypair.generate();
    user = Keypair.generate();
    solver = Keypair.generate();

    // Airdrop SOL
    const airdropSig1 = await connection.requestAirdrop(
      payer.publicKey,
      10 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(airdropSig1, 'confirmed');

    // Give user 0.1 SOL for test setup, but we will test that user SOL delta = 0 on relayed lock
    const airdropSig2 = await connection.requestAirdrop(
      user.publicKey,
      LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(airdropSig2, 'confirmed');

    const airdropSig3 = await connection.requestAirdrop(
      solver.publicKey,
      LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(airdropSig3, 'confirmed');

    // Create mock USDC mint with 6 decimals
    mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      6,
      Keypair.generate(),
      { commitment: 'confirmed' },
    );

    // Setup User ATA with 1,000,000 units (1 USDC)
    const userAtaObj = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      user.publicKey,
      false,
      'confirmed',
    );
    userAta = userAtaObj.address;
    await mintTo(connection, payer, mint, userAta, payer, 1_000_000, [], {
      commitment: 'confirmed',
    });

    // Setup Solver ATA with 1,000,000 units for reverse flow
    const solverAtaObj = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      solver.publicKey,
      false,
      'confirmed',
    );
    await mintTo(
      connection,
      payer,
      mint,
      solverAtaObj.address,
      payer,
      1_000_000,
      [],
      { commitment: 'confirmed' },
    );

    // Instantiate SolanaChainAdapter with payer
    adapter = new SolanaChainAdapter({
      connection,
      programId: PROGRAM_ID,
      usdcMint: mint,
      payerKeypair: payer,
      relayerPublicKey: payer.publicKey,
    });

    // Instantiate browser-safe read-only adapter
    readOnlyAdapter = new SolanaChainAdapter({
      connection,
      programId: PROGRAM_ID,
      usdcMint: mint,
      relayerPublicKey: payer.publicKey,
    });
  }, 45000);

  afterAll(async () => {
    if (validatorProcess) {
      validatorProcess.kill();
      await sleep(1000);
    }
  });

  it('has correct id and asset metadata', () => {
    expect(adapter.id).toBe('solana');
    expect(readOnlyAdapter.id).toBe('solana');
    expect(adapter.assets).toHaveLength(2);
    expect(adapter.assets[0]?.symbol).toBe('USDC');
    expect(adapter.assets[0]?.decimals).toBe(6);
    expect(adapter.assets[1]?.symbol).toBe('USDT');
  });

  it('lockId is pure and deterministic', () => {
    const hashLock = `0x${'aa'.repeat(32)}` as Hex32;
    const id1 = adapter.lockId(user.publicKey.toBase58(), hashLock);
    const id2 = readOnlyAdapter.lockId(user.publicKey.toBase58(), hashLock);
    expect(id1).toBe(id2);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(30);
  });

  it('buildUserLock is browser-safe and produces valid partial transaction', async () => {
    const secret = randomBytes(32);
    const hashLock =
      `0x${Buffer.from(sha256(secret)).toString('hex')}` as Hex32;
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'ab'.repeat(32)}`,
      bchTokenAmount: 500_000n,
      counterAmount: 500_000n,
      counterChain: 'solana',
      counterNetworkId: 'localnet',
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: mint.toBase58(),
      },
      counterHtlc: PROGRAM_ID.toBase58(),
      userCounterAddress: user.publicKey.toBase58(),
      solverCounterAddress: solver.publicKey.toBase58(),
      userBchLockingBytecode: `0x76a914${'44'.repeat(20)}88ac`,
      solverBchLockingBytecode: `0x76a914${'66'.repeat(20)}88ac`,
      hashLock,
      counterDeadline: deadline,
      bchRefundHeight: 1000036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-solana-1',
      quoteExpiry: deadline - 3000,
    });

    // Use readOnlyAdapter to ensure browser safety (no payerKeypair)
    const unsignedLock = await readOnlyAdapter.buildUserLock(terms);
    expect(unsignedLock.chain).toBe('solana');
    expect(unsignedLock.orderId).toBe(orderId(terms));

    const payload = unsignedLock.payload as {
      transactionBase64: string;
      lockPda: string;
    };
    expect(payload.transactionBase64).toBeDefined();

    // Deserialize transaction
    const tx = Transaction.from(
      Buffer.from(payload.transactionBase64, 'base64'),
    );
    expect(tx.feePayer?.toBase58()).toBe(payer.publicKey.toBase58());

    // User signs as owner
    tx.partialSign(user);

    // Measure user SOL balance before relay
    const userSolBefore = await connection.getBalance(
      user.publicKey,
      'confirmed',
    );

    // Relayer relays lock
    const txRef = await adapter.relayLock({
      chain: 'solana',
      orderId: orderId(terms),
      payload: {
        transactionBase64: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
      },
    });

    expect(txRef.chain).toBe('solana');
    expect(txRef.txId).toBeDefined();

    // Verify user's SOL balance delta is strictly 0 lamports!
    const userSolAfter = await connection.getBalance(
      user.publicKey,
      'confirmed',
    );
    expect(userSolAfter).toBe(userSolBefore);

    // Read lock via browser-safe readOnlyAdapter
    const lockId = adapter.lockId(user.publicKey.toBase58(), hashLock);
    const lockState = await readOnlyAdapter.getLock(lockId);
    expect(lockState.status).toBe('locked');
    if (lockState.status === 'locked') {
      expect(lockState.owner).toBe(user.publicKey.toBase58());
      expect(lockState.recipient).toBe(solver.publicKey.toBase58());
      expect(lockState.amount).toBe(500_000n);
      expect(lockState.hashLock).toBe(hashLock);
      expect(lockState.deadline).toBe(deadline);
    }

    // Test idempotency: re-calling relayLock with same orderId returns cached tx
    const txRef2 = await adapter.relayLock({
      chain: 'solana',
      orderId: orderId(terms),
      payload: {
        transactionBase64: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
      },
    });
    expect(txRef2.txId).toBe(txRef.txId);

    // Claim the lock
    const claimTxRef = await adapter.claim(
      lockId,
      `0x${secret.toString('hex')}` as Hex32,
    );
    expect(claimTxRef.chain).toBe('solana');
    expect(claimTxRef.txId).toBeDefined();

    // Verify solver received tokens
    const solverAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        solver.publicKey,
      )
    ).address;
    const solverAccount = await getAccount(connection, solverAta, 'confirmed');
    expect(solverAccount.amount).toBe(1_500_000n);

    // Check lock state after claim
    const claimedState = await adapter.getLock(lockId);
    expect(claimedState.status).toBe('claimed');

    // Claim idempotency: re-claim returns existing tx
    const claimTxRef2 = await adapter.claim(
      lockId,
      `0x${secret.toString('hex')}` as Hex32,
    );
    expect(claimTxRef2.txId).toBe(claimTxRef.txId);
  }, 30000);

  it('lock and refund flow (reverse flow)', async () => {
    // 1. Premature refund rejection test with a safe +60s deadline
    const secretPremature = randomBytes(32);
    const hashLockPremature =
      `0x${Buffer.from(sha256(secretPremature)).toString('hex')}` as Hex32;
    const deadlinePremature = Math.floor(Date.now() / 1000) + 60;

    const termsPremature: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'cd'.repeat(32)}`,
      bchTokenAmount: 100_000n,
      counterAmount: 100_000n,
      counterChain: 'solana',
      counterNetworkId: 'localnet',
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: mint.toBase58(),
      },
      counterHtlc: PROGRAM_ID.toBase58(),
      userCounterAddress: user.publicKey.toBase58(),
      solverCounterAddress: payer.publicKey.toBase58(),
      userBchLockingBytecode: `0x76a914${'44'.repeat(20)}88ac`,
      solverBchLockingBytecode: `0x76a914${'66'.repeat(20)}88ac`,
      hashLock: hashLockPremature,
      counterDeadline: deadlinePremature,
      bchRefundHeight: 1000036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-solana-premature',
      quoteExpiry: deadlinePremature - 3000,
    });

    // Ensure payer has tokens to lock
    const payerAtaObj = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      payer.publicKey,
      false,
      'confirmed',
    );
    await mintTo(
      connection,
      payer,
      mint,
      payerAtaObj.address,
      payer,
      1_000_000,
      [],
      { commitment: 'confirmed' },
    );

    await adapter.lock(termsPremature);
    const lockIdPremature = adapter.lockId(
      payer.publicKey.toBase58(),
      hashLockPremature,
    );
    const lockStatePremature = await adapter.getLock(lockIdPremature);
    expect(lockStatePremature.status).toBe('locked');

    // Attempt refund before deadline expires
    await expect(adapter.refund(lockIdPremature)).rejects.toThrow(
      /Cannot refund before deadline/,
    );

    // 2. Expired refund test
    const secret = randomBytes(32);
    const hashLock =
      `0x${Buffer.from(sha256(secret)).toString('hex')}` as Hex32;
    const deadline = Math.floor(Date.now() / 1000) + 2;

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'ef'.repeat(32)}`,
      bchTokenAmount: 200_000n,
      counterAmount: 200_000n,
      counterChain: 'solana',
      counterNetworkId: 'localnet',
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: mint.toBase58(),
      },
      counterHtlc: PROGRAM_ID.toBase58(),
      userCounterAddress: user.publicKey.toBase58(),
      solverCounterAddress: payer.publicKey.toBase58(),
      userBchLockingBytecode: `0x76a914${'44'.repeat(20)}88ac`,
      solverBchLockingBytecode: `0x76a914${'66'.repeat(20)}88ac`,
      hashLock,
      counterDeadline: deadline,
      bchRefundHeight: 1000036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-solana-expired',
      quoteExpiry: deadline - 3000,
    });

    const lockTxRef = await adapter.lock(terms);
    expect(lockTxRef.chain).toBe('solana');

    const lockId = adapter.lockId(payer.publicKey.toBase58(), hashLock);
    const lockState = await adapter.getLock(lockId);
    expect(lockState.status).toBe('locked');

    // Wait 4 seconds for deadline to pass on test validator
    await sleep(4000);

    // Refund
    const refundTxRef = await adapter.refund(lockId);
    expect(refundTxRef.chain).toBe('solana');
    expect(refundTxRef.txId).toBeDefined();

    // Check lock state after refund
    const refundedState = await adapter.getLock(lockId);
    expect(refundedState.status).toBe('refunded');

    // Refund idempotency: re-refund returns existing tx
    const refundTxRef2 = await adapter.refund(lockId);
    expect(refundTxRef2.txId).toBe(refundTxRef.txId);
  }, 40000);

  it('watch subscribes to events and returns idempotent unsubscribe', async () => {
    const events: unknown[] = [];
    const unsubscribe = adapter.watch((event) => {
      events.push(event);
    });

    expect(typeof unsubscribe).toBe('function');
    // Calling unsubscribe multiple times is safe and idempotent
    unsubscribe();
    unsubscribe();
  });

  it('isFinal checks confirmation status by lane', async () => {
    // Check known tx
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 100,
      }),
    );
    const txSig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
    });

    const isFastFinal = await adapter.isFinal(
      { chain: 'solana', txId: txSig },
      'fast',
    );
    expect(isFastFinal).toBe(true);

    const invalidTxFinal = await adapter.isFinal(
      { chain: 'solana', txId: 'InvalidSignature11111111111111111' },
      'fast',
    );
    expect(invalidTxFinal).toBe(false);

    const wrongChainFinal = await adapter.isFinal(
      { chain: 'base', txId: txSig },
      'fast',
    );
    expect(wrongChainFinal).toBe(false);
  });

  it('estimateRelayCostUsd returns positive fee estimate', async () => {
    const cost = await adapter.estimateRelayCostUsd();
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1.0);
  });
});

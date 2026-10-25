import { describe, it, expect } from 'vitest';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import {
  parseOrderTerms,
  type Hex32,
  type OrderTerms,
  type TxRef,
} from '@ferry/core';
import { PROGRAM_ID, deriveLockPda } from '@ferry/htlc-solana';
import {
  SolanaChainAdapter,
  SOLANA_DEVNET_CONFIG,
  SOLANA_MAINNET_CONFIG,
  SOLANA_LOCALNET_CONFIG,
} from '../src/adapter.js';

describe('SolanaChainAdapter (Offline Suite)', () => {
  it('initializes with default devnet configuration and devnet mints', () => {
    const adapter = new SolanaChainAdapter();
    expect(adapter.id).toBe('solana');
    expect(adapter.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(adapter.usdcMint.toBase58()).toBe(SOLANA_DEVNET_CONFIG.usdcMint);
    expect(adapter.usdtMint.toBase58()).toBe(SOLANA_DEVNET_CONFIG.usdtMint);
    expect(adapter.assets).toHaveLength(2);
    expect(adapter.assets[0]).toEqual({
      symbol: 'USDC',
      decimals: 6,
      address: SOLANA_DEVNET_CONFIG.usdcMint,
      permit: false,
    });
    expect(adapter.assets[1]).toEqual({
      symbol: 'USDT',
      decimals: 6,
      address: SOLANA_DEVNET_CONFIG.usdtMint,
      permit: false,
    });
  });

  it('initializes with mainnet configuration and distinct mainnet mints', () => {
    const adapter = new SolanaChainAdapter({ network: 'mainnet' });
    expect(adapter.usdcMint.toBase58()).toBe(SOLANA_MAINNET_CONFIG.usdcMint);
    expect(adapter.usdcMint.toBase58()).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(adapter.usdtMint.toBase58()).toBe(SOLANA_MAINNET_CONFIG.usdtMint);
    expect(adapter.usdtMint.toBase58()).toBe(
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    );
    // Mainnet USDC differs from Devnet USDC
    expect(adapter.usdcMint.toBase58()).not.toBe(SOLANA_DEVNET_CONFIG.usdcMint);
    expect(adapter.assets[0]!.address).toBe(SOLANA_MAINNET_CONFIG.usdcMint);

    const localAdapter = new SolanaChainAdapter({ network: 'localnet' });
    expect(localAdapter.usdcMint.toBase58()).toBe(
      SOLANA_LOCALNET_CONFIG.usdcMint,
    );
  });

  it('allows explicit overrides for custom token mints, rpcUrl, and assets', () => {
    const customUsdc = Keypair.generate().publicKey;
    const customUsdt = Keypair.generate().publicKey;
    const customRpc = 'https://custom-solana-rpc.example.com';

    const adapter = new SolanaChainAdapter({
      rpcUrl: customRpc,
      usdcMint: customUsdc,
      usdtMint: customUsdt,
    });

    expect(adapter.usdcMint.toBase58()).toBe(customUsdc.toBase58());
    expect(adapter.usdtMint.toBase58()).toBe(customUsdt.toBase58());
    expect(adapter.assets[0]!.address).toBe(customUsdc.toBase58());
    expect(adapter.assets[1]!.address).toBe(customUsdt.toBase58());

    // Custom assets array override
    const customAssetAdapter = new SolanaChainAdapter({
      assets: [
        {
          symbol: 'USDC',
          decimals: 9,
          address: Keypair.generate().publicKey.toBase58(),
          permit: false,
        },
      ],
    });
    expect(customAssetAdapter.assets).toHaveLength(1);
    expect(customAssetAdapter.assets[0]!.symbol).toBe('USDC');
    expect(customAssetAdapter.assets[0]!.decimals).toBe(9);
  });

  it('derives lockId deterministically matching htlc-solana deriveLockPda', () => {
    const adapter = new SolanaChainAdapter();
    const owner = Keypair.generate().publicKey;
    const hashLock =
      '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex32;
    const hashLockBytes = Buffer.from(hashLock.slice(2), 'hex');

    const derived = adapter.lockId(owner.toBase58(), hashLock);
    const [expectedPda] = deriveLockPda(owner, hashLockBytes, PROGRAM_ID);

    expect(derived).toBe(expectedPda.toBase58());
  });

  it('produces distinct lockIds for different owners and hashLocks (collision resistance)', () => {
    const adapter = new SolanaChainAdapter();
    const owner1 = Keypair.generate().publicKey;
    const owner2 = Keypair.generate().publicKey;
    const hashLock1 =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex32;
    const hashLock2 =
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex32;

    const id1 = adapter.lockId(owner1.toBase58(), hashLock1);
    const id2 = adapter.lockId(owner2.toBase58(), hashLock1);
    const id3 = adapter.lockId(owner1.toBase58(), hashLock2);

    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
  });

  it('builds browser-safe partially signed user lock transaction with relayer as fee payer', async () => {
    const relayer = Keypair.generate();
    const user = Keypair.generate();
    const solver = Keypair.generate();
    const mint = Keypair.generate().publicKey;

    const mockConnection = {
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      }),
    };

    const adapter = new SolanaChainAdapter({
      relayerPublicKey: relayer.publicKey,
      connection: mockConnection as unknown as Connection,
    });

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      quoteId: 'test-solana-quote',
      quoteExpiry: Math.floor(Date.now() / 1000) + 300,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      hashLock:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      bchTokenCategory:
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      bchTokenAmount: 1000n,
      bchCarrySats: 3000n,
      bchMaxFee: 1000n,
      bchRefundHeight: 100000,
      userBchLockingBytecode: '0x1234',
      solverBchLockingBytecode: '0x1234',
      counterChain: 'solana',
      counterNetworkId: 'devnet',
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: mint.toBase58(),
      },
      counterAmount: 1_000_000n,
      counterDeadline: Math.floor(Date.now() / 1000) + 3600,
      userCounterAddress: user.publicKey.toBase58(),
      solverCounterAddress: solver.publicKey.toBase58(),
      counterHtlc: PROGRAM_ID.toBase58(),
    });

    const unsigned = await adapter.buildUserLock(terms);
    expect(unsigned.chain).toBe('solana');
    expect(unsigned.orderId).toBeDefined();

    const payload = unsigned.payload as {
      transactionBase64: string;
      owner: string;
      recipient: string;
      mint: string;
    };
    expect(payload.owner).toBe(user.publicKey.toBase58());
    expect(payload.recipient).toBe(solver.publicKey.toBase58());
    expect(payload.mint).toBe(mint.toBase58());

    // Deserialize transaction
    const tx = Transaction.from(
      Buffer.from(payload.transactionBase64, 'base64'),
    );
    expect(tx.feePayer?.toBase58()).toBe(relayer.publicKey.toBase58());
    expect(tx.instructions.length).toBeGreaterThan(0);
  });

  it('evaluates finality policy based on lane (fast=confirmed, safe=finalized)', async () => {
    let mockStatus: 'confirmed' | 'finalized' | null = 'confirmed';
    const mockConnection = {
      getSignatureStatus: async () => ({
        value: {
          confirmationStatus: mockStatus,
          err: null,
        },
      }),
    };

    const adapter = new SolanaChainAdapter({
      connection: mockConnection as unknown as Connection,
    });

    const ref = { chain: 'solana' as const, txId: 'sig1' };

    // fast lane accepts confirmed
    mockStatus = 'confirmed';
    expect(await adapter.isFinal(ref, 'fast')).toBe(true);

    // safe lane requires finalized
    expect(await adapter.isFinal(ref, 'safe')).toBe(false);

    // once finalized, safe lane returns true
    mockStatus = 'finalized';
    expect(await adapter.isFinal(ref, 'safe')).toBe(true);
    expect(await adapter.isFinal(ref, 'fast')).toBe(true);

    // non-solana chain returns false
    expect(
      await adapter.isFinal(
        { chain: 'bch', txId: 'sig1' } as unknown as TxRef,
        'fast',
      ),
    ).toBe(false);
  });

  it('estimates relay costs in USD with a conservative upper bound', async () => {
    const adapter = new SolanaChainAdapter();
    const costUsd = await adapter.estimateRelayCostUsd();
    expect(costUsd).toBeGreaterThan(0);
    expect(costUsd).toBeLessThan(1.0); // Solana tx costs should be well under $1
  });
});

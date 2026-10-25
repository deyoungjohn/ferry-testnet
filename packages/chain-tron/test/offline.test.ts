import { describe, it, expect, vi } from 'vitest';
import { sha256 } from 'viem';
import { parseOrderTerms } from '@ferry/core';
import type { Hex32, OrderTerms, TxRef } from '@ferry/core';
import {
  TronChainAdapter,
  toTronBase58,
  toTronHex,
  TRON_NILE_CONFIG,
  TRON_MAINNET_CONFIG,
  type TronTxInfo,
} from '../src/index.js';

describe('TronChainAdapter (Offline Suite)', () => {
  const dummyHashLock = sha256(`0x${'aa'.repeat(32)}` as Hex32);
  const sampleUserBase58 = 'TVDjrmj2T6gwLhFZvvCgeJBzVKAfe2vDXP';
  const sampleSolverBase58 = 'TEKLDZgXwyzDKpMQi3f43C2GFnZU3yhvQs';
  const sampleHtlcBase58 = 'TN2gn3GTuTHkZ3dmgitZr78VpSiwr4Epxs';
  const sampleUsdtBase58 = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';

  it('initializes with default Nile configuration and assets', () => {
    const adapter = new TronChainAdapter();
    expect(adapter.id).toBe('tron');
    expect(adapter.network).toBe('nile');
    expect(adapter.htlcAddress).toBe(TRON_NILE_CONFIG.htlcAddress);
    expect(adapter.usdtAddress).toBe(TRON_NILE_CONFIG.usdtAddress);
    expect(adapter.confirmations).toBe(19);

    expect(adapter.assets).toHaveLength(1);
    expect(adapter.assets[0]).toEqual({
      symbol: 'USDT',
      decimals: 6,
      address: TRON_NILE_CONFIG.usdtAddress,
      permit: false,
    });
  });

  it('initializes with mainnet configuration and distinct mainnet USDT', () => {
    const adapter = new TronChainAdapter({ network: 'mainnet' });
    expect(adapter.network).toBe('mainnet');
    expect(adapter.usdtAddress).toBe(TRON_MAINNET_CONFIG.usdtAddress);
    expect(adapter.assets[0]?.address).toBe(TRON_MAINNET_CONFIG.usdtAddress);
    expect(adapter.assets[0]?.permit).toBe(false);
  });

  it('allows explicit overrides for htlcAddress, rpcUrl, and custom assets', () => {
    const customHtlc = 'TLT5BuAG9Re3noRGbDGwfXjM1GV4wNW3Et';
    const adapter = new TronChainAdapter({
      htlcAddress: customHtlc,
      rpcUrl: 'http://127.0.0.1:9090',
      confirmations: 25,
    });
    expect(adapter.htlcAddress).toBe(customHtlc);
    expect(adapter.rpcUrl).toBe('http://127.0.0.1:9090');
    expect(adapter.confirmations).toBe(25);
  });

  it('correctly converts between Tron Base58 and EVM Hex address representations', () => {
    const hex = toTronHex(sampleHtlcBase58);
    expect(hex).toMatch(/^0x[0-9a-f]{40}$/);

    const roundtrip = toTronBase58(hex);
    expect(roundtrip).toBe(sampleHtlcBase58);

    // Handles 0x41... hex input
    const hexWith41 = `0x41${hex.slice(2)}`;
    expect(toTronBase58(hexWith41)).toBe(sampleHtlcBase58);

    // Already base58 input
    expect(toTronBase58(sampleUserBase58)).toBe(sampleUserBase58);
  });

  it('derives lockId deterministically matching on-chain FerryHTLC.sol', () => {
    const adapter = new TronChainAdapter();
    const lockId1 = adapter.lockId(sampleUserBase58, dummyHashLock);
    const lockId2 = adapter.lockId(sampleUserBase58, dummyHashLock);

    expect(lockId1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lockId1).toBe(lockId2);

    // Hex address equivalent produces identical lockId
    const hexAddr = toTronHex(sampleUserBase58);
    const lockIdHex = adapter.lockId(hexAddr, dummyHashLock);
    expect(lockIdHex).toBe(lockId1);
  });

  it('enforces collision resistance across distinct owners and hashLocks', () => {
    const adapter = new TronChainAdapter();
    const otherHashLock = sha256(`0x${'bb'.repeat(32)}` as Hex32);

    const idUser1 = adapter.lockId(sampleUserBase58, dummyHashLock);
    const idUser2 = adapter.lockId(sampleSolverBase58, dummyHashLock);
    const idDiffHash = adapter.lockId(sampleUserBase58, otherHashLock);

    expect(idUser1).not.toBe(idUser2);
    expect(idUser1).not.toBe(idDiffHash);
    expect(idUser2).not.toBe(idDiffHash);
  });

  it('builds browser-safe unsigned user lock transaction with approve and lock parameters', async () => {
    const adapter = new TronChainAdapter();
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'11'.repeat(32)}`,
      bchTokenAmount: 5000000n,
      counterAmount: 5000000n, // 5 USDT (6 decimals)
      counterChain: 'tron',
      counterNetworkId: 'nile',
      counterAsset: {
        symbol: 'USDT',
        decimals: 6,
        address: sampleUsdtBase58,
      },
      counterHtlc: sampleHtlcBase58,
      userCounterAddress: sampleUserBase58,
      userBchLockingBytecode: `0x76a914${'22'.repeat(20)}88ac`,
      solverCounterAddress: sampleSolverBase58,
      solverBchLockingBytecode: `0x76a914${'33'.repeat(20)}88ac`,
      hashLock: dummyHashLock,
      counterDeadline: deadline,
      bchRefundHeight: 1000036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-tron-test-01',
      quoteExpiry: Math.floor(Date.now() / 1000) + 60,
    });

    const unsigned = await adapter.buildUserLock(terms);
    expect(unsigned.chain).toBe('tron');
    expect(unsigned.orderId).toMatch(/^0x[0-9a-f]{64}$/);

    const payload = unsigned.payload as {
      htlcAddress: string;
      tokenAddress: string;
      recipientAddress: string;
      amount: string;
      hashLock: Hex32;
      deadline: number;
      approveTxParams: {
        contractAddress: string;
        functionSelector: string;
        parameter: unknown[];
      };
      lockTxParams: {
        contractAddress: string;
        functionSelector: string;
        parameter: unknown[];
      };
    };

    expect(payload.htlcAddress).toBe(sampleHtlcBase58);
    expect(payload.tokenAddress).toBe(sampleUsdtBase58);
    expect(payload.recipientAddress).toBe(sampleSolverBase58);
    expect(payload.amount).toBe('5000000');
    expect(payload.hashLock).toBe(dummyHashLock);
    expect(payload.deadline).toBe(deadline);

    // Verify approve params
    expect(payload.approveTxParams.functionSelector).toBe(
      'approve(address,uint256)',
    );
    expect(payload.approveTxParams.parameter).toEqual([
      sampleHtlcBase58,
      '5000000',
    ]);

    // Verify lock params
    expect(payload.lockTxParams.functionSelector).toBe(
      'lock(address,address,uint256,bytes32,uint64)',
    );
    expect(payload.lockTxParams.parameter).toEqual([
      sampleUsdtBase58,
      sampleSolverBase58,
      '5000000',
      dummyHashLock,
      deadline,
    ]);
  });

  it('relayLock returns known txId from signed payload idempotently', async () => {
    const adapter = new TronChainAdapter();
    const testTxId =
      'fe2d423b83b05e8de7a48127c3e7b6d5fa5d592d5e1b3792705996e83595f2d7';

    const signedLock = {
      chain: 'tron' as const,
      orderId: dummyHashLock,
      payload: {
        txId: testTxId,
      },
    };

    const res = await adapter.relayLock(signedLock);
    expect(res).toEqual({ chain: 'tron', txId: testTxId });
  });

  it('evaluates finality policy based on lane (fast=confirmed, safe=solidified)', async () => {
    const dummyTx: TxRef = {
      chain: 'tron',
      txId: '968818afa97dd6aff90055bc932f50be052351b273f2c3b012bd2813684441e8',
    };

    // Mock client with controlled block responses
    let mockTxInfo: TronTxInfo | null = {
      blockNumber: 100,
      receipt: { result: 'SUCCESS' },
    };
    let mockSolidifiedNumber = 95;
    let mockCurrentNumber = 105;

    const fakeClient = {
      trx: {
        getTransactionInfo: vi.fn(async () => mockTxInfo),
        getSolidifiedBlock: vi.fn(async () => ({
          block_header: { raw_data: { number: mockSolidifiedNumber } },
        })),
        getCurrentBlock: vi.fn(async () => ({
          block_header: { raw_data: { number: mockCurrentNumber } },
        })),
      },
      contract: vi.fn(),
      defaultAddress: { base58: sampleSolverBase58 },
    };

    const adapter = new TronChainAdapter({
      client: fakeClient as unknown as TronChainAdapter['client'],
      confirmations: 19,
    });

    // 1. Fast lane should be true once included in block (> 0)
    expect(await adapter.isFinal(dummyTx, 'fast')).toBe(true);

    // 2. Safe lane should be false when solidified (95) < txBlock (100) and depth (5) < 19
    expect(await adapter.isFinal(dummyTx, 'safe')).toBe(false);

    // 3. Safe lane becomes true once solidified (105) >= txBlock (100)
    mockSolidifiedNumber = 105;
    expect(await adapter.isFinal(dummyTx, 'safe')).toBe(true);

    // 4. Safe lane becomes true when depth (120 - 100 = 20) >= confirmations (19) even if solidified block call fails
    mockSolidifiedNumber = 90;
    mockCurrentNumber = 120;
    fakeClient.trx.getSolidifiedBlock = vi.fn(async () => {
      throw new Error('RPC error');
    });
    expect(await adapter.isFinal(dummyTx, 'safe')).toBe(true);

    // 5. Reverted tx throws on-chain error
    mockTxInfo = {
      blockNumber: 100,
      receipt: { result: 'FAILED' },
    };
    await expect(adapter.isFinal(dummyTx, 'fast')).rejects.toThrow(
      /failed on chain with result: FAILED/,
    );

    // 6. Non-existent tx returns false
    mockTxInfo = null;
    expect(await adapter.isFinal(dummyTx, 'fast')).toBe(false);
  });

  it('estimates relay costs in USD with energy and bandwidth pricing', async () => {
    const adapter = new TronChainAdapter();
    const cost = await adapter.estimateRelayCostUsd();
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(4.25, 1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  sha256,
  stringToHex,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { evmLockId, lockIntentTypedData, parseOrderTerms } from '@ferry/core';
import type { OrderTerms } from '@ferry/core';
import { EvmChainAdapter } from '../src/index.js';

const ANVIL_PORT = 8546;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil standard test accounts
const deployerAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const solverAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const userAccount = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);

describe('EvmChainAdapter on local anvil', () => {
  let anvilProcess: ChildProcess;
  let htlcAddress: `0x${string}`;
  let usdcAddress: `0x${string}`;
  let adapter: EvmChainAdapter;

  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(RPC_URL),
  });

  const deployerClient = createWalletClient({
    account: deployerAccount,
    chain: foundry,
    transport: http(RPC_URL),
  });

  const solverClient = createWalletClient({
    account: solverAccount,
    chain: foundry,
    transport: http(RPC_URL),
  });

  const userClient = createWalletClient({
    account: userAccount,
    chain: foundry,
    transport: http(RPC_URL),
  });

  beforeAll(async () => {
    // 1. Spawn anvil on port 8546
    anvilProcess = spawn('anvil', ['--port', String(ANVIL_PORT)], {
      stdio: 'pipe',
    });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = async () => {
        try {
          await publicClient.getBlockNumber();
          resolve();
        } catch {
          if (Date.now() - start > 10000)
            reject(new Error('Anvil startup timed out'));
          else setTimeout(check, 100);
        }
      };
      check();
    });

    // 2. Load compiled Foundry artifacts
    const rootDir = path.resolve(import.meta.dirname, '../../..');
    const htlcArtifactPath = path.join(
      rootDir,
      'packages/htlc-evm/out/FerryHTLC.sol/FerryHTLC.json',
    );
    const usdcArtifactPath = path.join(
      rootDir,
      'packages/htlc-evm/out/MockUSDCWithPermit.sol/MockUSDCWithPermit.json',
    );

    const htlcArtifact = JSON.parse(fs.readFileSync(htlcArtifactPath, 'utf8'));
    const usdcArtifact = JSON.parse(fs.readFileSync(usdcArtifactPath, 'utf8'));

    // 3. Deploy FerryHTLC
    const htlcDeployHash = await deployerClient.deployContract({
      abi: htlcArtifact.abi,
      bytecode: htlcArtifact.bytecode.object,
    });
    const htlcReceipt = await publicClient.waitForTransactionReceipt({
      hash: htlcDeployHash,
    });
    htlcAddress = htlcReceipt.contractAddress!;

    // 4. Deploy MockUSDCWithPermit
    const usdcDeployHash = await deployerClient.deployContract({
      abi: usdcArtifact.abi,
      bytecode: usdcArtifact.bytecode.object,
    });
    const usdcReceipt = await publicClient.waitForTransactionReceipt({
      hash: usdcDeployHash,
    });
    usdcAddress = usdcReceipt.contractAddress!;

    // 5. Mint tokens to user and solver, and approve HTLC
    const erc20Abi = parseAbi([
      'function mint(address to, uint256 amount) external',
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function nonces(address owner) external view returns (uint256)',
      'function name() external view returns (string)',
    ]);

    const mintAmount = 1000000000n; // 1,000 USDC (6 decimals)
    await deployerClient.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'mint',
      args: [userAccount.address, mintAmount],
    });
    await deployerClient.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'mint',
      args: [solverAccount.address, mintAmount],
    });

    await userClient.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [htlcAddress, mintAmount],
    });
    await solverClient.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [htlcAddress, mintAmount],
    });

    // 6. Instantiate EvmChainAdapter
    adapter = new EvmChainAdapter({
      chain: 'base',
      chainId: 31337,
      rpcUrl: RPC_URL,
      htlcAddress,
      usdcAddress,
      confirmations: 1,
      client: publicClient,
      walletClient: solverClient,
    });
  }, 20000);

  afterAll(async () => {
    if (anvilProcess) {
      anvilProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  it('exposes adapter metadata and computes lockId identically to core', () => {
    expect(adapter.id).toBe('base');
    expect(adapter.assets).toHaveLength(1);
    expect(adapter.assets[0]).toEqual({
      symbol: 'USDC',
      decimals: 6,
      address: usdcAddress.toLowerCase(),
      permit: true,
    });

    const hashLock = sha256(stringToHex('secret123'));
    const idA = adapter.lockId(userAccount.address, hashLock);
    const idB = evmLockId(userAccount.address, hashLock);
    expect(idA).toBe(idB);
  });

  it('builds user lock with EIP-2612 permit typed data and EIP-712 LockIntent', async () => {
    const secret = stringToHex('super-secret-preimage-32bytes-1');
    const hashLock = sha256(secret);

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'ab'.repeat(32)}`,
      bchTokenAmount: 2485n,
      counterAmount: 25000000n,
      counterChain: 'base',
      counterNetworkId: 31337,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: usdcAddress,
      },
      counterHtlc: htlcAddress,
      userCounterAddress: userAccount.address,
      userBchLockingBytecode: `0x76a914${'44'.repeat(20)}88ac`,
      solverCounterAddress: solverAccount.address,
      solverBchLockingBytecode: `0x76a914${'66'.repeat(20)}88ac`,
      hashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 1000036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-test-1',
      quoteExpiry: Math.floor(Date.now() / 1000) + 60,
    });

    const unsigned = await adapter.buildUserLock(terms);
    expect(unsigned.chain).toBe('base');
    expect(unsigned.orderId).toBeDefined();
    const payload = unsigned.payload as {
      permitTypedData?: unknown;
      lockIntentTypedData: unknown;
    };
    expect(payload.lockIntentTypedData).toBeDefined();
  });

  it('executes direct lock, verifies getLock, watches event, and claims with secret', async () => {
    const secret = `0x${'33'.repeat(32)}` as const;
    const hashLock = sha256(secret);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const lockId = adapter.lockId(solverAccount.address, hashLock);

    // Initial state absent
    const state0 = await adapter.getLock(lockId);
    expect(state0.status).toBe('absent');

    const observedEvents: string[] = [];
    const unsubscribe = adapter.watch((event) => {
      if (event.lockId === lockId) {
        observedEvents.push(event.type);
      }
    });

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'ab'.repeat(32)}`,
      bchTokenAmount: 2485n,
      counterAmount: 10000000n,
      counterChain: 'base',
      counterNetworkId: 31337,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: usdcAddress,
      },
      counterHtlc: htlcAddress,
      userCounterAddress: userAccount.address,
      userBchLockingBytecode: `0x76a914${'44'.repeat(20)}88ac`,
      solverCounterAddress: solverAccount.address,
      solverBchLockingBytecode: `0x76a914${'66'.repeat(20)}88ac`,
      hashLock,
      counterDeadline: deadline,
      bchRefundHeight: 1000036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-test-2',
      quoteExpiry: Math.floor(Date.now() / 1000) + 60,
    });

    // 1. Lock on-chain
    const lockTx = await adapter.lock(terms);
    expect(lockTx.chain).toBe('base');
    expect(lockTx.txId).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Idempotent repeat lock returns existing tx
    const lockTx2 = await adapter.lock(terms);
    expect(lockTx2.txId).toBe(lockTx.txId);

    // Verify state is locked
    const state1 = await adapter.getLock(lockId);
    expect(state1.status).toBe('locked');
    if (state1.status === 'locked') {
      expect(state1.amount).toBe(10000000n);
      expect(state1.hashLock).toBe(hashLock);
      expect(state1.recipient.toLowerCase()).toBe(
        userAccount.address.toLowerCase(),
      );
    }

    // 2. Check isFinal
    const finalSafe = await adapter.isFinal(lockTx, 'safe');
    expect(finalSafe).toBe(true);

    // 3. Claim with secret
    const claimTx = await adapter.claim(lockId, secret);
    expect(claimTx.txId).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Idempotent claim retry returns existing claim tx
    const claimTx2 = await adapter.claim(lockId, secret);
    expect(claimTx2.txId).toBe(claimTx.txId);

    // Verify state is claimed
    const state2 = await adapter.getLock(lockId);
    expect(state2.status).toBe('claimed');
    if (state2.status === 'claimed') {
      expect(state2.secret).toBe(secret);
    }

    // Test fallback when logs cannot be read or are unavailable
    // Clear in-memory secret cache
    // @ts-expect-error accessing private cache for test
    adapter.lastSeenSecretByLock.clear();
    // Temporarily stub getLogs to return empty (simulating RPC log lag/failure)
    const originalGetLogs = adapter['client'].getLogs;
    adapter['client'].getLogs = async () => [];

    const stateWithoutLog = await adapter.getLock(lockId);
    expect(stateWithoutLog.status).toBe('claimed');
    if (stateWithoutLog.status === 'claimed') {
      // Must be null, strictly NEVER 0x00...00!
      expect(stateWithoutLog.secret).toBeNull();
      expect(stateWithoutLog.secret).not.toBe(`0x${'00'.repeat(32)}`);
    }

    // Restore getLogs
    adapter['client'].getLogs = originalGetLogs;

    unsubscribe();
  });

  it('executes gasless relayLock with permit and intent signature', async () => {
    const secret = `0x${'55'.repeat(32)}` as const;
    const hashLock = sha256(secret);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
    const intentDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const amount = 5000000n; // 5 USDC
    const lockId = adapter.lockId(userAccount.address, hashLock);

    // Sign EIP-712 LockIntent with user wallet
    const intentMessage = {
      token: usdcAddress,
      recipient: solverAccount.address,
      amount,
      hashLock,
      deadline,
      intentDeadline,
    };
    const typedData = lockIntentTypedData(
      { chainId: 31337, verifyingContract: htlcAddress },
      intentMessage,
    );
    const intentSig = await userClient.signTypedData(typedData);

    // User already approved HTLC in beforeAll, so permit can be dummy 0
    const signedLock = {
      chain: 'base' as const,
      orderId: hashLock,
      payload: {
        owner: userAccount.address,
        token: usdcAddress,
        recipient: solverAccount.address,
        amount,
        hashLock,
        deadline,
        intentDeadline,
        intentSig,
        permitDeadline: 0n,
        v: 0,
        r: `0x${'00'.repeat(32)}` as const,
        s: `0x${'00'.repeat(32)}` as const,
      },
    };

    const relayTx = await adapter.relayLock(signedLock);
    expect(relayTx.txId).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Verify lock state
    const state = await adapter.getLock(lockId);
    expect(state.status).toBe('locked');

    // Idempotent retry returns same tx
    const retryTx = await adapter.relayLock(signedLock);
    expect(retryTx.txId).toBe(relayTx.txId);
  });

  it('rejects relayLock with a typed error when the owner cannot cover the amount', async () => {
    const hashLock = sha256(`0x${'56'.repeat(32)}` as const);
    const signedLock = {
      chain: 'base' as const,
      orderId: hashLock,
      payload: {
        owner: userAccount.address,
        token: usdcAddress,
        recipient: solverAccount.address,
        amount: 10n ** 30n,
        hashLock,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
        intentDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        intentSig: `0x${'00'.repeat(65)}` as const,
        permitDeadline: 0n,
        v: 0,
        r: `0x${'00'.repeat(32)}` as const,
        s: `0x${'00'.repeat(32)}` as const,
      },
    };
    await expect(adapter.relayLock(signedLock)).rejects.toMatchObject({
      name: 'RelayLockRejectedError',
      code: 'INSUFFICIENT_USER_BALANCE',
    });
  });

  it('maps a reverting relayLock to RELAY_LOCK_REVERTED', async () => {
    const hashLock = sha256(`0x${'57'.repeat(32)}` as const);
    const signedLock = {
      chain: 'base' as const,
      orderId: hashLock,
      payload: {
        owner: userAccount.address,
        token: usdcAddress,
        recipient: solverAccount.address,
        amount: 1n,
        hashLock,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
        intentDeadline: BigInt(Math.floor(Date.now() / 1000) - 60),
        intentSig: `0x${'00'.repeat(65)}` as const,
        permitDeadline: 0n,
        v: 0,
        r: `0x${'00'.repeat(32)}` as const,
        s: `0x${'00'.repeat(32)}` as const,
      },
    };
    await expect(adapter.relayLock(signedLock)).rejects.toMatchObject({
      code: 'RELAY_LOCK_REVERTED',
    });
  });

  it('handles refund after deadline and rejects premature refund', async () => {
    const secret = `0x${'77'.repeat(32)}` as const;
    const hashLock = sha256(secret);

    // Get current anvil time
    const block = await publicClient.getBlock();
    const deadline = Number(block.timestamp) + 10;
    const lockId = adapter.lockId(solverAccount.address, hashLock);

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'ab'.repeat(32)}`,
      bchTokenAmount: 2485n,
      counterAmount: 5000000n,
      counterChain: 'base',
      counterNetworkId: 31337,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: usdcAddress,
      },
      counterHtlc: htlcAddress,
      userCounterAddress: userAccount.address,
      userBchLockingBytecode: `0x76a914${'44'.repeat(20)}88ac`,
      solverCounterAddress: solverAccount.address,
      solverBchLockingBytecode: `0x76a914${'66'.repeat(20)}88ac`,
      hashLock,
      counterDeadline: deadline,
      bchRefundHeight: 1000036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-test-refund',
      quoteExpiry: Math.floor(Date.now() / 1000) + 60,
    });

    await adapter.lock(terms);

    // Premature refund should revert
    await expect(adapter.refund(lockId)).rejects.toThrow();

    // Fast-forward anvil time past deadline
    await (
      publicClient.request as (args: {
        method: string;
        params?: unknown[];
      }) => Promise<unknown>
    )({
      method: 'evm_increaseTime',
      params: [20],
    });
    await (
      publicClient.request as (args: {
        method: string;
        params?: unknown[];
      }) => Promise<unknown>
    )({
      method: 'evm_mine',
      params: [],
    });

    const refundTx = await adapter.refund(lockId);
    expect(refundTx.txId).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const state = await adapter.getLock(lockId);
    expect(state.status).toBe('refunded');

    // Idempotent retry returns existing refund tx
    const retryRefund = await adapter.refund(lockId);
    expect(retryRefund.txId).toBe(refundTx.txId);
  });

  it('estimates relay costs and handles invalid isFinal checks', async () => {
    const cost = await adapter.estimateRelayCostUsd();
    expect(cost).toBeGreaterThan(0);

    const nonExistent = await adapter.isFinal(
      { chain: 'base', txId: `0x${'00'.repeat(32)}` },
      'safe',
    );
    expect(nonExistent).toBe(false);
  });
});

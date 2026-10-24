import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  sha256,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseOrderTerms,
  orderId as computeOrderId,
  quoteExactIn,
} from '@ferry/core';
import type { OrderTerms } from '@ferry/core';
import { EvmChainAdapter } from '@ferry/chain-evm';
import {
  deriveHtlcAddresses,
  displayToInternalCategory,
  encodeHtlcParameters,
  buildClaimTransaction,
} from '@ferry/htlc-bch';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';

const ANVIL_PORT = 8546;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

describe('E2E-01: Forward swap on Anvil + Chipnet contracts', () => {
  let anvilProcess: ChildProcess;

  const deployerAccount = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const solverAccount = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const userAccount = privateKeyToAccount(
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  );

  let htlcAddress: `0x${string}`;
  let usdcAddress: `0x${string}`;
  let evmAdapter: EvmChainAdapter;
  let db: SolverDatabase;
  let bchClient: BchQuorumClient;
  let engine: SolverEngine;

  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(RPC_URL),
  });

  const deployerClient = createWalletClient({
    account: deployerAccount,
    chain: foundry,
    transport: http(RPC_URL),
  });

  const userClient = createWalletClient({
    account: userAccount,
    chain: foundry,
    transport: http(RPC_URL),
  });

  const solverClient = createWalletClient({
    account: solverAccount,
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

    // Deploy HTLC & USDC
    const htlcDeployHash = await deployerClient.deployContract({
      abi: htlcArtifact.abi,
      bytecode: htlcArtifact.bytecode.object,
    });
    const htlcReceipt = await publicClient.waitForTransactionReceipt({
      hash: htlcDeployHash,
    });
    htlcAddress = htlcReceipt.contractAddress!;

    const usdcDeployHash = await deployerClient.deployContract({
      abi: usdcArtifact.abi,
      bytecode: usdcArtifact.bytecode.object,
    });
    const usdcReceipt = await publicClient.waitForTransactionReceipt({
      hash: usdcDeployHash,
    });
    usdcAddress = usdcReceipt.contractAddress!;

    const erc20Abi = parseAbi([
      'function mint(address to, uint256 amount) external',
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function balanceOf(address account) external view returns (uint256)',
    ]);

    const mintAmount = 1000000000n; // 1,000 USDC
    await deployerClient.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'mint',
      args: [userAccount.address, mintAmount],
    });
    await userClient.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [htlcAddress, mintAmount],
    });

    evmAdapter = new EvmChainAdapter({
      chain: 'base',
      chainId: 31337,
      rpcUrl: RPC_URL,
      htlcAddress,
      usdcAddress,
      confirmations: 1,
      client: publicClient,
      walletClient: solverClient,
    });

    db = new SolverDatabase(':memory:');
    bchClient = new BchQuorumClient([
      'wss://chipnet.imaginary.cash:50004',
      'wss://blackie.c3-soft.com:50004',
    ]);
    await bchClient.connect();

    engine = new SolverEngine(
      db,
      evmAdapter,
      bchClient,
      solverAccount.address as `0x${string}`,
    );
  }, 25000);

  afterAll(async () => {
    bchClient.close();
    db.close();
    if (anvilProcess && !anvilProcess.killed) {
      anvilProcess.kill('SIGINT');
    }
  });

  it('completes forward 4-tx swap with verified reaction timings and balanced quote', async () => {
    const secret = `0x${'a1b2c3d4'.repeat(8)}` as const;
    const hashLock = sha256(secret);

    const amountIn = 10000000n; // 10.00 USDC
    const bchTokenAmount = quoteExactIn(amountIn, 6, 2, {
      spreadBps: 50,
      fixedFeeUsdMicros: 100000n,
    }); // 985 units = 9.85 tPUSD

    const now = Math.floor(Date.now() / 1000);
    const counterDeadline = now + 86400;
    const bchRefundHeight = 330036;

    const tpusdCat =
      '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac';

    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: tpusdCat,
      bchTokenAmount,
      counterAmount: amountIn,
      counterChain: 'base',
      counterNetworkId: 31337,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: usdcAddress,
      },
      counterHtlc: htlcAddress,
      userCounterAddress: userAccount.address,
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      solverCounterAddress: solverAccount.address,
      solverBchLockingBytecode:
        '0x76a914666666666666666666666666666666666666666688ac',
      hashLock,
      counterDeadline,
      bchRefundHeight,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-forward-e2e',
      quoteExpiry: now + 300,
    });

    const orderId = computeOrderId(terms);
    const orderRecord = {
      id: orderId,
      direction: 'COUNTER_TO_BCH' as const,
      status: 'QUOTED' as const,
      terms,
      hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.saveOrder(orderRecord);

    // TX 1: User EVM Lock
    const userAdapter = new EvmChainAdapter({
      chain: 'base',
      chainId: 31337,
      rpcUrl: RPC_URL,
      htlcAddress,
      usdcAddress,
      confirmations: 1,
      client: publicClient,
      walletClient: userClient,
    });

    const userLockTx = await userAdapter.lock(terms);
    expect(userLockTx.txId).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const evmLockId = evmAdapter.lockId(userAccount.address, hashLock);
    const lockState = await evmAdapter.getLock(evmLockId);
    expect(lockState.status).toBe('locked');
    if (lockState.status === 'locked') {
      expect(lockState.amount).toBe(amountIn);
    }

    // Engine detects USER_LOCK_FINAL
    const t0Detect = Date.now();
    engine.applyEvent(orderRecord, {
      type: 'USER_LOCK_FINAL',
      txId: userLockTx.txId,
    });

    // TX 2: Solver BCH Lock
    await engine.step();
    const t0Broadcast = Date.now();
    const detectToBroadcastMs = t0Broadcast - t0Detect;
    expect(detectToBroadcastMs).toBeLessThan(5000); // Measured latency bound well within 60s!

    let currentOrder = db.getOrder(orderId)!;
    expect(currentOrder.status).toBe('SOLVER_LOCK_BROADCAST');
    expect(currentOrder.solverLockTxId).toBeDefined();

    // Derive BCH HTLC contract parameters
    const bchParams = encodeHtlcParameters({
      recipientLockingBytecode: terms.userBchLockingBytecode,
      refundLockingBytecode: terms.solverBchLockingBytecode,
      hashLock: terms.hashLock,
      refundHeight: terms.bchRefundHeight,
      tokenCategory: displayToInternalCategory(terms.bchTokenCategory),
      tokenAmount: terms.bchTokenAmount,
      maxFee: terms.bchMaxFee,
    });
    const addresses = deriveHtlcAddresses(bchParams, 'chipnet');
    expect(addresses.p2sh32Address).toMatch(/^bchtest:p[0-9a-z]{60,65}$/);

    // TX 3: User BCH Claim (simulated / built spend)
    const claimTxResult = buildClaimTransaction({
      params: bchParams,
      utxo: {
        txid: currentOrder.solverLockTxId!,
        vout: 0,
        satoshis: 3000n,
      },
      secret,
    });
    expect(claimTxResult.txid).toMatch(/^[0-9a-fA-F]{64}$/);

    // Engine detects USER_CLAIM_SEEN with secret
    const t1Detect = Date.now();
    engine.applyEvent(currentOrder, {
      type: 'USER_CLAIM_SEEN',
      txId: claimTxResult.txid,
      secret,
    });

    // TX 4: Solver EVM Claim
    await engine.step();
    const t1Broadcast = Date.now();
    const claimLatencyMs = t1Broadcast - t1Detect;
    expect(claimLatencyMs).toBeLessThan(5000);

    currentOrder = db.getOrder(orderId)!;
    // Solver broadcast and finalized EVM claim, reaching DONE
    expect(currentOrder.status).toBe('DONE');
    expect(currentOrder.solverClaimTxId).toBeDefined();

    const finalEvmLockState = await evmAdapter.getLock(evmLockId);
    expect(finalEvmLockState.status).toBe('claimed');

    // Verify balances match quote
    const erc20Abi = parseAbi([
      'function balanceOf(address account) external view returns (uint256)',
    ]);
    const solverBalance = await publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [solverAccount.address],
    });
    expect(solverBalance).toBe(amountIn); // Solver received 10.00 USDC
  }, 30000);
});

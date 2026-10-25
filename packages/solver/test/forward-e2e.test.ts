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
import { deriveBchKeyDetails } from '../src/bch/lock-builder.js';

const ANVIL_PORT = 8546;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Needs anvil, live chipnet Fulcrum and the lab keys in .env.local, so it is
// opt-in: FERRY_LIVE_TESTS=1 pnpm --filter @ferry/solver test
describe.skipIf(!process.env.FERRY_LIVE_TESTS)(
  'E2E-01: Forward swap on Anvil + Chipnet contracts',
  () => {
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
    let solverBchWif: string;
    let userBchWif: string;

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
      // Read .env.local
      let dir = process.cwd();
      while (
        !fs.existsSync(path.join(dir, '.env.local')) &&
        path.dirname(dir) !== dir
      ) {
        dir = path.dirname(dir);
      }
      const envLocalContent = fs.readFileSync(
        path.join(dir, '.env.local'),
        'utf8',
      );
      const solverMatch = envLocalContent.match(/SOLVER_BCH_WIF=([^\r\n]+)/);
      const userMatch = envLocalContent.match(/USER_BCH_WIF=([^\r\n]+)/);
      if (!solverMatch || !solverMatch[1] || !userMatch || !userMatch[1]) {
        throw new Error(
          'SOLVER_BCH_WIF or USER_BCH_WIF missing from .env.local',
        );
      }
      solverBchWif = solverMatch[1].trim();
      userBchWif = userMatch[1].trim();

      // Start local anvil on port 8546
      anvilProcess = spawn('anvil', ['--port', String(ANVIL_PORT)], {
        stdio: 'pipe',
      });

      // Wait for anvil to become healthy
      let connected = false;
      for (let i = 0; i < 40; i++) {
        try {
          await publicClient.getBlockNumber();
          connected = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!connected) {
        throw new Error(`Could not connect to Anvil on port ${ANVIL_PORT}`);
      }

      const rootDir = dir;
      const htlcArtifactPath = path.join(
        rootDir,
        'packages/htlc-evm/out/FerryHTLC.sol/FerryHTLC.json',
      );
      const usdcArtifactPath = path.join(
        rootDir,
        'packages/htlc-evm/out/MockUSDCWithPermit.sol/MockUSDCWithPermit.json',
      );

      const htlcArtifact = JSON.parse(
        fs.readFileSync(htlcArtifactPath, 'utf8'),
      );
      const usdcArtifact = JSON.parse(
        fs.readFileSync(usdcArtifactPath, 'utf8'),
      );

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
        solverBchWif,
      );
    }, 35000);

    afterAll(async () => {
      if (engine) engine.stop();
      if (bchClient) bchClient.close();
      if (db) db.close();
      if (anvilProcess && !anvilProcess.killed) {
        anvilProcess.kill('SIGINT');
      }
    });

    it('completes forward 4-tx swap with verified reaction timings and balanced quote', async () => {
      const secret = `0x${'a1b2c3d4'.repeat(8)}` as const;
      const hashLock = sha256(secret);

      const amountIn = 10000000n; // 10.00 USDC
      const bchTokenAmount = quoteExactIn(amountIn, 6, 2, {
        spreadBps: 40,
        fixedFeeUsdMicros: 50000n,
      }); // 991 units = 9.91 tPUSD

      const now = Math.floor(Date.now() / 1000);
      const counterDeadline = now + 86400;

      // Use current Chipnet tip for bchRefundHeight to ensure Invariant F passes
      const tip = bchClient.getQuorumStatus().quorumTip || 330000;
      const bchRefundHeight = tip + 36;

      const tpusdCat =
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac';

      const solverKeys = await deriveBchKeyDetails(solverBchWif);
      const userKeys = await deriveBchKeyDetails(userBchWif);

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
        userBchLockingBytecode: `0x${userKeys.p2pkhBytecodeHex}`,
        solverCounterAddress: solverAccount.address,
        solverBchLockingBytecode: `0x${solverKeys.p2pkhBytecodeHex}`,
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

      // TX 2: Real Solver BCH Lock on Chipnet
      await engine.step();
      const t0Broadcast = Date.now();
      const detectToBroadcastMs = t0Broadcast - t0Detect;
      expect(detectToBroadcastMs).toBeLessThan(10000);

      let currentOrder = db.getOrder(orderId)!;
      expect(currentOrder.status).toBe('SOLVER_LOCK_BROADCAST');
      expect(currentOrder.solverLockTxId).toBeDefined();
      expect(currentOrder.solverLockTxId).toMatch(/^[0-9a-fA-F]{64}$/);

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

      // TX 3: Real User BCH Claim broadcast on Chipnet!
      const claimTxResult = buildClaimTransaction({
        params: bchParams,
        utxo: {
          txid: currentOrder.solverLockTxId!,
          vout: 0,
          satoshis: terms.bchCarrySats,
        },
        secret,
      });

      const userClaimTxId = await bchClient.broadcast(claimTxResult.txHex);
      expect(userClaimTxId).toBe(claimTxResult.txid);

      // Engine detects USER_CLAIM_SEEN with secret
      const t1Detect = Date.now();
      engine.applyEvent(currentOrder, {
        type: 'USER_CLAIM_SEEN',
        txId: userClaimTxId,
        secret,
      });

      // TX 4: Solver EVM Claim
      await engine.step();
      const t1Broadcast = Date.now();
      const claimLatencyMs = t1Broadcast - t1Detect;
      expect(claimLatencyMs).toBeLessThan(5000);

      currentOrder = db.getOrder(orderId)!;
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
    }, 60000);
  },
);

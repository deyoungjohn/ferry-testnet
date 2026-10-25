import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  sha256,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { spawn } from 'node:child_process';
import { EvmChainAdapter } from '@ferry/chain-evm';
import { parseOrderTerms, orderId as computeOrderId } from '@ferry/core';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { deriveBchKeyDetails } from '../src/bch/lock-builder.js';

async function measureReactionLatency() {
  console.log(
    '=== Measuring Solver Detect-to-Broadcast Reaction Latency (≥ 10 swaps) ===\n',
  );

  // Read .env.local
  let dir = process.cwd();
  while (
    !fs.existsSync(path.join(dir, '.env.local')) &&
    path.dirname(dir) !== dir
  ) {
    dir = path.dirname(dir);
  }
  const envContent = fs.readFileSync(path.join(dir, '.env.local'), 'utf8');
  const getEnv = (key: string) => {
    const m = envContent.match(new RegExp(`${key}=([^\\r\\n]+)`));
    return m && m[1] ? m[1].trim() : undefined;
  };
  const solverBchWif = getEnv('SOLVER_BCH_WIF')!;
  const userBchWif = getEnv('USER_BCH_WIF')!;

  const ANVIL_PORT = 8546;
  const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

  const anvil = spawn('anvil', ['--port', String(ANVIL_PORT)], {
    stdio: 'pipe',
  });
  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(RPC_URL),
  });

  for (let i = 0; i < 40; i++) {
    try {
      await publicClient.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const deployerAccount = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const solverAccount = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const userAccount = privateKeyToAccount(
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  );

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

  const rootDir = dir;
  const htlcArtifact = JSON.parse(
    fs.readFileSync(
      path.join(rootDir, 'packages/htlc-evm/out/FerryHTLC.sol/FerryHTLC.json'),
      'utf8',
    ),
  );
  const usdcArtifact = JSON.parse(
    fs.readFileSync(
      path.join(
        rootDir,
        'packages/htlc-evm/out/MockUSDCWithPermit.sol/MockUSDCWithPermit.json',
      ),
      'utf8',
    ),
  );

  const htlcDeployHash = await deployerClient.deployContract({
    abi: htlcArtifact.abi,
    bytecode: htlcArtifact.bytecode.object,
  });
  const htlcReceipt = await publicClient.waitForTransactionReceipt({
    hash: htlcDeployHash,
  });
  const htlcAddress = htlcReceipt.contractAddress!;

  const usdcDeployHash = await deployerClient.deployContract({
    abi: usdcArtifact.abi,
    bytecode: usdcArtifact.bytecode.object,
  });
  const usdcReceipt = await publicClient.waitForTransactionReceipt({
    hash: usdcDeployHash,
  });
  const usdcAddress = usdcReceipt.contractAddress!;

  const erc20Abi = parseAbi([
    'function mint(address, uint256) external',
    'function approve(address, uint256) external returns (bool)',
  ]);
  await deployerClient.writeContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'mint',
    args: [userAccount.address, 1000000000n],
  });
  await userClient.writeContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [htlcAddress, 1000000000n],
  });

  const evmAdapter = new EvmChainAdapter({
    chain: 'base',
    chainId: 31337,
    rpcUrl: RPC_URL,
    htlcAddress,
    usdcAddress,
    confirmations: 1,
    client: publicClient,
    walletClient: solverClient,
  });

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

  const bchClient = new BchQuorumClient([
    'wss://chipnet.imaginary.cash:50004',
    'wss://blackie.c3-soft.com:50004',
  ]);
  await bchClient.connect();

  const solverKeys = await deriveBchKeyDetails(solverBchWif);
  const userKeys = await deriveBchKeyDetails(userBchWif);

  const db = new SolverDatabase(':memory:');
  const engine = new SolverEngine(
    db,
    evmAdapter,
    bchClient,
    solverAccount.address as `0x${string}`,
    solverBchWif,
  );

  const latenciesMs: number[] = [];
  const iterations = 10;

  for (let i = 0; i < iterations; i++) {
    const secret =
      `0x${i.toString(16).padStart(2, '0')}${'cc'.repeat(31)}` as const;
    const hashLock = sha256(secret);

    const now = Math.floor(Date.now() / 1000);
    const tip = bchClient.getQuorumStatus().quorumTip || 329000;
    const terms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory:
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
      bchTokenAmount: 94n,
      counterAmount: 1000000n,
      counterChain: 'base',
      counterNetworkId: 31337,
      counterAsset: { symbol: 'USDC', decimals: 6, address: usdcAddress },
      counterHtlc: htlcAddress,
      userCounterAddress: userAccount.address,
      userBchLockingBytecode: `0x${userKeys.p2pkhBytecodeHex}`,
      solverCounterAddress: solverAccount.address,
      solverBchLockingBytecode: `0x${solverKeys.p2pkhBytecodeHex}`,
      hashLock,
      counterDeadline: now + 86400,
      bchRefundHeight: tip + 36,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: `quote-bench-${i}`,
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

    const lockTx = await userAdapter.lock(terms);
    const t0Detect = Date.now();
    engine.applyEvent(orderRecord, {
      type: 'USER_LOCK_FINAL',
      txId: lockTx.txId,
    });

    // Step engine to trigger solver BCH broadcast via real Fulcrum RPC
    await engine.step();
    const t0Broadcast = Date.now();
    const latency = t0Broadcast - t0Detect;
    latenciesMs.push(latency);
    console.log(
      `Swap ${i + 1}/${iterations}: detect-to-broadcast latency = ${latency} ms (tx: ${db.getOrder(orderId)?.solverLockTxId?.slice(0, 16)}...)`,
    );
  }

  latenciesMs.sort((a, b) => a - b);
  const min = latenciesMs[0]!;
  const max = latenciesMs[latenciesMs.length - 1]!;
  const median = latenciesMs[Math.floor(latenciesMs.length / 2)]!;
  const avg = Math.round(
    latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length,
  );
  const p95 = latenciesMs[Math.floor(latenciesMs.length * 0.95)]!;

  console.log('\n=== REACTION LATENCY MEASUREMENT RESULTS ===');
  console.log(`Iterations:  ${iterations}`);
  console.log(`Min:         ${min} ms`);
  console.log(`Median:      ${median} ms`);
  console.log(`Average:     ${avg} ms`);
  console.log(`P95:         ${p95} ms`);
  console.log(`Max:         ${max} ms`);

  anvil.kill('SIGINT');
  bchClient.close();
  db.close();

  return { min, median, avg, p95, max, latenciesMs };
}

measureReactionLatency().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});

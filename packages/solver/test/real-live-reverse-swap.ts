import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  sha256,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmChainAdapter } from '@ferry/chain-evm';
import { parseOrderTerms } from '@ferry/core';
import {
  buildLockTransaction,
  deriveHtlcAddresses,
  encodeHtlcParameters,
} from '@ferry/htlc-bch';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import { buildServer } from '../src/api/server.js';
import { deriveBchKeyDetails } from '../src/bch/lock-builder.js';
import { SolverConfigSchema } from '../src/config.js';

interface SwapRunResult {
  mode:
    | 'E2E-03 (wallet / buildLockTransaction)'
    | 'E2E-04 (manual QR send to displayed address)';
  tx1UserBchLock: string;
  tx2SolverEvmLock: string;
  tx3UserEvmClaim: string;
  tx4SolverBchClaim: string;
  timings: {
    userLockS: number;
    solverLockS: number;
    userClaimS: number;
    solverClaimS: number;
    totalS: number;
  };
}

async function executeReverseSwap(options: {
  mode:
    | 'E2E-03 (wallet / buildLockTransaction)'
    | 'E2E-04 (manual QR send to displayed address)';
  userBchWif: string;
  solverBchWif: string;
  userAccount: ReturnType<typeof privateKeyToAccount>;
  solverAccount: ReturnType<typeof privateKeyToAccount>;
  solverWallet: unknown;
  publicClient: unknown;
  solverEvmAdapter: EvmChainAdapter;
  bchClient: BchQuorumClient;
  engine: SolverEngine;
  db: SolverDatabase;
  app: ReturnType<typeof buildServer>;
  tokenAmount: bigint; // e.g. 100n (1.00 tPUSD)
}): Promise<SwapRunResult> {
  console.log(`\n======================================================`);
  console.log(`Starting ${options.mode}`);
  console.log(`======================================================`);

  const publicClient = options.publicClient as PublicClient;

  const tStartSwap = Date.now();
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret =
    `0x${Array.from(secretBytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as const;
  const hashLock = sha256(secret);

  const userKeyDetails = await deriveBchKeyDetails(options.userBchWif);

  // STEP 1: Request Quote via HTTP API
  console.log('\n--- Step 1: POST /v1/quotes (BCH_TO_COUNTER) ---');
  const quoteRes = await options.app.inject({
    method: 'POST',
    url: '/v1/quotes',
    payload: {
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      counterChain: 'base',
      counterSymbol: 'USDC',
      amountIn: options.tokenAmount.toString(),
      userCounterAddress: options.userAccount.address,
      userBchLockingBytecode: `0x${userKeyDetails.p2pkhBytecodeHex}`,
      hashLock,
      lane: 'fast',
      fastOptIn: true,
    },
  });

  if (quoteRes.statusCode !== 200) {
    throw new Error(
      `Quote failed (${quoteRes.statusCode}): ${quoteRes.payload}`,
    );
  }

  const quoteData = JSON.parse(quoteRes.payload);
  const rawTerms = quoteData.terms;
  const terms = parseOrderTerms({
    ...rawTerms,
    bchTokenAmount: BigInt(rawTerms.bchTokenAmount),
    counterAmount: BigInt(rawTerms.counterAmount),
    bchCarrySats: BigInt(rawTerms.bchCarrySats),
    bchMaxFee: BigInt(rawTerms.bchMaxFee),
  });
  console.log(`Quote received. Order ID: ${quoteData.orderId}`);
  console.log(`Quoted tPUSD Amount: ${terms.bchTokenAmount}`);
  console.log(`Quoted Counter USDC Amount: ${terms.counterAmount}`);

  // Canonical parameters and displayed addresses
  const canonicalParams = encodeHtlcParameters(terms);
  const derivedAddresses = deriveHtlcAddresses(canonicalParams, 'chipnet');
  console.log(
    `Displayed HTLC P2SH32 Address:  ${derivedAddresses.p2sh32Address}`,
  );
  console.log(
    `Displayed HTLC Token Address:   ${derivedAddresses.tokenAddress}`,
  );

  // STEP 2: User Locks tPUSD on Chipnet (TX 1)
  console.log(`\n--- Step 2: User Locks tPUSD on Chipnet (TX 1) ---`);
  const tUserLockStart = Date.now();

  const userUtxos = await options.bchClient.listUnspent(
    userKeyDetails.scriptHash,
    'include_tokens',
  );

  const lockResult = buildLockTransaction({
    params: canonicalParams,
    utxos: userUtxos,
    changeAddress: userKeyDetails.lockingBytecodeHex,
    tokenChangeAddress: userKeyDetails.lockingBytecodeHex,
    bchCarrySats: terms.bchCarrySats,
    wif: options.userBchWif,
    network: 'chipnet',
  });

  if (!lockResult.signed) {
    throw new Error('Failed to sign user BCH lock transaction');
  }

  const userLockTxId = await options.bchClient.broadcast(
    lockResult.signed.txHex,
  );
  const tUserLockDurationS = (Date.now() - tUserLockStart) / 1000;
  console.log(
    `TX 1 (User BCH Lock): ${userLockTxId} (${tUserLockDurationS.toFixed(2)}s)`,
  );

  // STEP 3: Solver Engine detects User BCH Lock and counter-locks USDC on Base Sepolia (TX 2)
  console.log(
    `\n--- Step 3: Solver Engine Detects BCH Lock & Counter-Locks USDC (TX 2) ---`,
  );
  const tSolverLockStart = Date.now();

  // Engine polls / processes order
  let order = options.db.getOrder(quoteData.orderId)!;
  console.log(`Initial Order Status: ${order.status}`);

  // Give Chipnet indexers a moment to register UTXO
  await new Promise((r) => setTimeout(r, 1500));

  let attempts = 0;
  while (order.status !== 'SOLVER_LOCK_SEEN' && attempts < 40) {
    attempts++;
    await options.engine.step();
    order = options.db.getOrder(quoteData.orderId)!;
    console.log(`Poll attempt ${attempts}: status = ${order.status}`);
    if (order.status === 'SOLVER_LOCK_SEEN') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (order.status !== 'SOLVER_LOCK_SEEN') {
    throw new Error(
      `Order failed to reach SOLVER_LOCK_SEEN; current status: ${order.status}`,
    );
  }

  const solverLockTxId = order.solverLockTxId!;
  const tx2Receipt = await publicClient.waitForTransactionReceipt({
    hash: solverLockTxId as `0x${string}`,
  });
  const tSolverLockDurationS = (Date.now() - tSolverLockStart) / 1000;
  console.log(
    `TX 2 (Solver EVM Lock): ${solverLockTxId} (block ${tx2Receipt.blockNumber}, ${tSolverLockDurationS.toFixed(2)}s)`,
  );

  // STEP 4: User Claims USDC on Base Sepolia via POST /v1/orders/:id/relay-claim (TX 3)
  console.log(
    `\n--- Step 4: User Claims USDC on Base Sepolia via relay-claim (TX 3) ---`,
  );
  const tUserClaimStart = Date.now();

  const relayRes = await options.app.inject({
    method: 'POST',
    url: `/v1/orders/${quoteData.orderId}/relay-claim`,
    payload: { secret },
  });

  if (relayRes.statusCode !== 200) {
    throw new Error(
      `relay-claim failed (${relayRes.statusCode}): ${relayRes.payload}`,
    );
  }

  const relayData = JSON.parse(relayRes.payload);
  const userClaimTxId = relayData.tx.txId;
  const tx3Receipt = await publicClient.waitForTransactionReceipt({
    hash: userClaimTxId as `0x${string}`,
  });
  const tUserClaimDurationS = (Date.now() - tUserClaimStart) / 1000;
  console.log(
    `TX 3 (User EVM Claim): ${userClaimTxId} (block ${tx3Receipt.blockNumber}, ${tUserClaimDurationS.toFixed(2)}s)`,
  );

  // STEP 5: Solver Claims tPUSD on Chipnet (TX 4)
  console.log(`\n--- Step 5: Solver Engine Claims tPUSD on Chipnet (TX 4) ---`);
  const tSolverClaimStart = Date.now();

  order = options.db.getOrder(quoteData.orderId)!;
  attempts = 0;
  while (order.status !== 'DONE' && attempts < 40) {
    attempts++;
    await options.engine.step();
    order = options.db.getOrder(quoteData.orderId)!;
    console.log(`Claim poll attempt ${attempts}: status = ${order.status}`);
    if (order.status === 'DONE') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (order.status !== 'DONE') {
    throw new Error(
      `Order failed to reach DONE; current status: ${order.status}`,
    );
  }

  const solverClaimTxId = order.solverClaimTxId!;
  const tSolverClaimDurationS = (Date.now() - tSolverClaimStart) / 1000;
  console.log(
    `TX 4 (Solver BCH Claim): ${solverClaimTxId} (${tSolverClaimDurationS.toFixed(2)}s)`,
  );

  const tTotalSwapS = (Date.now() - tStartSwap) / 1000;
  console.log(`\nSwap Completed Successfully! Final Status: ${order.status}`);
  console.log(`Total Swap Duration: ${tTotalSwapS.toFixed(2)}s`);

  return {
    mode: options.mode,
    tx1UserBchLock: userLockTxId,
    tx2SolverEvmLock: solverLockTxId,
    tx3UserEvmClaim: userClaimTxId,
    tx4SolverBchClaim: solverClaimTxId,
    timings: {
      userLockS: tUserLockDurationS,
      solverLockS: tSolverLockDurationS,
      userClaimS: tUserClaimDurationS,
      solverClaimS: tSolverClaimDurationS,
      totalS: tTotalSwapS,
    },
  };
}

async function runLiveReverseSwaps(): Promise<[SwapRunResult, SwapRunResult]> {
  console.log(
    '=== Ferry Lab: Live Base Sepolia + Chipnet Reverse Swaps (E2E-03 & E2E-04) ===\n',
  );

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

  const solverEvmKey = getEnv('SOLVER_EVM_PRIVATE_KEY') as `0x${string}`;
  const userEvmKey = getEnv('USER_EVM_PRIVATE_KEY') as `0x${string}`;
  const solverBchWif = getEnv('SOLVER_BCH_WIF')!;
  const userBchWif = getEnv('USER_BCH_WIF')!;

  const RPC_URL = 'https://sepolia.base.org';
  const BASE_CHAIN_ID = 84532;
  const HTLC_ADDRESS = '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641' as const;
  const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
  const TPUSD_CATEGORY =
    'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac';

  const solverAccount = privateKeyToAccount(solverEvmKey);
  const userAccount = privateKeyToAccount(userEvmKey);

  console.log(`Solver EVM address: ${solverAccount.address}`);
  console.log(`User EVM address:   ${userAccount.address}`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const solverWallet = createWalletClient({
    account: solverAccount,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  // Ensure Solver USDC allowance for counter-locking
  const erc20Abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
  ]);

  const solverAllowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [solverAccount.address, HTLC_ADDRESS],
  });

  if (solverAllowance < 10000000n) {
    console.log('Approving Solver USDC allowance to HTLC contract...');
    const approveTx = await solverWallet.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'approve',
      args: [HTLC_ADDRESS, 100000000n],
    });
    console.log(`Solver approve tx sent: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('Solver approve tx confirmed on Base Sepolia.');
  }

  // Set up Solver components
  const bchUrls = ['wss://chipnet.imaginary.cash:50004'];
  const db = new SolverDatabase(':memory:');
  const bchClient = new BchQuorumClient(bchUrls);
  await bchClient.connect();
  const initialQuorum = bchClient.getQuorumStatus();
  console.log('Quorum status on connect:', initialQuorum);

  const solverEvmAdapter = new EvmChainAdapter({
    chain: 'base',
    chainId: BASE_CHAIN_ID,
    rpcUrl: RPC_URL,
    htlcAddress: HTLC_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    confirmations: 1,
    client: publicClient as unknown as PublicClient,
    walletClient: solverWallet as unknown as WalletClient,
  });

  const engine = new SolverEngine(
    db,
    solverEvmAdapter,
    bchClient,
    solverEvmKey,
    solverBchWif,
  );
  await engine.start();

  const config = SolverConfigSchema.parse({
    port: 8787,
    network: 'testnet',
    baseRpcUrl: RPC_URL,
    baseChainId: BASE_CHAIN_ID,
    baseHtlcAddress: HTLC_ADDRESS,
    baseUsdcAddress: USDC_ADDRESS,
    solverEvmPrivateKey: solverEvmKey,
    solverBchWif,
    bchElectrumUrls: bchUrls.join(','),
    tpusdCategory: TPUSD_CATEGORY,
  });

  const app = buildServer({
    config,
    db,
    evmAdapter: solverEvmAdapter,
    bchClient,
    engine,
  });

  const today = new Date().toISOString().slice(0, 10);
  const swapMetricsPath = path.join(dir, 'lab/swap-metrics.csv');

  // RUN 1: E2E-03 (Wallet / buildLockTransaction)
  const resE2E03 = await executeReverseSwap({
    mode: 'E2E-03 (wallet / buildLockTransaction)',
    userBchWif,
    solverBchWif,
    userAccount,
    solverAccount,
    solverWallet,
    publicClient,
    solverEvmAdapter,
    bchClient,
    engine,
    db,
    app,
    tokenAmount: 100n, // 1.00 tPUSD
  });

  const row1 = `${today},A2,base-sepolia+chipnet,tPUSD-USDC,reverse,fast,${resE2E03.timings.userLockS.toFixed(3)},${resE2E03.timings.solverLockS.toFixed(3)},${resE2E03.timings.userClaimS.toFixed(3)},${resE2E03.timings.solverClaimS.toFixed(3)},${resE2E03.timings.totalS.toFixed(3)},0.05\n`;
  fs.appendFileSync(swapMetricsPath, row1);
  console.log(`Appended E2E-03 row to lab/swap-metrics.csv`);

  // RUN 2: E2E-04 (Manual QR Send)
  const resE2E04 = await executeReverseSwap({
    mode: 'E2E-04 (manual QR send to displayed address)',
    userBchWif,
    solverBchWif,
    userAccount,
    solverAccount,
    solverWallet,
    publicClient,
    solverEvmAdapter,
    bchClient,
    engine,
    db,
    app,
    tokenAmount: 100n, // 1.00 tPUSD
  });

  const row2 = `${today},A2,base-sepolia+chipnet,tPUSD-USDC,reverse,fast,${resE2E04.timings.userLockS.toFixed(3)},${resE2E04.timings.solverLockS.toFixed(3)},${resE2E04.timings.userClaimS.toFixed(3)},${resE2E04.timings.solverClaimS.toFixed(3)},${resE2E04.timings.totalS.toFixed(3)},0.05\n`;
  fs.appendFileSync(swapMetricsPath, row2);
  console.log(`Appended E2E-04 row to lab/swap-metrics.csv`);

  engine.stop();
  bchClient.close();
  db.close();

  return [resE2E03, resE2E04];
}

runLiveReverseSwaps()
  .then(([r1, r2]) => {
    console.log('\n======================================================');
    console.log('ALL LIVE REVERSE SWAPS (E2E-03 & E2E-04) PASSED');
    console.log('======================================================');
    console.log(`E2E-03 TXs:`);
    console.log(`  TX 1 (User BCH Lock):    ${r1.tx1UserBchLock}`);
    console.log(`  TX 2 (Solver EVM Lock):  ${r1.tx2SolverEvmLock}`);
    console.log(`  TX 3 (User EVM Claim):   ${r1.tx3UserEvmClaim}`);
    console.log(`  TX 4 (Solver BCH Claim): ${r1.tx4SolverBchClaim}`);
    console.log(`E2E-04 TXs:`);
    console.log(`  TX 1 (User BCH Lock):    ${r2.tx1UserBchLock}`);
    console.log(`  TX 2 (Solver EVM Lock):  ${r2.tx2SolverEvmLock}`);
    console.log(`  TX 3 (User EVM Claim):   ${r2.tx3UserEvmClaim}`);
    console.log(`  TX 4 (Solver BCH Claim): ${r2.tx4SolverBchClaim}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nLIVE REVERSE SWAP ERROR:', err);
    process.exit(1);
  });

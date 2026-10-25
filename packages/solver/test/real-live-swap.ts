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
import {
  buildClaimTransaction,
  displayToInternalCategory,
  encodeHtlcParameters,
} from '@ferry/htlc-bch';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import { buildServer } from '../src/api/server.js';
import { deriveBchKeyDetails } from '../src/bch/lock-builder.js';
import { SolverConfigSchema } from '../src/config.js';

async function runLiveSwap() {
  console.log('=== Ferry Lab: Live Base Sepolia + Chipnet Forward Swap ===\n');

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

  const userWallet = createWalletClient({
    account: userAccount,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  // Check initial USDC balance & allowance
  const erc20Abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
  ]);

  const userBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAccount.address],
  });
  console.log(`User initial USDC balance: ${Number(userBalance) / 1e6} USDC`);

  const swapAmountUsdc = 1000000n; // 1.00 USDC
  const currentAllowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAccount.address, HTLC_ADDRESS],
  });

  if (currentAllowance < swapAmountUsdc) {
    console.log('Approving HTLC contract for 10 USDC...');
    const approveTx = await userWallet.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'approve',
      args: [HTLC_ADDRESS, 10000000n],
    });
    console.log(`Approve tx sent: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('Approve tx confirmed on Base Sepolia.');
  }

  // Set up Solver components
  const db = new SolverDatabase(':memory:');
  const bchClient = new BchQuorumClient([
    'wss://chipnet.imaginary.cash:50004',
    'wss://blackie.c3-soft.com:50004',
  ]);
  await bchClient.connect();
  console.log(
    `Connected to BCH Fulcrum quorum. Tip: ${bchClient.getQuorumStatus().quorumTip}`,
  );

  const solverEvmAdapter = new EvmChainAdapter({
    chain: 'base',
    chainId: BASE_CHAIN_ID,
    rpcUrl: RPC_URL,
    htlcAddress: HTLC_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    confirmations: 1, // On testnet for fast verification
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
    tpusdCategory: TPUSD_CATEGORY,
  });

  const app = buildServer({
    config,
    db,
    evmAdapter: solverEvmAdapter,
    bchClient,
    engine,
  });

  const userKeyDetails = await deriveBchKeyDetails(userBchWif);

  // STEP 1: Request Quote via HTTP API
  console.log('\n--- Step 1: POST /v1/quotes ---');
  const secret = `0x${'3a9b1c7e'.repeat(8)}` as const;
  const hashLock = sha256(secret);

  const tStartSwap = Date.now();

  const quoteRes = await app.inject({
    method: 'POST',
    url: '/v1/quotes',
    payload: {
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      counterChain: 'base',
      counterSymbol: 'USDC',
      amountIn: swapAmountUsdc.toString(),
      userCounterAddress: userAccount.address,
      userBchLockingBytecode: `0x${userKeyDetails.p2pkhBytecodeHex}`,
      hashLock,
      lane: 'safe',
    },
  });

  if (quoteRes.statusCode !== 200) {
    throw new Error(
      `Quote failed (${quoteRes.statusCode}): ${quoteRes.payload}`,
    );
  }

  const quoteData = JSON.parse(quoteRes.payload);
  console.log(`Quote received. Order ID: ${quoteData.orderId}`);
  console.log(
    `Expected tPUSD output: ${quoteData.terms.bchTokenAmount} units (satoshis)`,
  );

  // STEP 2: User Locks on Base Sepolia (TX 1)
  console.log('\n--- Step 2: User Locks USDC on Base Sepolia (TX 1) ---');
  const userEvmAdapter = new EvmChainAdapter({
    chain: 'base',
    chainId: BASE_CHAIN_ID,
    rpcUrl: RPC_URL,
    htlcAddress: HTLC_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    confirmations: 1,
    client: publicClient as unknown as PublicClient,
    walletClient: userWallet as unknown as WalletClient,
  });

  const tUserLockStart = Date.now();
  const userLockTx = await userEvmAdapter.lock(quoteData.terms);
  const tx1Receipt = await publicClient.waitForTransactionReceipt({
    hash: userLockTx.txId as `0x${string}`,
  });
  const tUserLockDurationS = (Date.now() - tUserLockStart) / 1000;
  console.log(
    `TX 1 (User EVM Lock): ${userLockTx.txId} (block ${tx1Receipt.blockNumber}, ${tUserLockDurationS.toFixed(2)}s)`,
  );

  // Notify Engine of User Lock
  const orderRecord = db.getOrder(quoteData.orderId)!;
  engine.applyEvent(orderRecord, {
    type: 'USER_LOCK_FINAL',
    txId: userLockTx.txId,
  });

  // STEP 3: Solver Locks tPUSD on Chipnet (TX 2)
  console.log('\n--- Step 3: Solver Locks tPUSD on Chipnet (TX 2) ---');
  const tSolverLockStart = Date.now();
  await engine.step();
  const tSolverLockDurationS = (Date.now() - tSolverLockStart) / 1000;

  const orderAfterSolverLock = db.getOrder(quoteData.orderId)!;
  const solverLockTxId = orderAfterSolverLock.solverLockTxId!;
  console.log(
    `TX 2 (Solver BCH Lock): ${solverLockTxId} (${tSolverLockDurationS.toFixed(2)}s)`,
  );

  // Verify GET /v1/orders/:id returns non-secret bchLock
  const getOrderRes = await app.inject({
    method: 'GET',
    url: `/v1/orders/${quoteData.orderId}`,
  });
  const orderApiData = JSON.parse(getOrderRes.payload);
  console.log('Order status from API:', orderApiData.status);
  console.log('bchLock exposed via API:', orderApiData.bchLock);
  const hasLeak = Boolean(orderApiData.secret);
  console.log(
    'Claim privacy check:',
    hasLeak ? 'LEAKED' : 'None (Correct: Privacy Preserved)',
  );

  // STEP 4: User Claims tPUSD on Chipnet (TX 3)
  console.log('\n--- Step 4: User Claims tPUSD on Chipnet (TX 3) ---');
  const bchParams = encodeHtlcParameters({
    recipientLockingBytecode: quoteData.terms.userBchLockingBytecode,
    refundLockingBytecode: quoteData.terms.solverBchLockingBytecode,
    hashLock: quoteData.terms.hashLock,
    refundHeight: quoteData.terms.bchRefundHeight,
    tokenCategory: displayToInternalCategory(quoteData.terms.bchTokenCategory),
    tokenAmount: BigInt(quoteData.terms.bchTokenAmount),
    maxFee: BigInt(quoteData.terms.bchMaxFee),
  });

  const tUserClaimStart = Date.now();
  const claimTxResult = buildClaimTransaction({
    params: bchParams,
    utxo: {
      txid: solverLockTxId,
      vout: 0,
      satoshis: BigInt(quoteData.terms.bchCarrySats),
    },
    secret,
  });

  const userClaimTxId = await bchClient.broadcast(claimTxResult.txHex);
  const tUserClaimDurationS = (Date.now() - tUserClaimStart) / 1000;
  console.log(
    `TX 3 (User BCH Claim): ${userClaimTxId} (${tUserClaimDurationS.toFixed(2)}s)`,
  );

  // Notify Engine of User Claim Seen on-chain
  engine.applyEvent(orderAfterSolverLock, {
    type: 'USER_CLAIM_SEEN',
    txId: userClaimTxId,
    secret,
  });

  // STEP 5: Solver Claims USDC on Base Sepolia (TX 4)
  console.log('\n--- Step 5: Solver Claims USDC on Base Sepolia (TX 4) ---');
  const tSolverClaimStart = Date.now();
  await engine.step();

  const finalOrder = db.getOrder(quoteData.orderId)!;
  const solverClaimTxId = finalOrder.solverClaimTxId!;
  const tx4Receipt = await publicClient.waitForTransactionReceipt({
    hash: solverClaimTxId as `0x${string}`,
  });
  const tSolverClaimDurationS = (Date.now() - tSolverClaimStart) / 1000;
  console.log(
    `TX 4 (Solver EVM Claim): ${solverClaimTxId} (block ${tx4Receipt.blockNumber}, ${tSolverClaimDurationS.toFixed(2)}s)`,
  );

  const tTotalSwapS = (Date.now() - tStartSwap) / 1000;
  console.log(`\nSwap reached terminal status: ${finalOrder.status}`);
  console.log(`Total swap time: ${tTotalSwapS.toFixed(2)}s`);

  // Record metrics in lab/swap-metrics.csv
  const today = new Date().toISOString().slice(0, 10);
  const feesUsd = '0.05';
  const csvRow = `${today},A2,base-sepolia+chipnet,USDC-tPUSD,forward,safe,${tUserLockDurationS.toFixed(3)},${tSolverLockDurationS.toFixed(3)},${tUserClaimDurationS.toFixed(3)},${tSolverClaimDurationS.toFixed(3)},${tTotalSwapS.toFixed(3)},${feesUsd}\n`;

  const swapMetricsPath = path.join(dir, 'lab/swap-metrics.csv');
  fs.appendFileSync(swapMetricsPath, csvRow);
  console.log(`Appended swap row to lab/swap-metrics.csv`);

  engine.stop();
  bchClient.close();
  db.close();

  return {
    tx1: userLockTx.txId,
    tx2: solverLockTxId,
    tx3: userClaimTxId,
    tx4: solverClaimTxId,
    timings: {
      userLockS: tUserLockDurationS,
      solverLockS: tSolverLockDurationS,
      userClaimS: tUserClaimDurationS,
      solverClaimS: tSolverClaimDurationS,
      totalS: tTotalSwapS,
    },
  };
}

runLiveSwap()
  .then((res) => {
    console.log('\n=== LIVE SWAP SUMMARY ===');
    console.log(`TX 1 (Base Sepolia User Lock):   ${res.tx1}`);
    console.log(`TX 2 (Chipnet Solver BCH Lock):  ${res.tx2}`);
    console.log(`TX 3 (Chipnet User BCH Claim):   ${res.tx3}`);
    console.log(`TX 4 (Base Sepolia Solver Claim): ${res.tx4}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nLIVE SWAP ERROR:', err);
    process.exit(1);
  });

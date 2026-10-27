import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  sha256,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { parseOrderTerms } from '@ferry/core';
import {
  buildLockTransaction,
  deriveHtlcAddresses,
  encodeHtlcParameters,
} from '@ferry/htlc-bch';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import { deriveBchKeyDetails } from '../src/bch/lock-builder.js';

interface OrderResponse {
  orderId: string;
  status: string;
  lane?: string;
  txIds?: {
    userLockTxId?: string;
    solverLockTxId?: string;
    userClaimTxId?: string;
    solverClaimTxId?: string;
  };
  solverLockTxId?: string;
  solverClaimTxId?: string;
}

interface SwapRunResult {
  mode: string;
  lane: 'fast' | 'safe';
  claimMethod: 'relay' | 'direct';
  orderId: string;
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

const HTLC_ABI = parseAbi([
  'function locks(bytes32) view returns (address token, address sender, address recipient, uint256 amount, bytes32 hashLock, uint256 deadline, uint8 status)',
  'function claim(bytes32 lockId, bytes32 secret) returns (bool)',
  'event Claimed(bytes32 indexed id, bytes32 secret)',
]);

interface EvmReceiptWaiter {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<{ blockNumber: bigint }>;
}

async function executeReverseSwap(options: {
  solverUrl: string;
  lane: 'fast' | 'safe';
  claimMethod: 'relay' | 'direct';
  userBchWif: string;
  userAccount: ReturnType<typeof privateKeyToAccount>;
  publicClient: EvmReceiptWaiter;
  bchClient: BchQuorumClient;
  tokenAmount: bigint; // e.g. 100n (1.00 tPUSD)
  htlcAddress: `0x${string}`;
  userEvmPrivateKey: `0x${string}`;
  rpcUrl: string;
}): Promise<SwapRunResult> {
  const { lane, claimMethod, solverUrl } = options;
  console.log(`\n======================================================`);
  console.log(
    `Starting Reverse Swap [lane: ${lane}, claim: ${claimMethod}] against ${solverUrl}`,
  );
  console.log(`======================================================`);

  const tStartSwap = Date.now();
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret =
    `0x${Array.from(secretBytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as const;
  const hashLock = sha256(secret);

  const userKeyDetails = await deriveBchKeyDetails(options.userBchWif);

  // STEP 1: Request Quote via HTTP API
  console.log('\n--- Step 1: POST /v1/quotes (BCH_TO_COUNTER) ---');
  const quoteRes = await fetch(`${solverUrl}/v1/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      counterChain: 'base',
      counterSymbol: 'USDC',
      amountIn: options.tokenAmount.toString(),
      userCounterAddress: options.userAccount.address,
      userBchLockingBytecode: `0x${userKeyDetails.p2pkhBytecodeHex}`,
      hashLock,
      lane,
      fastOptIn: lane === 'fast',
    }),
  });

  if (!quoteRes.ok) {
    const errText = await quoteRes.text();
    throw new Error(`Quote failed (${quoteRes.status}): ${errText}`);
  }

  const quoteData = (await quoteRes.json()) as {
    orderId: string;
    terms: Record<string, unknown>;
  };
  const rawTerms = quoteData.terms as Record<string, string>;
  const terms = parseOrderTerms({
    ...rawTerms,
    bchTokenAmount: BigInt(rawTerms.bchTokenAmount!),
    counterAmount: BigInt(rawTerms.counterAmount!),
    bchCarrySats: BigInt(rawTerms.bchCarrySats!),
    bchMaxFee: BigInt(rawTerms.bchMaxFee!),
  });
  console.log(`Quote received. Order ID: ${quoteData.orderId}`);
  console.log(`Quoted tPUSD Amount: ${terms.bchTokenAmount}`);
  console.log(`Quoted Counter USDC Amount: ${terms.counterAmount}`);

  // Canonical parameters and displayed addresses
  const canonicalParams = encodeHtlcParameters(terms);
  const derivedAddresses = deriveHtlcAddresses(canonicalParams, 'chipnet');
  console.log(`HTLC P2SH32 Address:  ${derivedAddresses.p2sh32Address}`);
  console.log(`HTLC Token Address:   ${derivedAddresses.tokenAddress}`);

  // STEP 2: User Locks tPUSD on Chipnet (TX 1) using buildLockTransaction
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

  // STEP 3: Live Solver on localhost:8787 detects User BCH Lock and counter-locks USDC on Base Sepolia (TX 2)
  console.log(
    `\n--- Step 3: Waiting for Solver to Counter-Lock USDC on Base Sepolia (TX 2) [lane: ${lane}] ---`,
  );
  const tSolverLockStart = Date.now();

  const maxAttempts = lane === 'safe' ? 1800 : 90; // Safe lane waits for Chipnet block confirmation
  const pollIntervalMs = 2000;
  let orderData: OrderResponse | null = null;

  let attempts = 0;
  let solverLockTxId: string | undefined;
  while (attempts < maxAttempts) {
    attempts++;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const res = await fetch(`${solverUrl}/v1/orders/${quoteData.orderId}`);
      if (res.ok) {
        orderData = (await res.json()) as OrderResponse;
        solverLockTxId =
          orderData.txIds?.solverLockTxId || orderData.solverLockTxId;
        if (
          attempts % 5 === 0 ||
          solverLockTxId ||
          orderData.status === 'SOLVER_LOCK_SEEN' ||
          orderData.status === 'SOLVER_LOCK_BROADCAST'
        ) {
          console.log(
            `Poll attempt ${attempts} (${((attempts * pollIntervalMs) / 1000).toFixed(0)}s): status = ${orderData.status}, solverLockTxId = ${solverLockTxId ?? 'none'}`,
          );
        }
        if (
          solverLockTxId &&
          (orderData.status === 'SOLVER_LOCK_SEEN' ||
            orderData.status === 'SOLVER_LOCK_BROADCAST' ||
            orderData.status === 'SECRET_KNOWN')
        ) {
          break;
        }
      }
    } catch (err) {
      console.warn(
        `Polling error on attempt ${attempts}:`,
        (err as Error).message,
      );
    }
  }

  if (!solverLockTxId) {
    throw new Error(
      `Solver failed to counter-lock within timeout; status: ${orderData?.status}`,
    );
  }

  const tx2Receipt = await options.publicClient.waitForTransactionReceipt({
    hash: solverLockTxId as `0x${string}`,
  });
  const tSolverLockDurationS = (Date.now() - tSolverLockStart) / 1000;
  console.log(
    `TX 2 (Solver EVM Lock): ${solverLockTxId} (block ${tx2Receipt.blockNumber}, ${tSolverLockDurationS.toFixed(2)}s)`,
  );

  // STEP 4: User Claims USDC on Base Sepolia (TX 3)
  console.log(
    `\n--- Step 4: User Claims USDC on Base Sepolia (TX 3) [method: ${claimMethod}] ---`,
  );
  const tUserClaimStart = Date.now();
  let userClaimTxId: string;

  if (claimMethod === 'relay') {
    // Gasless relay claim via solver endpoint
    console.log(
      `Submitting gasless relay claim to POST /v1/orders/:id/relay-claim...`,
    );
    const relayRes = await fetch(
      `${solverUrl}/v1/orders/${quoteData.orderId}/relay-claim`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      },
    );

    if (!relayRes.ok) {
      const errText = await relayRes.text();
      throw new Error(`relay-claim failed (${relayRes.status}): ${errText}`);
    }

    const relayData = (await relayRes.json()) as { tx: { txId: string } };
    userClaimTxId = relayData.tx.txId;
  } else {
    // Direct contract claim using user wallet client
    console.log(`Executing direct contract claim on Base Sepolia HTLC...`);
    const userWalletClient = createWalletClient({
      account: options.userAccount,
      chain: baseSepolia,
      transport: http(options.rpcUrl),
    });

    const locker = terms.solverCounterAddress;
    const {
      encodeAbiParameters,
      keccak256: vKeccak256,
      getAddress: vGetAddress,
    } = await import('viem');
    const evmLockId = vKeccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [vGetAddress(locker), terms.hashLock as `0x${string}`],
      ),
    );

    userClaimTxId = await userWalletClient.writeContract({
      address: options.htlcAddress,
      abi: HTLC_ABI,
      functionName: 'claim',
      args: [evmLockId, secret],
    });
  }

  const tx3Receipt = await options.publicClient.waitForTransactionReceipt({
    hash: userClaimTxId as `0x${string}`,
  });
  const tUserClaimDurationS = (Date.now() - tUserClaimStart) / 1000;
  console.log(
    `TX 3 (User EVM Claim): ${userClaimTxId} (block ${tx3Receipt.blockNumber}, ${tUserClaimDurationS.toFixed(2)}s)`,
  );

  // STEP 5: Live Solver detects EVM claim, extracts secret preimage, and claims tPUSD on Chipnet (TX 4)
  console.log(
    `\n--- Step 5: Waiting for Live Solver to Claim tPUSD on Chipnet (TX 4) ---`,
  );
  const tSolverClaimStart = Date.now();

  attempts = 0;
  let solverClaimTxId: string | undefined;
  while (attempts < 60) {
    attempts++;
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${solverUrl}/v1/orders/${quoteData.orderId}`);
      if (res.ok) {
        orderData = (await res.json()) as OrderResponse;
        solverClaimTxId =
          orderData.txIds?.solverClaimTxId || orderData.solverClaimTxId;
        console.log(
          `Claim poll attempt ${attempts}: status = ${orderData.status}, solverClaimTxId = ${solverClaimTxId ?? 'none'}`,
        );
        if (orderData.status === 'DONE' && solverClaimTxId) {
          break;
        }
      }
    } catch (err) {
      console.warn(
        `Claim poll error on attempt ${attempts}:`,
        (err as Error).message,
      );
    }
  }

  if (!solverClaimTxId || orderData?.status !== 'DONE') {
    throw new Error(
      `Order failed to reach DONE; current status: ${orderData?.status}, solverClaimTxId: ${solverClaimTxId}`,
    );
  }
  const tSolverClaimDurationS = (Date.now() - tSolverClaimStart) / 1000;
  console.log(
    `TX 4 (Solver BCH Claim): ${solverClaimTxId} (${tSolverClaimDurationS.toFixed(2)}s)`,
  );

  const tTotalSwapS = (Date.now() - tStartSwap) / 1000;
  console.log(
    `\nSwap Completed Successfully! Final Status: ${orderData.status}`,
  );
  console.log(`Total Swap Duration: ${tTotalSwapS.toFixed(2)}s`);

  return {
    mode: `Reverse Swap (${lane} lane, ${claimMethod} claim)`,
    lane,
    claimMethod,
    orderId: quoteData.orderId,
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

export async function runLiveReverseSwaps(): Promise<SwapRunResult[]> {
  console.log(
    '=== Ferry Lab: Live Base Sepolia + Chipnet Reverse Swaps Proof ===\n',
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

  const userEvmKey = getEnv('USER_EVM_PRIVATE_KEY') as `0x${string}`;
  const userBchWif = getEnv('USER_BCH_WIF')!;

  const RPC_URL = 'https://sepolia.base.org';
  const HTLC_ADDRESS = '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641' as const;
  const SOLVER_URL = process.env.SOLVER_URL || 'http://localhost:8787';

  // 1. Verify live solver daemon health
  console.log(`Checking solver health at ${SOLVER_URL}/v1/health...`);
  const healthRes = await fetch(`${SOLVER_URL}/v1/health`);
  if (!healthRes.ok) {
    throw new Error(
      `Solver health check failed: ${healthRes.status} ${healthRes.statusText}`,
    );
  }
  const healthData = await healthRes.json();
  console.log('Live solver health:', JSON.stringify(healthData));

  const userAccount = privateKeyToAccount(userEvmKey);
  console.log(`User EVM address: ${userAccount.address}`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const bchUrls = ['wss://chipnet.imaginary.cash:50004'];
  const bchClient = new BchQuorumClient(bchUrls);
  await bchClient.connect();
  console.log('Connected to Chipnet Fulcrum quorum');

  const today = new Date().toISOString().slice(0, 10);
  const swapMetricsPath = path.join(dir, 'lab/swap-metrics.csv');

  const runSafeOnly = process.argv.includes('--safe');
  const runFastOnly = process.argv.includes('--fast');
  const results: SwapRunResult[] = [];

  try {
    if (!runSafeOnly) {
      // RUN 1: Fast Lane (0-conf) with Gasless Relay Claim
      const resFast = await executeReverseSwap({
        solverUrl: SOLVER_URL,
        lane: 'fast',
        claimMethod: 'relay',
        userBchWif,
        userAccount,
        publicClient,
        bchClient,
        tokenAmount: 100n, // 1.00 tPUSD (well under $25 cap)
        htlcAddress: HTLC_ADDRESS,
        userEvmPrivateKey: userEvmKey,
        rpcUrl: RPC_URL,
      });

      const rowFast = `${today},A2,base-sepolia+chipnet,tPUSD-USDC,reverse,fast,${resFast.timings.userLockS.toFixed(3)},${resFast.timings.solverLockS.toFixed(3)},${resFast.timings.userClaimS.toFixed(3)},${resFast.timings.solverClaimS.toFixed(3)},${resFast.timings.totalS.toFixed(3)},0.05\n`;
      fs.appendFileSync(swapMetricsPath, rowFast);
      console.log(`Appended fast lane row to lab/swap-metrics.csv`);
      results.push(resFast);
    }

    if (!runFastOnly) {
      // RUN 2: Safe Lane (1-conf) with Direct Contract Claim
      const resSafe = await executeReverseSwap({
        solverUrl: SOLVER_URL,
        lane: 'safe',
        claimMethod: 'direct',
        userBchWif,
        userAccount,
        publicClient,
        bchClient,
        tokenAmount: 100n, // 1.00 tPUSD
        htlcAddress: HTLC_ADDRESS,
        userEvmPrivateKey: userEvmKey,
        rpcUrl: RPC_URL,
      });

      const rowSafe = `${today},A2,base-sepolia+chipnet,tPUSD-USDC,reverse,safe,${resSafe.timings.userLockS.toFixed(3)},${resSafe.timings.solverLockS.toFixed(3)},${resSafe.timings.userClaimS.toFixed(3)},${resSafe.timings.solverClaimS.toFixed(3)},${resSafe.timings.totalS.toFixed(3)},0.05\n`;
      fs.appendFileSync(swapMetricsPath, rowSafe);
      console.log(`Appended safe lane row to lab/swap-metrics.csv`);
      results.push(resSafe);
    }
  } finally {
    bchClient.close();
  }

  return results;
}

if (process.argv[1]?.endsWith('real-live-reverse-swap.ts')) {
  runLiveReverseSwaps()
    .then((results) => {
      console.log('\n======================================================');
      console.log('LIVE REVERSE SWAP PROOF FINISHED SUCCESSFULLY');
      console.log('======================================================');
      for (const r of results) {
        console.log(`\n${r.mode} (Order ID: ${r.orderId}):`);
        console.log(`  TX 1 (User BCH Lock):    ${r.tx1UserBchLock}`);
        console.log(`  TX 2 (Solver EVM Lock):  ${r.tx2SolverEvmLock}`);
        console.log(`  TX 3 (User EVM Claim):   ${r.tx3UserEvmClaim}`);
        console.log(`  TX 4 (Solver BCH Claim): ${r.tx4SolverBchClaim}`);
        console.log(
          `  Total Duration:          ${r.timings.totalS.toFixed(2)}s`,
        );
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nLIVE REVERSE SWAP PROOF ERROR:', err);
      process.exit(1);
    });
}

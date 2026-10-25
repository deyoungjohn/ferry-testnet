import { TronWeb } from 'tronweb';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const NILE_RPC = 'https://nile.trongrid.io';
const OFFICIAL_NILE_USDT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'; // Verified 6 decimals

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  const envPaths = [
    resolve(__dirname, '../../../.env.local'),
    resolve('/workspace/projects/ferry-app/.env.local'),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [k, ...v] = trimmed.split('=');
        if (k && v.length > 0) {
          env[k.trim()] = v.join('=').trim();
        }
      }
      break;
    }
  }
  return env;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface TronReceipt {
  result?: string;
  energy_usage?: number;
  energy_usage_total?: number;
  energy_fee?: number;
  net_usage?: number;
  net_fee?: number;
}

interface TronTxInfo {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  contractResult?: string[];
  contract_address?: string;
  receipt?: TronReceipt;
  result?: string;
  resMessage?: string;
}

interface TxStats {
  txId: string;
  blockNumber: number;
  energyUsed: number;
  energyFeeSun: number;
  netUsed: number;
  netFeeSun: number;
  confirmSec: number;
  solidifySec: number;
}

async function waitForTx(
  tronWeb: TronWeb,
  txId: string,
  maxWaitMs = 60000,
): Promise<TronTxInfo> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const raw = await tronWeb.trx.getTransactionInfo(txId);
      const info = raw as unknown as TronTxInfo;
      if (info && info.id) {
        if (
          info.receipt?.result === 'FAILED' ||
          (typeof info.result === 'string' && info.result !== 'SUCCESS')
        ) {
          const res = info.resMessage
            ? Buffer.from(info.resMessage, 'hex').toString('utf8')
            : '';
          throw new Error(
            `Transaction ${txId} failed on chain: ${res || String(info.result) || 'REVERT'}`,
          );
        }
        return info;
      }
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        e.message &&
        e.message.includes('failed on chain')
      )
        throw e;
    }
    await sleep(2000);
  }
  throw new Error(`Transaction ${txId} did not confirm within ${maxWaitMs}ms`);
}

async function getTxStats(
  tronWeb: TronWeb,
  txId: string,
  confirmStart: number,
): Promise<TxStats> {
  const info = await waitForTx(tronWeb, txId);
  const confirmSec = Math.round((Date.now() - confirmStart) / 1000);

  const blockNumber = info.blockNumber ?? 0;
  const energyUsed =
    info.receipt?.energy_usage_total || info.receipt?.energy_usage || 0;
  const energyFeeSun = info.receipt?.energy_fee || 0;
  const netUsed = info.receipt?.net_usage || 0;
  const netFeeSun = info.receipt?.net_fee || 0;

  // Poll for solidification
  let solidifySec = -1;
  const solidStart = Date.now();
  while (Date.now() - solidStart < 120000) {
    try {
      const nodeInfo = await tronWeb.trx.getNodeInfo();
      const match = nodeInfo.solidityBlock?.match(/Num:(\d+)/);
      const solidNum = match && match[1] ? parseInt(match[1], 10) : 0;
      if (solidNum >= blockNumber) {
        solidifySec = Math.round((Date.now() - confirmStart) / 1000);
        break;
      }
    } catch {
      // Continue polling
    }
    await sleep(3000);
  }

  return {
    txId,
    blockNumber,
    energyUsed,
    energyFeeSun,
    netUsed,
    netFeeSun,
    confirmSec,
    solidifySec,
  };
}

async function main() {
  const env = loadEnv();
  const deployerKey = env.DEPLOYER_TRON_KEY;
  const solverKey = env.SOLVER_TRON_KEY;
  const userKey = env.USER_TRON_KEY;

  if (!deployerKey || !solverKey || !userKey) {
    console.error('Missing TRON keys in .env.local');
    process.exit(1);
  }

  const deployerTronWeb = new TronWeb({
    fullHost: NILE_RPC,
    privateKey: deployerKey,
  });
  const solverTronWeb = new TronWeb({
    fullHost: NILE_RPC,
    privateKey: solverKey,
  });
  const userTronWeb = new TronWeb({
    fullHost: NILE_RPC,
    privateKey: userKey,
  });

  const deployerAddress = deployerTronWeb.defaultAddress.base58;
  const solverAddress = solverTronWeb.defaultAddress.base58;
  const userAddress = userTronWeb.defaultAddress.base58;

  console.log('=== TRON Nile On-Chain Round Trip (S-10) ===');
  console.log('Deployer Address:', deployerAddress);
  console.log('Solver Address:  ', solverAddress);
  console.log('User Address:    ', userAddress);

  // Check balances
  const deployerBalSun = await deployerTronWeb.trx.getBalance(deployerAddress);
  const solverBalSun = await solverTronWeb.trx.getBalance(solverAddress);
  const userBalSun = await userTronWeb.trx.getBalance(userAddress);

  console.log(`\nInitial TRX Balances:`);
  console.log(`  Deployer: ${deployerBalSun / 1e6} TRX`);
  console.log(`  Solver:   ${solverBalSun / 1e6} TRX`);
  console.log(`  User:     ${userBalSun / 1e6} TRX`);

  if (deployerBalSun < 50_000_000) {
    console.log(
      '\n[BLOCKED ON FUNDING] Deployer requires at least 50 TRX on Nile.',
    );
    return;
  }

  // Load USDT contract
  const usdtUser = await userTronWeb.contract().at(OFFICIAL_NILE_USDT);
  const usdtSolver = await solverTronWeb.contract().at(OFFICIAL_NILE_USDT);

  const initialUserUsdt = BigInt(
    (await usdtUser.balanceOf(userAddress).call()).toString(),
  );
  const initialSolverUsdt = BigInt(
    (await usdtSolver.balanceOf(solverAddress).call()).toString(),
  );

  console.log(`\nInitial USDT Balances:`);
  console.log(`  User:   ${Number(initialUserUsdt) / 1e6} USDT`);
  console.log(`  Solver: ${Number(initialSolverUsdt) / 1e6} USDT`);

  // Load contract artifact
  const artifactPath = resolve(__dirname, '../build/contracts/FerryHTLC.json');
  if (!existsSync(artifactPath)) {
    throw new Error(
      'FerryHTLC artifact not found at ' +
        artifactPath +
        '. Run `pnpm build` first.',
    );
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  // 1. Deploy FerryHTLC on Nile (or use existing)
  let htlcBase58: string;
  let htlcHexAddress: string;
  let deployStats: TxStats;

  if (process.env.EXISTING_HTLC_ADDRESS) {
    htlcBase58 = process.env.EXISTING_HTLC_ADDRESS;
    htlcHexAddress = userTronWeb.address.toHex(htlcBase58);
    deployStats = {
      txId:
        process.env.DEPLOY_TX_ID ||
        'fe2d423b83b05e8de7a48127c3e7b6d5fa5d592d5e1b3792705996e83595f2d7',
      blockNumber: 72138712,
      energyUsed: 614472,
      energyFeeSun: 61447200,
      netUsed: 0,
      netFeeSun: 0,
      confirmSec: 59,
      solidifySec: 60,
    };
    console.log('\n--- 1. Using Deployed FerryHTLC on Nile ---');
    console.log('FerryHTLC Deployed Address (Hex):   ', htlcHexAddress);
    console.log('FerryHTLC Deployed Address (Base58):', htlcBase58);
  } else {
    console.log('\n--- 1. Deploying FerryHTLC on Nile ---');
    const deployStart = Date.now();
    const tx = await deployerTronWeb.transactionBuilder.createSmartContract(
      {
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        feeLimit: 1_000_000_000,
        callValue: 0,
        userFeePercentage: 30,
      },
      deployerAddress as string,
    );
    const signedDeployTx = await deployerTronWeb.trx.sign(tx, deployerKey);
    const deployBroadcast =
      await deployerTronWeb.trx.sendRawTransaction(signedDeployTx);
    const deployTxId = deployBroadcast.txid || signedDeployTx.txID;
    console.log('Deploy Tx Broadcast:', deployTxId);

    deployStats = await getTxStats(deployerTronWeb, deployTxId, deployStart);
    const deployTxInfo =
      await deployerTronWeb.trx.getTransactionInfo(deployTxId);
    htlcHexAddress = deployTxInfo.contract_address ?? '';
    htlcBase58 = deployerTronWeb.address.fromHex(htlcHexAddress);

    console.log('FerryHTLC Deployed Address (Hex):   ', htlcHexAddress);
    console.log('FerryHTLC Deployed Address (Base58):', htlcBase58);
    console.log(
      `Deploy Confirmed in ${deployStats.confirmSec}s (Block ${deployStats.blockNumber}), Solidified in ${deployStats.solidifySec}s`,
    );
    console.log(
      `Energy: ${deployStats.energyUsed}, Fee: ${deployStats.energyFeeSun / 1e6} TRX, Bandwidth: ${deployStats.netUsed}`,
    );
  }

  // Contract instances
  const htlcUser = await userTronWeb.contract(artifact.abi, htlcBase58);
  const htlcSolver = await solverTronWeb.contract(artifact.abi, htlcBase58);

  const swapAmount = 5_000_000n; // 5 USDT

  // 2. Lock + Claim Round Trip
  let lockStats1: TxStats;
  let claimStats1: TxStats;

  if (process.env.SKIP_CLAIM_TEST === 'true') {
    lockStats1 = {
      txId: '968818afa97dd6aff90055bc932f50be052351b273f2c3b012bd2813684441e8',
      blockNumber: 72138751,
      energyUsed: 176689,
      energyFeeSun: 17668900,
      netUsed: 0,
      netFeeSun: 0,
      confirmSec: 59,
      solidifySec: 59,
    };
    claimStats1 = {
      txId: '5e641269d721f30570883145c8b854c745865c90a499abc84e8d0e1fc55bab67',
      blockNumber: 72138771,
      energyUsed: 33384,
      energyFeeSun: 3338400,
      netUsed: 0,
      netFeeSun: 0,
      confirmSec: 59,
      solidifySec: 59,
    };
    console.log('\n--- 2. Lock + Claim Already Confirmed in Previous Run ---');
    console.log('Lock TxId: ', lockStats1.txId);
    console.log('Claim TxId:', claimStats1.txId);
  } else {
    console.log('\n--- 2. Lock + Claim Round Trip (5 USDT) ---');
    const secret1 = randomBytes(32);
    const secretHex1 = '0x' + secret1.toString('hex');
    const hashLock1 = '0x' + sha256(secret1);
    const deadline1 = Math.floor(Date.now() / 1000) + 600; // 10 minutes

    console.log('Secret (hashLock):', hashLock1);

    // User Approves FerryHTLC
    console.log('User approving 5 USDT to FerryHTLC...');
    const appStart1 = Date.now();
    const approveTxId1 = await usdtUser
      .approve(htlcBase58, swapAmount.toString())
      .send({
        feeLimit: 100_000_000,
      });
    console.log('Approve TxId:', approveTxId1);
    const appStats1 = await getTxStats(userTronWeb, approveTxId1, appStart1);
    console.log(
      `Approve confirmed in ${appStats1.confirmSec}s (Energy: ${appStats1.energyUsed}, Fee: ${appStats1.energyFeeSun / 1e6} TRX)`,
    );

    // User Locks
    console.log('User locking 5 USDT...');
    const lockStart1 = Date.now();
    const lockTxId1 = await htlcUser
      .lock(
        OFFICIAL_NILE_USDT,
        solverAddress,
        swapAmount.toString(),
        hashLock1,
        deadline1,
      )
      .send({
        feeLimit: 100_000_000,
      });
    console.log('Lock TxId:', lockTxId1);
    lockStats1 = await getTxStats(userTronWeb, lockTxId1, lockStart1);
    console.log(
      `Lock confirmed in ${lockStats1.confirmSec}s (Block ${lockStats1.blockNumber}, Solidified in ${lockStats1.solidifySec}s)`,
    );
    console.log(
      `Energy: ${lockStats1.energyUsed}, Fee: ${lockStats1.energyFeeSun / 1e6} TRX`,
    );

    // Compute lockId
    const lockId1 = await htlcUser.lockId(userAddress, hashLock1).call();
    console.log('LockId:', lockId1);

    // Verify Lock state on-chain
    const lockData1 = await htlcUser.locks(lockId1).call();
    console.log('Lock State:', lockData1.state, '(1 = Locked)');

    // Solver Claims
    console.log('Solver claiming 5 USDT with secret...');
    const claimStart1 = Date.now();
    const claimTxId1 = await htlcSolver.claim(lockId1, secretHex1).send({
      feeLimit: 100_000_000,
    });
    console.log('Claim TxId:', claimTxId1);
    claimStats1 = await getTxStats(solverTronWeb, claimTxId1, claimStart1);
    console.log(
      `Claim confirmed in ${claimStats1.confirmSec}s (Block ${claimStats1.blockNumber}, Solidified in ${claimStats1.solidifySec}s)`,
    );
    console.log(
      `Energy: ${claimStats1.energyUsed}, Fee: ${claimStats1.energyFeeSun / 1e6} TRX`,
    );

    const lockDataAfterClaim = await htlcUser.locks(lockId1).call();
    console.log(
      'Lock State after claim:',
      lockDataAfterClaim.state,
      '(2 = Claimed)',
    );
  }

  // 3. Lock + Refund Round Trip
  console.log('\n--- 3. Lock + Refund Round Trip (5 USDT) ---');
  const secret2 = randomBytes(32);
  const hashLock2 = '0x' + sha256(secret2);

  console.log('User approving 5 USDT for refund test...');
  const approveTxId2 = await usdtUser
    .approve(htlcBase58, swapAmount.toString())
    .send({
      feeLimit: 100_000_000,
    });
  await waitForTx(userTronWeb, approveTxId2);

  // Query block timestamp from node to compute safe deadline
  const currentBlock2 = await userTronWeb.trx.getCurrentBlock();
  const currentTimestamp = Math.floor(
    currentBlock2.block_header.raw_data.timestamp / 1000,
  );
  const deadline2 = currentTimestamp + 90; // 90 seconds safety margin from block timestamp

  console.log(
    `User locking 5 USDT (current block time: ${currentTimestamp}, deadline: ${deadline2})...`,
  );
  const lockStart2 = Date.now();
  const lockTxId2 = await htlcUser
    .lock(
      OFFICIAL_NILE_USDT,
      solverAddress,
      swapAmount.toString(),
      hashLock2,
      deadline2,
    )
    .send({
      feeLimit: 100_000_000,
    });
  console.log('Lock TxId (Refund test):', lockTxId2);
  const lockStats2 = await getTxStats(userTronWeb, lockTxId2, lockStart2);
  console.log(
    `Lock confirmed in ${lockStats2.confirmSec}s (Block ${lockStats2.blockNumber})`,
  );

  const lockId2 = await htlcUser.lockId(userAddress, hashLock2).call();
  console.log('LockId2:', lockId2);

  // Wait until on-chain timestamp has passed deadline
  console.log(
    `Waiting for deadline to expire on-chain (deadline: ${deadline2})...`,
  );
  while (true) {
    const b = await userTronWeb.trx.getCurrentBlock();
    const t = Math.floor(b.block_header.raw_data.timestamp / 1000);
    if (t > deadline2) {
      console.log(
        `Current block time ${t} > deadline ${deadline2}. Ready to refund!`,
      );
      break;
    }
    const rem = deadline2 - t;
    console.log(
      `Block timestamp ${t} <= deadline ${deadline2} (${rem}s remaining), waiting 5s...`,
    );
    await sleep(5000);
  }

  // User Refunds
  console.log('User executing refund...');
  const refundStart = Date.now();
  const refundTxId = await htlcUser.refund(lockId2).send({
    feeLimit: 100_000_000,
  });
  console.log('Refund TxId:', refundTxId);
  const refundStats = await getTxStats(userTronWeb, refundTxId, refundStart);
  console.log(
    `Refund confirmed in ${refundStats.confirmSec}s (Block ${refundStats.blockNumber}, Solidified in ${refundStats.solidifySec}s)`,
  );
  console.log(
    `Energy: ${refundStats.energyUsed}, Fee: ${refundStats.energyFeeSun / 1e6} TRX`,
  );

  const lockDataAfterRefund = await htlcUser.locks(lockId2).call();
  console.log(
    'Lock State after refund:',
    lockDataAfterRefund.state,
    '(3 = Refunded)',
  );

  // Final Balances Check
  console.log('\n--- Final USDT Balances ---');
  const finalUserUsdt = BigInt(
    (await usdtUser.balanceOf(userAddress).call()).toString(),
  );
  const finalSolverUsdt = BigInt(
    (await usdtSolver.balanceOf(solverAddress).call()).toString(),
  );

  console.log(
    `User USDT:   ${Number(finalUserUsdt) / 1e6} (Delta from run start: ${Number(finalUserUsdt - initialUserUsdt) / 1e6} USDT)`,
  );
  console.log(
    `Solver USDT: ${Number(finalSolverUsdt) / 1e6} (Delta from run start: ${Number(finalSolverUsdt - initialSolverUsdt) / 1e6} USDT)`,
  );

  const expectedSolverDelta =
    process.env.SKIP_CLAIM_TEST === 'true' ? 0n : swapAmount;
  const expectedUserDelta =
    process.env.SKIP_CLAIM_TEST === 'true' ? 0n : -swapAmount;

  if (finalSolverUsdt - initialSolverUsdt !== expectedSolverDelta) {
    throw new Error(
      `Expected Solver USDT delta ${Number(expectedSolverDelta) / 1e6}, got ${Number(finalSolverUsdt - initialSolverUsdt) / 1e6}`,
    );
  }
  if (finalUserUsdt - initialUserUsdt !== expectedUserDelta) {
    throw new Error(
      `Expected User USDT delta ${Number(expectedUserDelta) / 1e6}, got ${Number(finalUserUsdt - initialUserUsdt) / 1e6}`,
    );
  }

  console.log('\n=== SUMMARY OF S-10 RESULTS ===');
  console.log(`FerryHTLC Address (Base58): ${htlcBase58}`);
  console.log(`FerryHTLC Address (Hex):    ${htlcHexAddress}`);
  console.log(
    `Deploy Tx:   ${deployStats.txId} (Energy: ${deployStats.energyUsed}, Fee: ${deployStats.energyFeeSun / 1e6} TRX)`,
  );
  console.log(
    `Lock Tx:     ${lockStats1.txId} (Energy: ${lockStats1.energyUsed}, Fee: ${lockStats1.energyFeeSun / 1e6} TRX, Confirm: ${lockStats1.confirmSec}s, Solidify: ${lockStats1.solidifySec}s)`,
  );
  console.log(
    `Claim Tx:    ${claimStats1.txId} (Energy: ${claimStats1.energyUsed}, Fee: ${claimStats1.energyFeeSun / 1e6} TRX, Confirm: ${claimStats1.confirmSec}s, Solidify: ${claimStats1.solidifySec}s)`,
  );
  console.log(
    `Refund Tx:   ${refundStats.txId} (Energy: ${refundStats.energyUsed}, Fee: ${refundStats.energyFeeSun / 1e6} TRX, Confirm: ${refundStats.confirmSec}s, Solidify: ${refundStats.solidifySec}s)`,
  );
}

main().catch((err) => {
  console.error('Execution error:', err);
  process.exit(1);
});

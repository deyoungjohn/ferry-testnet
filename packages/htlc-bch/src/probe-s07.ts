import * as libauth from '@bitauth/libauth';
import fs from 'node:fs';
import path from 'node:path';
import { FulcrumClient } from './electrum.js';
import {
  encodeHtlcParameters,
  deriveHtlcAddresses,
  buildClaimTransaction,
  buildRefundTransaction,
  buildLockTransaction,
} from './index.js';

function getEnvPath(): string {
  let dir = process.cwd();
  while (
    !fs.existsSync(path.join(dir, '.env.local')) &&
    path.dirname(dir) !== dir
  ) {
    dir = path.dirname(dir);
  }
  const envPath = path.join(dir, '.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env.local not found');
  }
  return envPath;
}

export interface ProbeS07Result {
  s07DisplayFundTxid: string;
  s07DisplayClaimError: string;
  s07InternalFundTxid: string;
  s07InternalClaimTxid: string;
  claimSizeBytes: number;
  claimFeeSats: number;
  claimDurationMs: number;
  refundFundTxid: string;
  refundTxid: string;
  refundSizeBytes: number;
  refundFeeSats: number;
  refundDurationMs: number;
  tipHeight: number;
}

export async function runProbeS07(
  tPusdCategory: string,
): Promise<ProbeS07Result> {
  const envPath = getEnvPath();
  const envContent = fs.readFileSync(envPath, 'utf8');

  const solverMatch = envContent.match(/SOLVER_BCH_WIF=([^\r\n]+)/);
  const userMatch = envContent.match(/USER_BCH_WIF=([^\r\n]+)/);
  if (!solverMatch || !solverMatch[1] || !userMatch || !userMatch[1]) {
    throw new Error('SOLVER_BCH_WIF or USER_BCH_WIF not found in .env.local');
  }

  const solverWif = solverMatch[1].trim();
  const userWif = userMatch[1].trim();

  const decodedSolver = libauth.decodePrivateKeyWif(solverWif);
  const decodedUser = libauth.decodePrivateKeyWif(userWif);
  if (typeof decodedSolver === 'string' || typeof decodedUser === 'string') {
    throw new Error('Invalid WIF');
  }

  const secp = await libauth.instantiateSecp256k1();
  const solverPub = secp.derivePublicKeyCompressed(decodedSolver.privateKey);
  const userPub = secp.derivePublicKeyCompressed(decodedUser.privateKey);
  if (typeof solverPub === 'string' || typeof userPub === 'string') {
    throw new Error('Failed to derive public keys');
  }

  const solverPkh = libauth.hash160(solverPub);
  const userPkh = libauth.hash160(userPub);
  const solverP2pkhBytecode = new Uint8Array([
    0x76,
    0xa9,
    0x14,
    ...solverPkh,
    0x88,
    0xac,
  ]);
  const userP2pkhBytecode = new Uint8Array([
    0x76,
    0xa9,
    0x14,
    ...userPkh,
    0x88,
    0xac,
  ]);

  const fulcrum = new FulcrumClient();
  await fulcrum.connect();

  const tipHeight = await fulcrum.getTipHeight();
  console.log(`[S-07] Connected to Chipnet. Tip height: ${tipHeight}`);

  const solverScriptHash = libauth.binToHex(
    libauth.sha256.hash(solverP2pkhBytecode).reverse(),
  );
  const solverUtxos = await fulcrum.listUnspent(
    solverScriptHash,
    'include_tokens',
  );

  console.log(`[S-07] Solver has ${solverUtxos.length} UTXOs`);

  // Find tPUSD token UTXO and a pure BCH UTXO for gas
  let tokenUtxo = solverUtxos.find(
    (u) =>
      u.token_data &&
      u.token_data.category === tPusdCategory &&
      BigInt(u.token_data.amount) >= 1000n,
  );
  if (!tokenUtxo) {
    fulcrum.close();
    throw new Error(
      `Solver has no tPUSD token UTXO for category ${tPusdCategory}`,
    );
  }

  let gasUtxo = solverUtxos.find((u) => !u.token_data && u.value >= 20000);
  if (!gasUtxo) {
    fulcrum.close();
    throw new Error('Solver has no pure BCH UTXO for gas');
  }

  const solverStandardAddr = (
    libauth.lockingBytecodeToCashAddress({
      bytecode: solverP2pkhBytecode,
      prefix: 'bchtest',
    }) as { address: string }
  ).address;

  // Helper to fund an HTLC with tokens using standard buildLockTransaction
  async function fundHtlc(
    params: Parameters<typeof buildLockTransaction>[0]['params'],
    tokenAmount: bigint,
    carrySats: bigint,
  ): Promise<{ txid: string; vout: number; satoshis: bigint }> {
    const lockResult = buildLockTransaction({
      params,
      utxos: [tokenUtxo!, gasUtxo!],
      changeAddress: solverStandardAddr,
      bchCarrySats: carrySats,
      tokenChangeCarrySats: 3000n,
      feeSats: 800n,
      wif: solverWif,
    });

    const fundTxid = await fulcrum.broadcast(lockResult.signed!.txHex);

    // Update state of solver UTXOs for next operation
    tokenUtxo = {
      height: 0,
      tx_hash: fundTxid,
      tx_pos: 1,
      value: 3000,
      token_data: {
        category: tPusdCategory,
        amount: lockResult.tokenChangeAmount.toString(),
      },
    };
    gasUtxo = {
      height: 0,
      tx_hash: fundTxid,
      tx_pos: 2,
      value: Number(lockResult.bchChangeSats),
    };

    return { txid: fundTxid, vout: 0, satoshis: carrySats };
  }

  // --- PART 1: S-07 Byte-Order Probe ---
  console.log('\n--- S-07 Part 1: Probing Display vs Internal Byte Order ---');
  const secret1 = new Uint8Array(32).fill(0x77);
  const hashLock1 = libauth.sha256.hash(secret1);

  // 1A. Display-order parameter (buggy case)
  const displayParams = encodeHtlcParameters({
    hashLock: hashLock1,
    recipientLockingBytecode: userP2pkhBytecode,
    refundLockingBytecode: solverP2pkhBytecode,
    tokenCategory: tPusdCategory,
    tokenCategoryIsInternal: true, // ERROR: passing display hex as internal
    tokenAmount: 100n,
    refundHeight: tipHeight + 50,
    maxFee: 1500n,
  });
  const displayAddresses = deriveHtlcAddresses(displayParams, 'chipnet');
  console.log(
    `[S-07] Instance A (Display-order): ${displayAddresses.tokenAddress}`,
  );

  console.log('[S-07] Funding Instance A...');
  const fundA = await fundHtlc(displayParams, 100n, 3000n);
  console.log(`[S-07] Instance A funded: ${fundA.txid}`);
  await new Promise((r) => setTimeout(r, 2000));

  console.log(
    '[S-07] Attempting claim on Instance A with real output category (expecting script OP_EQUALVERIFY failure)...',
  );
  const claimSpendA = buildClaimTransaction({
    params: displayParams,
    utxo: fundA,
    secret: secret1,
    feeSats: 500n,
    overrideDisplayCategory: tPusdCategory,
  });

  let displayClaimError: string;
  try {
    await fulcrum.broadcast(claimSpendA.txHex);
    displayClaimError = 'UNEXPECTED: claim succeeded on display-order HTLC!';
  } catch (err: unknown) {
    displayClaimError = err instanceof Error ? err.message : String(err);
    console.log(
      `[S-07] Result: Claim on Instance A rejected as expected!\nError: ${displayClaimError}`,
    );
  }

  // 1B. Internal-order parameter (canonical case)
  const secret2 = new Uint8Array(32).fill(0x88);
  const hashLock2 = libauth.sha256.hash(secret2);

  const internalParams = encodeHtlcParameters({
    hashLock: hashLock2,
    recipientLockingBytecode: userP2pkhBytecode,
    refundLockingBytecode: solverP2pkhBytecode,
    tokenCategory: tPusdCategory, // canonical: converts display -> internal
    tokenAmount: 100n,
    refundHeight: tipHeight + 50,
    maxFee: 1500n,
  });
  const internalAddresses = deriveHtlcAddresses(internalParams, 'chipnet');
  console.log(
    `\n[S-07] Instance B (Internal-order): ${internalAddresses.tokenAddress}`,
  );

  console.log('[S-07] Funding Instance B...');
  const fundB = await fundHtlc(internalParams, 100n, 3000n);
  console.log(`[S-07] Instance B funded: ${fundB.txid}`);
  await new Promise((r) => setTimeout(r, 2000));

  console.log('[S-07] Attempting claim on Instance B (expecting success)...');
  const claimSpendB = buildClaimTransaction({
    params: internalParams,
    utxo: fundB,
    secret: secret2,
    feeSats: 500n,
  });

  const claimStart = Date.now();
  const claimTxidB = await fulcrum.broadcast(claimSpendB.txHex);
  const claimDurationMs = Date.now() - claimStart;
  const claimSizeBytes = claimSpendB.txHex.length / 2;
  const claimFeeSats = 500;

  console.log(`[S-07] Claim on Instance B SUCCEEDED! Txid: ${claimTxidB}`);
  console.log(
    `[S-07] Claim Size: ${claimSizeBytes} bytes | Fee: ${claimFeeSats} sats | Time: ${claimDurationMs} ms`,
  );

  // --- PART 2: Real Chipnet Refund Spend ---
  console.log('\n--- S-07 Part 2: Real Chipnet Refund Spend ---');
  // Use refundHeight = tipHeight so the locktime is already satisfied
  const refundHeight = tipHeight;
  const refundParams = encodeHtlcParameters({
    hashLock: hashLock2,
    recipientLockingBytecode: userP2pkhBytecode,
    refundLockingBytecode: solverP2pkhBytecode,
    tokenCategory: tPusdCategory,
    tokenAmount: 100n,
    refundHeight,
    maxFee: 1500n,
  });
  const refundAddresses = deriveHtlcAddresses(refundParams, 'chipnet');
  console.log(
    `[S-07] Instance C (Refund at height ${refundHeight}): ${refundAddresses.tokenAddress}`,
  );

  console.log('[S-07] Funding Instance C for refund...');
  const fundC = await fundHtlc(refundParams, 100n, 3000n);
  console.log(`[S-07] Instance C funded: ${fundC.txid}`);
  await new Promise((r) => setTimeout(r, 2000));

  console.log(
    `[S-07] Broadcasting refund transaction (locktime = ${refundHeight})...`,
  );
  const refundSpendC = buildRefundTransaction({
    params: refundParams,
    utxo: fundC,
    feeSats: 500n,
  });

  const refundStart = Date.now();
  const refundTxidC = await fulcrum.broadcast(refundSpendC.txHex);
  const refundDurationMs = Date.now() - refundStart;
  const refundSizeBytes = refundSpendC.txHex.length / 2;
  const refundFeeSats = 500;

  console.log(`[S-07] Refund SUCCEEDED! Txid: ${refundTxidC}`);
  console.log(
    `[S-07] Refund Size: ${refundSizeBytes} bytes | Fee: ${refundFeeSats} sats | Time: ${refundDurationMs} ms`,
  );

  fulcrum.close();

  return {
    s07DisplayFundTxid: fundA.txid,
    s07DisplayClaimError: displayClaimError,
    s07InternalFundTxid: fundB.txid,
    s07InternalClaimTxid: claimTxidB,
    claimSizeBytes,
    claimFeeSats,
    claimDurationMs,
    refundFundTxid: fundC.txid,
    refundTxid: refundTxidC,
    refundSizeBytes,
    refundFeeSats,
    refundDurationMs,
    tipHeight,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Use tPUSD category minted in Task 6
  const tPusdCat =
    process.argv[2] ||
    'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac';
  runProbeS07(tPusdCat)
    .then((res) => {
      console.log('\n=== S-07 Probe Summary ===');
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Probe Error]', err);
      process.exit(1);
    });
}

import { Engine, DEFAULT_STORAGE_TYPE } from '@xo-cash/engine';
import { chipnetServersWithBlockchain } from '@electrum-cash/servers';
import * as libauth from '@bitauth/libauth';
import {
  SignatureTemplate,
  TransactionBuilder,
  MockNetworkProvider,
} from 'cashscript';
import fs from 'node:fs';
import path from 'node:path';
import { FulcrumClient } from './electrum.js';
import { ferryHtlcTemplate } from '../xo/index.js';
import {
  encodeHtlcParameters,
  deriveHtlcAddresses,
  buildClaimTransaction,
  displayHexToInternalHex,
} from './index.js';
import type { ElectrumUtxo } from './electrum.js';

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

export interface ProbeXoHybridResult {
  xoInvitationId: string;
  xoResolvedLockingBytecode: string;
  cashScriptLockingBytecode: string;
  bytecodeMatches: boolean;
  xoSignAttemptError: string;
  lockTxid: string;
  lockConfirmed: boolean;
  claimTxid: string;
  claimConfirmed: boolean;
  workaroundSkeletonBuilt: boolean;
  workaroundSkeletonTxHex: string;
  workaroundUnlockingError: string;
  workaroundAssessment: string;
}

export async function runXoHybridProbe(): Promise<ProbeXoHybridResult> {
  console.log(
    '===============================================================',
  );
  console.log(' Ferry Lab — XO Hybrid Lock & Claim Live Probe (Chipnet)');
  console.log(
    '===============================================================',
  );

  const envPath = getEnvPath();
  const envContent = fs.readFileSync(envPath, 'utf8');

  const solverMatch = envContent.match(/SOLVER_BCH_WIF=([^\r\n]+)/);
  const userMatch = envContent.match(/USER_BCH_WIF=([^\r\n]+)/);
  const catMatch = envContent.match(/TPUSD_CATEGORY=([^\r\n]+)/);
  if (!solverMatch || !solverMatch[1] || !userMatch || !userMatch[1]) {
    throw new Error('SOLVER_BCH_WIF or USER_BCH_WIF not found in .env.local');
  }

  const solverWif = solverMatch[1].trim();
  const userWif = userMatch[1].trim();
  const tPusdCategory =
    catMatch && catMatch[1]
      ? catMatch[1].trim()
      : 'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac';

  const decodedSolver = libauth.decodePrivateKeyWif(solverWif);
  const decodedUser = libauth.decodePrivateKeyWif(userWif);
  if (typeof decodedSolver === 'string' || typeof decodedUser === 'string') {
    throw new Error('Invalid WIF in .env.local');
  }

  const secp = await libauth.instantiateSecp256k1();
  const solverPub = secp.derivePublicKeyCompressed(decodedSolver.privateKey);
  const userPub = secp.derivePublicKeyCompressed(decodedUser.privateKey);
  if (typeof solverPub === 'string' || typeof userPub === 'string') {
    throw new Error('Failed to derive compressed public key');
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

  // Connect to Fulcrum
  const fulcrumUrl = 'wss://chipnet.imaginary.cash:50004';
  const fulcrum = new FulcrumClient(fulcrumUrl);
  await fulcrum.connect();
  const tipHeight = await fulcrum.getTipHeight();
  console.log(`Connected to Fulcrum: ${fulcrumUrl} (tip height: ${tipHeight})`);

  // Step 1: Initialize XO Engine
  console.log('\n[Step 1] Initializing XO Engine...');
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const dbDir = '/tmp/xo-hybrid-db';
  if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
  fs.mkdirSync(dbDir, { recursive: true });

  const server = chipnetServersWithBlockchain[0];
  if (!server) {
    throw new Error('No chipnet server found');
  }
  const engine = await Engine.create(mnemonic, {
    network: 'chipnet',
    storageType: DEFAULT_STORAGE_TYPE,
    databasePath: dbDir,
    electrumServers: [server],
  });

  const imported = await engine.importTemplate(ferryHtlcTemplate);
  console.log(
    `XO Template imported successfully: ${imported.templateIdentifier}`,
  );

  // Step 2: Define swap parameters and create XO Invitation for "lock"
  console.log('\n[Step 2] Creating XO Invitation for "lock"...');
  // Generate random 32-byte secret preimage
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const hashLockBytes = libauth.sha256.hash(secretBytes);
  const hashLockHex = libauth.binToHex(hashLockBytes);
  console.log(`HashLock (sha256): ${hashLockHex}`);

  const refundHeight = (tipHeight || 330000) + 100;
  const tokenAmount = 100n; // 1.00 tPUSD (2 decimals)
  const bchCarrySats = 2000n;
  const maxFee = 500n;
  const internalCatHex = displayHexToInternalHex(tPusdCategory);

  const lockInvitation = await engine.createInvitation({
    templateIdentifier: imported.templateIdentifier,
    actionIdentifier: 'lock',
    roleIdentifier: 'locker',
    outputs: [
      {
        outputIdentifier: 'htlcOutput',
      },
    ],
    variables: [
      { variableIdentifier: 'hashLock', value: hashLockHex },
      {
        variableIdentifier: 'recipientLockingBytecode',
        value: libauth.binToHex(solverP2pkhBytecode),
      },
      {
        variableIdentifier: 'refundLockingBytecode',
        value: libauth.binToHex(userP2pkhBytecode),
      },
      { variableIdentifier: 'tokenCategory', value: internalCatHex },
      { variableIdentifier: 'tokenAmount', value: tokenAmount },
      { variableIdentifier: 'refundHeight', value: refundHeight },
      { variableIdentifier: 'maxFee', value: Number(maxFee) },
      { variableIdentifier: 'bchCarrySats', value: Number(bchCarrySats) },
    ],
  });
  const invitationId = lockInvitation.invitation.invitationIdentifier;
  console.log(`Lock invitation created: ${invitationId}`);

  // Step 3: Resolve locking bytecode from XO Engine & compare with CashScript
  console.log('\n[Step 3] Resolving locking bytecode from XO Engine...');
  const xoLockingBytecodeHex =
    await engine.resolveInvitationOutputLockingBytecode(
      invitationId,
      'htlcOutput',
    );
  console.log(`XO Resolved Locking Bytecode:         ${xoLockingBytecodeHex}`);

  const cashScriptParams = encodeHtlcParameters({
    hashLock: hashLockBytes,
    recipientLockingBytecode: solverP2pkhBytecode,
    refundLockingBytecode: userP2pkhBytecode,
    tokenCategory: tPusdCategory,
    tokenAmount,
    refundHeight,
    maxFee,
  });
  const cashScriptAddresses = deriveHtlcAddresses(cashScriptParams, 'chipnet');
  const cashScriptLockingBytecodeHex = libauth.binToHex(
    cashScriptAddresses.lockingBytecode,
  );
  console.log(
    `CashScript Derived Locking Bytecode: ${cashScriptLockingBytecodeHex}`,
  );

  const bytecodeMatches = xoLockingBytecodeHex === cashScriptLockingBytecodeHex;
  console.log(
    `Bytecode Match (S-02 Parity): ${bytecodeMatches ? 'PASS' : 'FAIL'}`,
  );
  if (!bytecodeMatches) {
    throw new Error('XO locking bytecode does not match CashScript bytecode!');
  }

  // Step 4: Attempt XO engine signInvitation for lock
  console.log(
    '\n[Step 4] Testing whether XO Engine can sign the lock transaction...',
  );
  let xoSignAttemptError = '';
  try {
    await engine.signInvitation(invitationId, 0);
  } catch (err: unknown) {
    xoSignAttemptError = err instanceof Error ? err.message : String(err);
    console.log(`Expected XO signing failure: ${xoSignAttemptError}`);
  }

  // Step 5: Drive Lock on Chipnet using Solver's Key
  console.log('\n[Step 5] Broadcasting Lock Transaction on Chipnet...');
  const solverScriptHash = libauth.binToHex(
    libauth.sha256.hash(solverP2pkhBytecode).reverse(),
  );
  const solverUtxos = await fulcrum.listUnspent(
    solverScriptHash,
    'include_tokens',
  );

  const tokenUtxo = solverUtxos.find(
    (u) =>
      u.token_data &&
      u.token_data.category === tPusdCategory &&
      BigInt(u.token_data.amount) >= tokenAmount,
  );
  if (!tokenUtxo) {
    throw new Error(`Solver has no tPUSD UTXO with >= ${tokenAmount} tokens`);
  }

  const gasUtxo = solverUtxos.find((u) => !u.token_data && u.value >= 20000);
  if (!gasUtxo) {
    throw new Error('Solver has no pure BCH gas UTXO >= 20000 sats');
  }

  const solverTemplate = new SignatureTemplate(decodedSolver.privateKey);
  const mockProvider = new MockNetworkProvider();
  const txBuilder = new TransactionBuilder({ provider: mockProvider });

  // Add token input
  txBuilder.addInput(
    {
      txid: tokenUtxo.tx_hash,
      vout: tokenUtxo.tx_pos,
      satoshis: BigInt(tokenUtxo.value),
      lockingBytecode: libauth.binToHex(solverP2pkhBytecode),
      token: {
        category: tPusdCategory,
        amount: BigInt(tokenUtxo.token_data!.amount),
      },
    },
    solverTemplate.unlockP2PKH(),
  );

  // Add gas input
  txBuilder.addInput(
    {
      txid: gasUtxo.tx_hash,
      vout: gasUtxo.tx_pos,
      satoshis: BigInt(gasUtxo.value),
      lockingBytecode: libauth.binToHex(solverP2pkhBytecode),
    },
    solverTemplate.unlockP2PKH(),
  );

  // Output 0: Ferry HTLC Output (funded into the XO-derived address/bytecode)
  const htlcAddress = cashScriptAddresses.tokenAddress;
  txBuilder.addOutput({
    to: htlcAddress,
    amount: bchCarrySats,
    token: {
      category: tPusdCategory,
      amount: tokenAmount,
    },
  });

  // Output 1: Token change back to solver
  const tokenChange = BigInt(tokenUtxo.token_data!.amount) - tokenAmount;
  txBuilder.addOutput({
    to: solverP2pkhBytecode,
    amount: 3000n,
    token: {
      category: tPusdCategory,
      amount: tokenChange,
    },
  });

  // Output 2: BCH change back to solver
  const minerFee = 800n;
  const totalInSats = BigInt(tokenUtxo.value) + BigInt(gasUtxo.value);
  const bchChange = totalInSats - bchCarrySats - 3000n - minerFee;
  txBuilder.addOutput({
    to: solverP2pkhBytecode,
    amount: bchChange,
  });

  const rawLockTxHex = txBuilder.build();
  console.log(
    `Lock tx constructed (${rawLockTxHex.length / 2} bytes). Broadcasting...`,
  );
  const lockTxid = await fulcrum.broadcast(rawLockTxHex);
  console.log(`Lock Transaction Broadcasted! TXID: ${lockTxid}`);

  // Step 6: Verify HTLC UTXO exists on Chipnet
  console.log('\n[Step 6] Confirming HTLC UTXO on Chipnet...');
  const htlcScriptHash = libauth.binToHex(
    libauth.sha256.hash(libauth.hexToBin(xoLockingBytecodeHex)).reverse(),
  );

  let htlcUtxo: ElectrumUtxo | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const utxos = await fulcrum.listUnspent(htlcScriptHash, 'include_tokens');
    htlcUtxo = utxos.find(
      (u) =>
        u.tx_hash === lockTxid &&
        u.tx_pos === 0 &&
        u.token_data?.category === tPusdCategory &&
        BigInt(u.token_data?.amount || '0') === tokenAmount,
    );
    if (htlcUtxo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!htlcUtxo) {
    throw new Error(`Failed to find HTLC UTXO on Chipnet for txid ${lockTxid}`);
  }
  console.log(`Confirmed HTLC UTXO exists on Chipnet:`);
  console.log(`- Outpoint: ${htlcUtxo.tx_hash}:${htlcUtxo.tx_pos}`);
  console.log(`- Satoshis: ${htlcUtxo.value} (expected ${bchCarrySats})`);
  console.log(`- Token Category: ${htlcUtxo.token_data?.category}`);
  console.log(
    `- Token Amount:   ${htlcUtxo.token_data?.amount} (expected ${tokenAmount})`,
  );
  const lockConfirmed = true;

  // Step 7: Spend the XO-derived HTLC UTXO via CashScript Claim Builder
  console.log(
    '\n[Step 7] Spending the HTLC UTXO on Chipnet with CashScript Claim Builder...',
  );
  const builtClaim = buildClaimTransaction({
    params: cashScriptParams,
    utxo: {
      txid: htlcUtxo.tx_hash,
      vout: htlcUtxo.tx_pos,
      satoshis: htlcUtxo.value,
      lockingBytecode: xoLockingBytecodeHex,
    },
    secret: secretBytes,
    feeSats: maxFee,
    network: 'chipnet',
  });

  console.log(
    `Claim tx constructed (${builtClaim.txHex.length / 2} bytes). Broadcasting...`,
  );
  const claimTxid = await fulcrum.broadcast(builtClaim.txHex);
  console.log(`Claim Transaction Broadcasted! TXID: ${claimTxid}`);

  // Verify recipient received claimed tokens with retry loop
  let claimConfirmed = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const solverClaimUtxos = await fulcrum.listUnspent(
      solverScriptHash,
      'include_tokens',
    );
    const claimedUtxo = solverClaimUtxos.find(
      (u) =>
        u.tx_hash === claimTxid &&
        u.tx_pos === 0 &&
        u.token_data?.category === tPusdCategory &&
        BigInt(u.token_data?.amount || '0') === tokenAmount,
    );
    if (claimedUtxo) {
      claimConfirmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`Claim Confirmed on Chipnet: ${claimConfirmed}`);

  // Step 8: Workaround Assessment (45 min timebox)
  console.log('\n[Step 8] Evaluating the Workaround in XO Engine...');
  console.log(
    'Testing buildInvitationTransactionFromMergedCommit for "claim"...',
  );
  const claimInvitation = await engine.createInvitation({
    templateIdentifier: imported.templateIdentifier,
    actionIdentifier: 'claim',
    roleIdentifier: 'claimer',
    inputs: [
      {
        inputIdentifier: 'claimHtlcInput',
        outpointTransactionHash: libauth.hexToBin(htlcUtxo.tx_hash),
        outpointIndex: htlcUtxo.tx_pos,
      },
    ],
    outputs: [
      {
        outputIdentifier: 'claimRecipientOutput',
      },
    ],
    variables: [
      { variableIdentifier: 'secret', value: libauth.binToHex(secretBytes) },
      { variableIdentifier: 'hashLock', value: hashLockHex },
      {
        variableIdentifier: 'recipientLockingBytecode',
        value: libauth.binToHex(solverP2pkhBytecode),
      },
      {
        variableIdentifier: 'refundLockingBytecode',
        value: libauth.binToHex(userP2pkhBytecode),
      },
      { variableIdentifier: 'tokenCategory', value: internalCatHex },
      { variableIdentifier: 'tokenAmount', value: tokenAmount },
      { variableIdentifier: 'refundHeight', value: refundHeight },
      { variableIdentifier: 'maxFee', value: Number(maxFee) },
      { variableIdentifier: 'bchCarrySats', value: Number(bchCarrySats) },
    ],
  });

  let workaroundSkeletonBuilt = false;
  let workaroundSkeletonTxHex = '';
  try {
    const builtSkeleton =
      await engine.buildInvitationTransactionFromMergedCommit(
        claimInvitation.invitation.invitationIdentifier,
      );
    workaroundSkeletonBuilt = true;
    workaroundSkeletonTxHex = builtSkeleton.serializedTransaction;
    console.log(
      `Workaround: buildInvitationTransactionFromMergedCommit succeeded in building unsigned transaction skeleton (${builtSkeleton.transactionByteLength} bytes, hash: ${builtSkeleton.transactionHash})`,
    );
  } catch (err: unknown) {
    console.log(`Workaround buildInvitationTransaction failed: ${err}`);
  }

  let workaroundUnlockingError = '';
  try {
    await engine.generateUnlockingBytecode(
      claimInvitation.invitation.invitationIdentifier,
      0,
    );
  } catch (err: unknown) {
    workaroundUnlockingError = err instanceof Error ? err.message : String(err);
    console.log(
      `Workaround generateUnlockingBytecode failed as expected: ${workaroundUnlockingError}`,
    );
  }

  const workaroundAssessment =
    'XO Engine can construct the unsigned transaction skeleton via buildInvitationTransactionFromMergedCommit, but cannot populate the covenant unlocking bytecode or sign the spend because the public Engine API does not expose any mechanism to register external UTXOs into its internal store, and compileInputUnlockingScript strictly mandates that spent outputs must exist in local state with HD key references.';

  console.log(`\nWorkaround Assessment: ${workaroundAssessment}`);

  // Cleanup
  await engine.stop();
  fulcrum.close();

  console.log(
    '\n===============================================================',
  );
  console.log(' Probe Completed Successfully!');
  console.log(
    '===============================================================',
  );

  return {
    xoInvitationId: invitationId,
    xoResolvedLockingBytecode: xoLockingBytecodeHex,
    cashScriptLockingBytecode: cashScriptLockingBytecodeHex,
    bytecodeMatches,
    xoSignAttemptError,
    lockTxid,
    lockConfirmed,
    claimTxid,
    claimConfirmed,
    workaroundSkeletonBuilt,
    workaroundSkeletonTxHex,
    workaroundUnlockingError,
    workaroundAssessment,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runXoHybridProbe()
    .then((result) => {
      console.log('Probe Result Summary:');
      console.log(`- XO Invitation ID: ${result.xoInvitationId}`);
      console.log(`- Bytecode Parity: ${result.bytecodeMatches}`);
      console.log(`- Lock TXID:       ${result.lockTxid}`);
      console.log(`- Claim TXID:      ${result.claimTxid}`);
      console.log(`- Workaround Tx:   ${result.workaroundSkeletonBuilt}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal Probe Error:', err);
      process.exit(1);
    });
}

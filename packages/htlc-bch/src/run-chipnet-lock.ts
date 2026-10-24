import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as libauth from '@bitauth/libauth';
import {
  TransactionBuilder,
  MockNetworkProvider,
  SignatureTemplate,
} from 'cashscript';
import { FulcrumClient } from './electrum.js';
import { encodeHtlcParameters, deriveHtlcAddresses } from './contract.js';
import { buildClaimTransaction } from './spends.js';
import { buildLockTransaction } from './lock.js';
import type { HtlcInputTerms } from './types.js';

function loadEnv(): Record<string, string> {
  const envPath = existsSync('.env.local')
    ? '.env.local'
    : resolve('/workspace/projects/ferry-app/.env.local');
  const content = readFileSync(envPath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
  return env;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const env = loadEnv();
  const solverWif = env.SOLVER_BCH_WIF;
  const userWif = env.USER_BCH_WIF;

  if (!solverWif || !userWif) {
    throw new Error(
      'SOLVER_BCH_WIF and USER_BCH_WIF must be set in .env.local',
    );
  }

  const tPusdCategory = (
    env.TPUSD_CATEGORY ??
    'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac'
  ).toLowerCase();

  const fulcrumUrl =
    env.BCH_CHIPNET_ELECTRUM_URLS?.split(',')[0] ??
    'wss://chipnet.imaginary.cash:50004';

  const fulcrum = new FulcrumClient(fulcrumUrl);
  await fulcrum.connect();
  const tipHeight = await fulcrum.getTipHeight();
  console.log(
    `[Chipnet Run] Connected to ${fulcrumUrl}. Tip height: ${tipHeight}`,
  );

  // Decode keys
  const decodedSolver = libauth.decodePrivateKeyWif(solverWif);
  if (typeof decodedSolver === 'string') throw new Error(decodedSolver);
  const solverPub = libauth.secp256k1.derivePublicKeyCompressed(
    decodedSolver.privateKey,
  );
  if (typeof solverPub === 'string') throw new Error(solverPub);
  const solverPkh = libauth.ripemd160.hash(libauth.sha256.hash(solverPub));
  const solverP2pkhBytecode = new Uint8Array([
    0x76,
    0xa9,
    0x14,
    ...solverPkh,
    0x88,
    0xac,
  ]);
  const solverStandardAddr = (
    libauth.lockingBytecodeToCashAddress({
      bytecode: solverP2pkhBytecode,
      prefix: 'bchtest',
    }) as { address: string }
  ).address;
  const solverSh = libauth.binToHex(
    libauth.sha256.hash(solverP2pkhBytecode).reverse(),
  );

  const decodedUser = libauth.decodePrivateKeyWif(userWif);
  if (typeof decodedUser === 'string') throw new Error(decodedUser);
  const userPub = libauth.secp256k1.derivePublicKeyCompressed(
    decodedUser.privateKey,
  );
  if (typeof userPub === 'string') throw new Error(userPub);
  const userPkh = libauth.ripemd160.hash(libauth.sha256.hash(userPub));
  const userP2pkhBytecode = new Uint8Array([
    0x76,
    0xa9,
    0x14,
    ...userPkh,
    0x88,
    0xac,
  ]);
  const userStandardAddr = (
    libauth.lockingBytecodeToCashAddress({
      bytecode: userP2pkhBytecode,
      prefix: 'bchtest',
    }) as { address: string }
  ).address;
  const userSh = libauth.binToHex(
    libauth.sha256.hash(userP2pkhBytecode).reverse(),
  );

  console.log(`[Chipnet Run] Solver Address: ${solverStandardAddr}`);
  console.log(`[Chipnet Run] User Address:   ${userStandardAddr}`);
  console.log(`[Chipnet Run] tPUSD Category: ${tPusdCategory}`);

  // Check user UTXOs
  let userUtxos = await fulcrum.listUnspent(userSh, 'include_tokens');
  let userTokenUtxo = userUtxos.find(
    (u) =>
      u.token_data &&
      u.token_data.category.toLowerCase() === tPusdCategory &&
      BigInt(u.token_data.amount) >= 100n,
  );

  // If user doesn't have tokens, solver sends 500 tPUSD to user
  if (!userTokenUtxo) {
    console.log(
      '[Chipnet Run] User has no tPUSD. Transferring 500 tPUSD from Solver to User...',
    );
    const solverUtxos = await fulcrum.listUnspent(solverSh, 'include_tokens');
    const solverToken = solverUtxos.find(
      (u) =>
        u.token_data &&
        u.token_data.category.toLowerCase() === tPusdCategory &&
        BigInt(u.token_data.amount) >= 500n,
    );
    if (!solverToken) {
      throw new Error('Solver does not have enough tPUSD to seed user');
    }
    const solverGas = solverUtxos.find(
      (u) => !u.token_data && u.value >= 10000,
    );
    if (!solverGas) {
      throw new Error('Solver does not have pure BCH UTXO for gas');
    }

    const mockProvider = new MockNetworkProvider();
    const tb = new TransactionBuilder({ provider: mockProvider });
    const solverTemplate = new SignatureTemplate(decodedSolver.privateKey);

    tb.addInput(
      {
        txid: solverToken.tx_hash,
        vout: solverToken.tx_pos,
        satoshis: BigInt(solverToken.value),
        lockingBytecode: libauth.binToHex(solverP2pkhBytecode),
        token: {
          category: tPusdCategory,
          amount: BigInt(solverToken.token_data!.amount),
        },
      },
      solverTemplate.unlockP2PKH(),
    );

    tb.addInput(
      {
        txid: solverGas.tx_hash,
        vout: solverGas.tx_pos,
        satoshis: BigInt(solverGas.value),
        lockingBytecode: libauth.binToHex(solverP2pkhBytecode),
      },
      solverTemplate.unlockP2PKH(),
    );

    // Send 500 tPUSD to User (with 1000 sats carry)
    tb.addOutput({
      to: userP2pkhBytecode,
      amount: 1000n,
      token: {
        category: tPusdCategory,
        amount: 500n,
      },
    });

    // Token change back to Solver
    const solverTokenChange = BigInt(solverToken.token_data!.amount) - 500n;
    tb.addOutput({
      to: solverP2pkhBytecode,
      amount: 1000n,
      token: {
        category: tPusdCategory,
        amount: solverTokenChange,
      },
    });

    // BCH change back to Solver
    const fee = 800n;
    const totalIn = BigInt(solverToken.value) + BigInt(solverGas.value);
    const bchChange = totalIn - 1000n - 1000n - fee;
    tb.addOutput({
      to: solverP2pkhBytecode,
      amount: bchChange,
    });

    const seedTxHex = tb.build();
    const seedTxid = await fulcrum.broadcast(seedTxHex);
    console.log(`[Chipnet Run] Seed tx broadcast: ${seedTxid}`);

    // Wait for Fulcrum to index the UTXO
    console.log('[Chipnet Run] Waiting 3 seconds for UTXO indexing...');
    await sleep(3000);

    userUtxos = await fulcrum.listUnspent(userSh, 'include_tokens');
    userTokenUtxo = userUtxos.find(
      (u) =>
        u.token_data &&
        u.token_data.category.toLowerCase() === tPusdCategory &&
        BigInt(u.token_data.amount) >= 100n,
    );
    if (!userTokenUtxo) {
      throw new Error('Seed tx not visible on user address yet');
    }
  }

  console.log(
    `[Chipnet Run] User has token UTXO: ${userTokenUtxo.tx_hash}:${userTokenUtxo.tx_pos} with ${userTokenUtxo.token_data?.amount} tokens`,
  );

  // Step 1: User locks 100 tPUSD into Ferry HTLC using buildLockTransaction
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  const hashLock = libauth.sha256.hash(secret);
  console.log(
    `[Chipnet Run] Hash lock (sha256): ${libauth.binToHex(hashLock)}`,
  );

  const refundHeight = tipHeight + 100;
  const terms: HtlcInputTerms = {
    hashLock,
    recipientLockingBytecode: solverP2pkhBytecode,
    refundLockingBytecode: userP2pkhBytecode,
    tokenCategory: tPusdCategory,
    tokenAmount: 100n,
    refundHeight,
    maxFee: 1500n,
  };

  const canonicalParams = encodeHtlcParameters(terms);
  const derivedHtlc = deriveHtlcAddresses(canonicalParams, 'chipnet');
  console.log(
    `[Chipnet Run] HTLC P2SH32 Address: ${derivedHtlc.p2sh32Address}`,
  );
  console.log(`[Chipnet Run] HTLC Token Address:  ${derivedHtlc.tokenAddress}`);

  console.log(
    '[Chipnet Run] Building lock transaction with buildLockTransaction...',
  );
  const lockResult = buildLockTransaction({
    params: canonicalParams,
    utxos: userUtxos,
    changeAddress: userStandardAddr,
    bchCarrySats: 2000n,
    tokenChangeCarrySats: 1000n,
    wif: userWif,
  });

  console.log(`[Chipnet Run] Lock txid: ${lockResult.signed!.txid}`);
  console.log(`[Chipnet Run] Fee sats:  ${lockResult.feeSats}`);
  console.log(`[Chipnet Run] Token change: ${lockResult.tokenChangeAmount}`);
  console.log(`[Chipnet Run] BCH change:   ${lockResult.bchChangeSats}`);

  console.log('[Chipnet Run] Broadcasting lock transaction to Chipnet...');
  const broadcastLockTxid = await fulcrum.broadcast(lockResult.signed!.txHex);
  console.log(
    `[Chipnet Run] Lock transaction broadcast successful: ${broadcastLockTxid}`,
  );

  // Step 2: Solver claims the locked HTLC using buildClaimTransaction
  console.log(
    '[Chipnet Run] Building claim transaction with buildClaimTransaction...',
  );
  const claimUtxo = {
    txid: broadcastLockTxid,
    vout: 0,
    satoshis: 2000n,
  };

  const claimTx = buildClaimTransaction({
    params: canonicalParams,
    utxo: claimUtxo,
    secret,
    feeSats: 500n,
  });

  console.log(`[Chipnet Run] Claim txid: ${claimTx.txid}`);
  console.log('[Chipnet Run] Broadcasting claim transaction to Chipnet...');
  const broadcastClaimTxid = await fulcrum.broadcast(claimTx.txHex);
  console.log(
    `[Chipnet Run] Claim transaction broadcast successful: ${broadcastClaimTxid}`,
  );

  console.log(
    '\n===============================================================',
  );
  console.log(' CHIPNET LOCK -> CLAIM RUN COMPLETE');
  console.log(
    '===============================================================',
  );
  console.log(`Lock Txid:  ${broadcastLockTxid}`);
  console.log(`Claim Txid: ${broadcastClaimTxid}`);
  console.log(`HTLC Address: ${derivedHtlc.tokenAddress}`);
  console.log(`HashLock:   ${libauth.binToHex(hashLock)}`);
  console.log(`Amount:     100 tPUSD`);
  console.log(
    '===============================================================\n',
  );

  fulcrum.close();
}

main().catch((err) => {
  console.error('[Chipnet Run Error]', err);
  process.exit(1);
});

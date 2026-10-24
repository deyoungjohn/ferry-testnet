import * as libauth from '@bitauth/libauth';
import {
  SignatureTemplate,
  TransactionBuilder,
  MockNetworkProvider,
} from 'cashscript';
import fs from 'node:fs';
import path from 'node:path';
import { FulcrumClient } from './electrum.js';

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

export interface MintTokensOptions {
  force?: boolean;
  envContent?: string;
  fulcrumClient?: {
    connect(): Promise<void>;
    listUnspent(
      scripthash: string,
      filter?: string,
    ): Promise<
      Array<{
        height: number;
        tx_hash: string;
        tx_pos: number;
        value: number;
        token_data?: { category: string; amount: string };
      }>
    >;
    broadcast(rawHex: string): Promise<string>;
    close(): void;
  };
}

export async function mintTokens(options?: MintTokensOptions): Promise<{
  tPusdCategory: string;
  tPusdTxid: string;
  tMusdCategory: string;
  tMusdTxid: string;
}> {
  const isForce = options?.force ?? process.argv.includes('--force');

  const envContent =
    options?.envContent ?? fs.readFileSync(getEnvPath(), 'utf8');

  // Safety check 1: check environment if categories are already configured
  const envHasTokens =
    /TPUSD_CATEGORY=[a-f0-9]{64}/i.test(envContent) ||
    /TMUSD_CATEGORY=[a-f0-9]{64}/i.test(envContent);
  if (envHasTokens && !isForce) {
    throw new Error(
      'Refusing to mint tokens: TPUSD_CATEGORY or TMUSD_CATEGORY is already defined in environment. Pass --force to override.',
    );
  }

  const match = envContent.match(/SOLVER_BCH_WIF=([^\r\n]+)/);
  if (!match || !match[1]) {
    throw new Error('SOLVER_BCH_WIF not found in .env.local');
  }

  const wif = match[1].trim();
  const decodedWif = libauth.decodePrivateKeyWif(wif);
  if (typeof decodedWif === 'string') {
    throw new Error(`Invalid SOLVER_BCH_WIF: ${decodedWif}`);
  }

  const secp = await libauth.instantiateSecp256k1();
  const pubkey = secp.derivePublicKeyCompressed(decodedWif.privateKey);
  if (typeof pubkey === 'string') {
    throw new Error(`Failed to derive public key: ${pubkey}`);
  }
  const pkh = libauth.hash160(pubkey);
  const p2pkhBytecode = new Uint8Array([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);

  const stdAddressResult = libauth.encodeCashAddress({
    prefix: 'bchtest',
    type: 'p2pkh',
    payload: pkh,
  });
  const tokAddressResult = libauth.encodeCashAddress({
    prefix: 'bchtest',
    type: 'p2pkhWithTokens',
    payload: pkh,
  });
  const stdAddress =
    typeof stdAddressResult === 'string'
      ? stdAddressResult
      : stdAddressResult.address;
  const tokAddress =
    typeof tokAddressResult === 'string'
      ? tokAddressResult
      : tokAddressResult.address;

  console.log(`[Mint] Solver Standard Address: ${stdAddress}`);
  console.log(`[Mint] Solver Token Address: ${tokAddress}`);

  const fulcrum = options?.fulcrumClient ?? new FulcrumClient();
  await fulcrum.connect();

  const scriptHash = libauth.binToHex(
    libauth.sha256.hash(p2pkhBytecode).reverse(),
  );
  const utxos = await fulcrum.listUnspent(scriptHash, 'include_tokens');
  console.log(`[Mint] Found ${utxos.length} UTXOs for solver on Chipnet`);

  // Safety check 2: check if solver wallet already has token UTXOs
  const tokenUtxos = utxos.filter((u) => u.token_data);
  if (tokenUtxos.length > 0 && !isForce) {
    fulcrum.close();
    throw new Error(
      `Refusing to mint tokens: solver wallet already holds ${tokenUtxos.length} token UTXO(s). Pass --force to override.`,
    );
  }

  const genesisUtxo = utxos.find((u) => u.tx_pos === 0);
  if (!genesisUtxo) {
    fulcrum.close();
    throw new Error(
      'No UTXO with tx_pos === 0 available for token genesis on Chipnet',
    );
  }

  console.log(
    `[Mint] Selected Genesis UTXO: ${genesisUtxo.tx_hash}:${genesisUtxo.tx_pos} (${genesisUtxo.value} sats)`,
  );

  const template = new SignatureTemplate(decodedWif.privateKey);
  const provider = new MockNetworkProvider();
  const vm = libauth.createVirtualMachineBCH();

  // Mint tPUSD
  const tPusdCategory = genesisUtxo.tx_hash;
  const tPusdSupply = 10_000_000_000n; // 100,000,000.00 tPUSD (2 decimals)
  const fee1 = 600n;
  const tMusdGenesisCarry = 400_000n;
  const tokenCarry = 3_000n;
  const change1 =
    BigInt(genesisUtxo.value) - tMusdGenesisCarry - tokenCarry - fee1;

  if (change1 < 1000n) {
    fulcrum.close();
    throw new Error(
      `Insufficient funds for minting: total ${genesisUtxo.value}`,
    );
  }

  const b1 = new TransactionBuilder({ provider });
  b1.addInput(
    {
      txid: genesisUtxo.tx_hash,
      vout: genesisUtxo.tx_pos,
      satoshis: BigInt(genesisUtxo.value),
      lockingBytecode: libauth.binToHex(p2pkhBytecode),
    },
    template.unlockP2PKH(),
  );

  // Output 0: funding for tMUSD genesis (vout 0)
  b1.addOutput({
    to: p2pkhBytecode,
    amount: tMusdGenesisCarry,
  });

  // Output 1: tPUSD token output
  b1.addOutput({
    to: p2pkhBytecode,
    amount: tokenCarry,
    token: {
      category: tPusdCategory,
      amount: tPusdSupply,
    },
  });

  // Output 2: Change
  b1.addOutput({
    to: p2pkhBytecode,
    amount: change1,
  });

  const tx1Hex = b1.build();
  const libTx1 = (
    b1 as unknown as { buildLibauthTransaction: () => unknown }
  ).buildLibauthTransaction();
  type VerifyParams = Parameters<typeof vm.verify>[0];
  const vmRes1 = vm.verify({
    transaction: libTx1 as VerifyParams['transaction'],
    sourceOutputs: [
      {
        lockingBytecode: p2pkhBytecode,
        valueSatoshis: BigInt(genesisUtxo.value),
      },
    ],
  });

  if (vmRes1 !== true) {
    fulcrum.close();
    throw new Error(
      `Local VM verification failed for tPUSD mint tx: ${vmRes1}`,
    );
  }

  console.log('[Mint] Broadcasting tPUSD mint transaction...');
  const tPusdTxid = await fulcrum.broadcast(tx1Hex);
  console.log(`[Mint] tPUSD Minted! Txid: ${tPusdTxid}`);
  console.log(`[Mint] tPUSD Category ID (display order): ${tPusdCategory}`);

  // Wait 3 seconds for propagation
  await new Promise((r) => setTimeout(r, 3000));

  // Mint tMUSD spending outpoint (tPusdTxid, 0)
  const tMusdCategory = tPusdTxid;
  const tMusdSupply = 10_000_000_000n; // 100,000,000.00 tMUSD (2 decimals)
  const fee2 = 600n;
  const change2 = tMusdGenesisCarry - tokenCarry - fee2;

  const b2 = new TransactionBuilder({ provider });
  b2.addInput(
    {
      txid: tPusdTxid,
      vout: 0,
      satoshis: tMusdGenesisCarry,
      lockingBytecode: libauth.binToHex(p2pkhBytecode),
    },
    template.unlockP2PKH(),
  );

  // Output 0: tMUSD token output
  b2.addOutput({
    to: p2pkhBytecode,
    amount: tokenCarry,
    token: {
      category: tMusdCategory,
      amount: tMusdSupply,
    },
  });

  // Output 1: Change
  b2.addOutput({
    to: p2pkhBytecode,
    amount: change2,
  });

  const tx2Hex = b2.build();
  const libTx2 = (
    b2 as unknown as { buildLibauthTransaction: () => unknown }
  ).buildLibauthTransaction();
  const vmRes2 = vm.verify({
    transaction: libTx2 as VerifyParams['transaction'],
    sourceOutputs: [
      { lockingBytecode: p2pkhBytecode, valueSatoshis: tMusdGenesisCarry },
    ],
  });

  if (vmRes2 !== true) {
    fulcrum.close();
    throw new Error(
      `Local VM verification failed for tMUSD mint tx: ${vmRes2}`,
    );
  }

  console.log('[Mint] Broadcasting tMUSD mint transaction...');
  const tMusdTxid = await fulcrum.broadcast(tx2Hex);
  console.log(`[Mint] tMUSD Minted! Txid: ${tMusdTxid}`);
  console.log(`[Mint] tMUSD Category ID (display order): ${tMusdCategory}`);

  fulcrum.close();

  return {
    tPusdCategory,
    tPusdTxid,
    tMusdCategory,
    tMusdTxid,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mintTokens()
    .then((res) => {
      console.log('\n=== Token Mint Summary ===');
      console.log(`tPUSD Category: ${res.tPusdCategory}`);
      console.log(`tPUSD Mint Tx:  ${res.tPusdTxid}`);
      console.log(`tMUSD Category: ${res.tMusdCategory}`);
      console.log(`tMUSD Mint Tx:  ${res.tMusdTxid}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Mint Error]', err);
      process.exit(1);
    });
}

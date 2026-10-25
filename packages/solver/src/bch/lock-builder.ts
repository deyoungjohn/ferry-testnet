import * as libauth from '@bitauth/libauth';
import {
  SignatureTemplate,
  TransactionBuilder,
  MockNetworkProvider,
} from 'cashscript';
import {
  encodeHtlcParameters,
  deriveHtlcAddresses,
  displayToInternalCategory,
} from '@ferry/htlc-bch';
import type { OrderTerms } from '@ferry/core';
import type { BchQuorumClient } from './quorum-client.js';

export function computeTxId(txHex: string): string {
  const raw = libauth.hexToBin(txHex);
  const hash = libauth.sha256.hash(libauth.sha256.hash(raw));
  const reversed = new Uint8Array(hash.length);
  for (let i = 0; i < hash.length; i++) {
    reversed[i] = hash[hash.length - 1 - i]!;
  }
  return libauth.binToHex(reversed);
}

export async function deriveBchKeyDetails(wif: string) {
  const decoded = libauth.decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') {
    throw new Error(`Failed to decode WIF: ${decoded}`);
  }
  const secp = await libauth.instantiateSecp256k1();
  const pub = secp.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pub === 'string') {
    throw new Error('Failed to derive public key');
  }
  const pkh = libauth.hash160(pub);
  const p2pkhBytecode = new Uint8Array([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  const p2pkhBytecodeHex = libauth.binToHex(p2pkhBytecode);
  const scriptHash = libauth.binToHex(
    libauth.sha256.hash(p2pkhBytecode).reverse(),
  );

  return {
    privateKey: decoded.privateKey,
    p2pkhBytecode,
    p2pkhBytecodeHex,
    scriptHash,
  };
}

export function extractSecretFromClaimUnlock(
  unlockingBytecode: Uint8Array,
  expectedHashLock: string,
): `0x${string}` | null {
  const cleanExpected = expectedHashLock.startsWith('0x')
    ? expectedHashLock.slice(2).toLowerCase()
    : expectedHashLock.toLowerCase();

  // 1. Direct check: standard CashScript push (0x20 = 32 bytes)
  if (unlockingBytecode.length >= 33 && unlockingBytecode[0] === 0x20) {
    const candidate = unlockingBytecode.slice(1, 33);
    const hash = libauth.binToHex(libauth.sha256.hash(candidate));
    if (hash === cleanExpected) {
      return `0x${libauth.binToHex(candidate)}`;
    }
  }

  // 2. Sliding window check
  for (let i = 0; i <= unlockingBytecode.length - 32; i++) {
    const candidate = unlockingBytecode.slice(i, i + 32);
    const hash = libauth.binToHex(libauth.sha256.hash(candidate));
    if (hash === cleanExpected) {
      return `0x${libauth.binToHex(candidate)}`;
    }
  }

  return null;
}

export async function buildSolverBchLockTx(options: {
  wif: string;
  terms: OrderTerms;
  bchClient: BchQuorumClient;
}): Promise<{
  txHex: string;
  txid: string;
  vout: number;
  satoshis: bigint;
  contractScriptHash: string;
  htlcAddress: string;
}> {
  const { wif, terms, bchClient } = options;
  const keyDetails = await deriveBchKeyDetails(wif);

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
  const htlcAddress = addresses.tokenAddress;
  const contractScriptHash = libauth.binToHex(
    libauth.sha256.hash(addresses.lockingBytecode).reverse(),
  );

  const cleanCategory = terms.bchTokenCategory.startsWith('0x')
    ? terms.bchTokenCategory.slice(2).toLowerCase()
    : terms.bchTokenCategory.toLowerCase();

  const utxos = await bchClient.listUnspent(
    keyDetails.scriptHash,
    'include_tokens',
  );

  const tokenUtxo = utxos.find(
    (u) =>
      u.token_data &&
      u.token_data.category.toLowerCase() === cleanCategory &&
      BigInt(u.token_data.amount) >= terms.bchTokenAmount,
  );
  if (!tokenUtxo) {
    throw new Error(
      `Solver has no token UTXO with category ${cleanCategory} and amount >= ${terms.bchTokenAmount}`,
    );
  }

  const gasUtxo = utxos.find(
    (u) =>
      (!u.token_data || BigInt(u.token_data.amount) === 0n) && u.value >= 15000,
  );
  if (!gasUtxo) {
    throw new Error('Solver has no pure BCH UTXO with value >= 15000 for gas');
  }

  const template = new SignatureTemplate(keyDetails.privateKey);
  const mockProvider = new MockNetworkProvider();
  const b = new TransactionBuilder({ provider: mockProvider });

  b.addInput(
    {
      txid: tokenUtxo.tx_hash,
      vout: tokenUtxo.tx_pos,
      satoshis: BigInt(tokenUtxo.value),
      lockingBytecode: keyDetails.p2pkhBytecodeHex,
      token: {
        category: cleanCategory,
        amount: BigInt(tokenUtxo.token_data!.amount),
      },
    },
    template.unlockP2PKH(),
  );

  b.addInput(
    {
      txid: gasUtxo.tx_hash,
      vout: gasUtxo.tx_pos,
      satoshis: BigInt(gasUtxo.value),
      lockingBytecode: keyDetails.p2pkhBytecodeHex,
    },
    template.unlockP2PKH(),
  );

  // Output 0: HTLC output
  b.addOutput({
    to: htlcAddress,
    amount: terms.bchCarrySats,
    token: {
      category: cleanCategory,
      amount: terms.bchTokenAmount,
    },
  });

  // Output 1: Token change (if any)
  const tokenChange =
    BigInt(tokenUtxo.token_data!.amount) - terms.bchTokenAmount;
  let tokenChangeSats = 0n;
  if (tokenChange > 0n) {
    tokenChangeSats = 3000n;
    b.addOutput({
      to: keyDetails.p2pkhBytecode,
      amount: tokenChangeSats,
      token: {
        category: cleanCategory,
        amount: tokenChange,
      },
    });
  }

  // Output 2: BCH change
  const fee = 1000n;
  const totalIn = BigInt(tokenUtxo.value) + BigInt(gasUtxo.value);
  const bchChange = totalIn - terms.bchCarrySats - tokenChangeSats - fee;
  if (bchChange < 546n) {
    throw new Error(`Insufficient sats for change output: ${bchChange}`);
  }

  b.addOutput({
    to: keyDetails.p2pkhBytecode,
    amount: bchChange,
  });

  const txHex = b.build();
  const txid = computeTxId(txHex);

  return {
    txHex,
    txid,
    vout: 0,
    satoshis: terms.bchCarrySats,
    contractScriptHash,
    htlcAddress,
  };
}

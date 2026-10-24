import {
  Contract,
  MockNetworkProvider,
  type NetworkProvider,
  Network,
  type Unlocker,
} from 'cashscript';
import {
  hexToBin,
  sha256,
  cashAddressToLockingBytecode,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import artifact from './artifact.json' with { type: 'json' };
import type {
  BchHtlcParameters,
  HtlcInputTerms,
  CashAddressNetwork,
  HtlcAddressDerivationResult,
  OrderTerms,
} from './types.js';
import { displayToInternalCategory } from './byte-order.js';

export { artifact };

export type HtlcContract = Contract & {
  unlock: {
    claim: (secret: Uint8Array) => Unlocker;
    refund: () => Unlocker;
  };
};

/**
 * Normalise locking bytecode input from either CashAddress or raw hex/Uint8Array.
 */
function resolveLockingBytecode(
  addressOrBytecode: string | Uint8Array,
): Uint8Array {
  if (typeof addressOrBytecode === 'string') {
    const trimmed = addressOrBytecode.trim();
    if (
      trimmed.startsWith('bitcoincash:') ||
      trimmed.startsWith('bchtest:') ||
      trimmed.startsWith('bchreg:')
    ) {
      const decoded = cashAddressToLockingBytecode(trimmed);
      if (typeof decoded === 'string') {
        throw new Error(`Failed to decode CashAddress: ${decoded}`);
      }
      return decoded.bytecode;
    }
    const cleanHex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
    return hexToBin(cleanHex);
  }
  return addressOrBytecode;
}

/**
 * Normalise input parameters into canonical BchHtlcParameters.
 * Accepts either full @ferry/core OrderTerms or individual HtlcInputTerms.
 * Converts display-order category to internal byte order unless specified otherwise.
 */
export function encodeHtlcParameters(
  terms: OrderTerms | HtlcInputTerms,
): BchHtlcParameters {
  if ('direction' in terms && 'bchTokenCategory' in terms) {
    const isForward = terms.direction === 'COUNTER_TO_BCH';
    const recipientLockingBytecode = resolveLockingBytecode(
      isForward ? terms.userBchLockingBytecode : terms.solverBchLockingBytecode,
    );
    const refundLockingBytecode = resolveLockingBytecode(
      isForward ? terms.solverBchLockingBytecode : terms.userBchLockingBytecode,
    );
    const hashLockBytes = hexToBin(
      terms.hashLock.startsWith('0x')
        ? terms.hashLock.slice(2)
        : terms.hashLock,
    );
    const tokenCategory = displayToInternalCategory(terms.bchTokenCategory);

    return {
      hashLock: hashLockBytes,
      recipientLockingBytecode,
      refundLockingBytecode,
      tokenCategory,
      tokenAmount: terms.bchTokenAmount,
      refundHeight: terms.bchRefundHeight,
      maxFee: terms.bchMaxFee,
    };
  }

  let hashLockBytes: Uint8Array;
  if (terms.hashLock) {
    hashLockBytes =
      typeof terms.hashLock === 'string'
        ? hexToBin(
            terms.hashLock.startsWith('0x')
              ? terms.hashLock.slice(2)
              : terms.hashLock,
          )
        : terms.hashLock;
  } else if (terms.secret) {
    const secretBytes =
      typeof terms.secret === 'string'
        ? hexToBin(
            terms.secret.startsWith('0x')
              ? terms.secret.slice(2)
              : terms.secret,
          )
        : terms.secret;
    if (secretBytes.length !== 32) {
      throw new Error(
        `Invalid secret length: expected 32 bytes, got ${secretBytes.length}`,
      );
    }
    hashLockBytes = sha256.hash(secretBytes);
  } else {
    throw new Error('Either hashLock or secret must be provided');
  }

  if (hashLockBytes.length !== 32) {
    throw new Error(
      `Invalid hashLock length: expected 32 bytes, got ${hashLockBytes.length}`,
    );
  }

  const recipientLockingBytecode = resolveLockingBytecode(
    terms.recipientLockingBytecode ?? terms.recipientAddress!,
  );
  const refundLockingBytecode = resolveLockingBytecode(
    terms.refundLockingBytecode ?? terms.refundAddress!,
  );

  let tokenCategory: Uint8Array;
  if (typeof terms.tokenCategory === 'string') {
    tokenCategory = terms.tokenCategoryIsInternal
      ? hexToBin(
          terms.tokenCategory.startsWith('0x')
            ? terms.tokenCategory.slice(2)
            : terms.tokenCategory,
        )
      : displayToInternalCategory(terms.tokenCategory);
  } else {
    tokenCategory = terms.tokenCategory;
  }

  if (tokenCategory.length !== 32) {
    throw new Error(
      `Invalid tokenCategory length: expected 32 bytes, got ${tokenCategory.length}`,
    );
  }

  const tokenAmount = BigInt(terms.tokenAmount);
  if (tokenAmount <= 0n) {
    throw new Error(
      `Invalid tokenAmount: must be positive, got ${tokenAmount}`,
    );
  }

  const refundHeight = Number(terms.refundHeight);
  if (refundHeight >= 500_000_000 || refundHeight < 0) {
    throw new Error(
      `Invalid refundHeight: must be block height (< 500,000,000), got ${refundHeight}`,
    );
  }

  const maxFee = terms.maxFee !== undefined ? BigInt(terms.maxFee) : 1500n;

  return {
    hashLock: hashLockBytes,
    recipientLockingBytecode,
    refundLockingBytecode,
    tokenCategory,
    tokenAmount,
    refundHeight,
    maxFee,
  };
}

/**
 * Instantiate CashScript Contract instance for FerryHTLC.
 */
export function getHtlcContract(
  params: BchHtlcParameters,
  options?: { provider?: NetworkProvider; network?: CashAddressNetwork },
): HtlcContract {
  let provider = options?.provider;
  if (!provider) {
    const mock = new MockNetworkProvider();
    mock.network =
      options?.network === 'mainnet' ? Network.MAINNET : Network.CHIPNET;
    provider = mock;
  }

  const constructorArgs = [
    params.hashLock,
    params.recipientLockingBytecode,
    params.refundLockingBytecode,
    params.tokenCategory,
    params.tokenAmount,
    BigInt(params.refundHeight),
    params.maxFee,
  ];

  return new Contract(artifact, constructorArgs, {
    provider,
  }) as unknown as HtlcContract;
}

/**
 * Derive CashAddresses (P2SH32 standard and token-aware), redeem script, and locking bytecode.
 */
export function deriveHtlcAddresses(
  params: BchHtlcParameters,
  network: CashAddressNetwork = 'chipnet',
): HtlcAddressDerivationResult {
  const contract = getHtlcContract(params, { network });
  const lockingBytecodeBytes = hexToBin(contract.lockingBytecode);
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';

  const p2sh32Res = lockingBytecodeToCashAddress({
    bytecode: lockingBytecodeBytes,
    prefix,
    tokenSupport: false,
  });
  if (typeof p2sh32Res === 'string') {
    throw new Error(`Failed to encode P2SH32 CashAddress: ${p2sh32Res}`);
  }

  const tokenRes = lockingBytecodeToCashAddress({
    bytecode: lockingBytecodeBytes,
    prefix,
    tokenSupport: true,
  });
  if (typeof tokenRes === 'string') {
    throw new Error(`Failed to encode token CashAddress: ${tokenRes}`);
  }

  return {
    p2sh32Address: p2sh32Res.address,
    tokenAddress: tokenRes.address,
    redeemScript: hexToBin(contract.bytecode),
    lockingBytecode: lockingBytecodeBytes,
  };
}

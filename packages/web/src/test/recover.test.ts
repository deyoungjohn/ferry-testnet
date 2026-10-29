import { serializeApiJson } from '@ferry/core';
import { describe, expect, it } from 'vitest';
import { parseBchAddress } from '../lib/bch/address';
import {
  buildRecoveryFile,
  parseRecoveryFile,
  type RecoveryFile,
} from '../lib/recovery';
import { createMockSolverClient } from '../lib/solver/mock';
import { generateSecret, hashLockForSecret } from '../lib/swap';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';
import { evmLockId } from '@ferry/core';
import {
  broadcastBchClaim,
  electrumScripthash,
  evmClaimCalldata,
  evmLockIdForFile,
  evmRefundCalldata,
  isReverseOrder,
  findHtlcUtxo,
  parseRecoveryJson,
  validateRecoveryFile,
  type ElectrumUtxo,
} from '../recover/core';

const bchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!bchResult.ok) throw new Error(bchResult.error);
const bchAddress = bchResult.value;

async function recoveryFile(): Promise<RecoveryFile> {
  const solver = createMockSolverClient();
  const quote = await solver.quote({
    direction: 'COUNTER_TO_BCH',
    bchToken: 'PUSD',
    counterChain: 'base',
    counterSymbol: 'USDC',
    amountIn: 10_000_000n,
    userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    userBchLockingBytecode: bchAddress.lockingBytecode,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe',
  });
  return buildRecoveryFile(quote.orderId, quote.terms, generateSecret());
}

describe('recovery validation', () => {
  it('accepts a locally generated file and round-trips through JSON', async () => {
    const file = await recoveryFile();
    const parsed = parseRecoveryFile(file);
    expect(validateRecoveryFile(parsed).orderId).toBe(file.orderId);
    expect(parseRecoveryJson(serializeApiJson(file)).secret).toBe(file.secret);
  });

  it('rejects an HTLC address that does not match the terms', async () => {
    const file = await recoveryFile();
    const tampered = {
      ...file,
      contracts: {
        ...file.contracts,
        bch: {
          ...file.contracts.bch,
          htlcAddress: 'bchtest:pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        },
      },
    };
    expect(() => validateRecoveryFile(tampered)).toThrow(
      'BCH HTLC address does not match the recovered terms',
    );
  });

  it('rejects a token address that does not match the terms', async () => {
    const file = await recoveryFile();
    const tampered = {
      ...file,
      contracts: {
        ...file.contracts,
        bch: {
          ...file.contracts.bch,
          tokenAddress: 'bchtest:pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        },
      },
    };
    expect(() => validateRecoveryFile(tampered)).toThrow(
      'BCH token address does not match the recovered terms',
    );
  });

  it('rejects a redeem script or locking bytecode that does not match', async () => {
    const file = await recoveryFile();
    const badRedeem = {
      ...file,
      contracts: {
        ...file.contracts,
        bch: { ...file.contracts.bch, redeemScript: '0x00' as const },
      },
    };
    expect(() => validateRecoveryFile(badRedeem)).toThrow(
      'BCH redeem script does not match the recovered terms',
    );
    const badLocking = {
      ...file,
      contracts: {
        ...file.contracts,
        bch: { ...file.contracts.bch, lockingBytecode: '0x00' as const },
      },
    };
    expect(() => validateRecoveryFile(badLocking)).toThrow(
      'BCH locking bytecode does not match the recovered terms',
    );
  });

  it('rejects an order id or EVM code hash that does not match', async () => {
    const file = await recoveryFile();
    const badOrder = {
      ...file,
      orderId: `0x${'11'.repeat(32)}` as RecoveryFile['orderId'],
    };
    expect(() => validateRecoveryFile(badOrder)).toThrow(
      'Recovery file order id does not match its terms',
    );
    const badCode = {
      ...file,
      contracts: {
        ...file.contracts,
        evm: {
          ...file.contracts.evm,
          codeHash:
            `0x${'00'.repeat(32)}` as RecoveryFile['contracts']['evm']['codeHash'],
        },
      },
    };
    expect(() => validateRecoveryFile(badCode)).toThrow(
      'EVM contract bytecode hash does not match',
    );
  });

  it('carries the active network and refuses a file from another network', async () => {
    const file = await recoveryFile();
    expect(file.contracts.bch.network).toBe('chipnet');
    const wrongBchNetwork = {
      ...file,
      contracts: {
        ...file.contracts,
        bch: { ...file.contracts.bch, network: 'mainnet' as const },
      },
    };
    expect(() => validateRecoveryFile(wrongBchNetwork)).toThrow(
      /wrong network/,
    );
    const wrongEvmChain = {
      ...file,
      contracts: {
        ...file.contracts,
        evm: { ...file.contracts.evm, chainId: 8453 },
      },
    };
    expect(() => validateRecoveryFile(wrongEvmChain)).toThrow(/wrong network/);
  });

  it('rejects unknown fields and malformed JSON', async () => {
    const file = await recoveryFile();
    expect(() => parseRecoveryFile({ ...file, unexpected: true })).toThrow();
    expect(() => parseRecoveryJson('{')).toThrow(
      'Recovery file is not valid JSON',
    );
  });
});

describe('recovery helpers', () => {
  it('matches only the HTLC UTXO with the expected token amount', async () => {
    const file = await recoveryFile();
    const utxos: ElectrumUtxo[] = [
      {
        txid: 'aa'.repeat(32),
        vout: 0,
        satoshis: 1_000n,
        height: 1,
        category: file.terms.bchTokenCategory,
        amount: file.terms.bchTokenAmount + 1n,
      },
      {
        txid: 'bb'.repeat(32),
        vout: 1,
        satoshis: 1_000n,
        height: 1,
        category: file.terms.bchTokenCategory,
        amount: file.terms.bchTokenAmount,
      },
      {
        txid: 'cc'.repeat(32),
        vout: 2,
        satoshis: 1_000n,
        height: 1,
        category: file.terms.bchTokenCategory.replace(/^0x/, ''),
        amount: file.terms.bchTokenAmount,
      },
    ];
    expect(findHtlcUtxo(utxos, file)?.txid).toBe('bb'.repeat(32));
    expect(findHtlcUtxo([utxos[2]!], file)?.txid).toBe('cc'.repeat(32));
    expect(findHtlcUtxo([utxos[0]!], file)).toBeNull();
  });

  it('derives an Electrum scripthash and refund calldata', async () => {
    const file = await recoveryFile();
    const scripthash = electrumScripthash(file.contracts.bch.lockingBytecode);
    expect(scripthash).toMatch(/^[0-9a-f]{64}$/);
    expect(electrumScripthash(file.contracts.bch.lockingBytecode)).toBe(
      scripthash,
    );
    expect(evmRefundCalldata(file)).toMatch(/^0x[0-9a-f]{8}/);
  });
});

describe('reverse (BCH to Base) recovery files', () => {
  async function reverseFile(): Promise<RecoveryFile> {
    const file = await recoveryFile();
    return {
      ...file,
      terms: { ...file.terms, direction: 'BCH_TO_COUNTER' },
    };
  }

  it('identifies the direction and uses the solver as the Base locker', async () => {
    const forward = await recoveryFile();
    const reverse = await reverseFile();
    expect(isReverseOrder(forward)).toBe(false);
    expect(isReverseOrder(reverse)).toBe(true);
    expect(evmLockIdForFile(forward)).toBe(
      evmLockId(forward.terms.userCounterAddress, forward.terms.hashLock),
    );
    expect(evmLockIdForFile(reverse)).toBe(
      evmLockId(reverse.terms.solverCounterAddress, reverse.terms.hashLock),
    );
    expect(evmClaimCalldata(reverse)).not.toBe(evmRefundCalldata(reverse));
  });

  it('refuses to claim the BCH lock, which would pay the solver', async () => {
    const reverse = await reverseFile();
    await expect(
      broadcastBchClaim(
        reverse,
        { txid: '00'.repeat(32), vout: 0, satoshis: 1000n } as ElectrumUtxo,
        'wss://invalid.example',
      ),
    ).rejects.toThrow(/pays the solver/);
  });
});

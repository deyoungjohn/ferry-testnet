import {
  binToHex,
  encodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { describe, expect, it, vi } from 'vitest';
import { parseBchAddress } from '../lib/bch/address';
import { MOCK_BCH_USER_ADDRESS, PUSD_CATEGORY } from '../lib/config';
import {
  asPaytacaProvider,
  buildSpikeTokenLock,
  connectPaytaca,
  detectProvider,
  inspectSignedSpikeLock,
  normalizeProviderAddress,
  type PaytacaProvider,
} from '../lib/wallet/extension-spike';

function userAddress() {
  const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function legacyAddress(
  prefix: 'bchtest' | 'bitcoincash',
  tokenSupport: boolean,
) {
  const encoded = lockingBytecodeToCashAddress({
    bytecode: hexToBin(userAddress().lockingBytecode.slice(2)),
    prefix,
    tokenSupport,
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}

describe('wallet extension provider detection', () => {
  it('accepts a legacy Paytaca connector with the required methods', () => {
    const raw = {
      connect: vi.fn(async () => ({ connected: true })),
      address: vi.fn(async () => legacyAddress('bchtest', false)),
      signTransaction: vi.fn(async () => undefined),
    };
    const provider = asPaytacaProvider(raw);
    expect(provider).not.toBeNull();
    expect(detectProvider({ paytaca: raw }).paytaca).not.toBeNull();
  });

  it('rejects partial or unrelated globals', () => {
    expect(asPaytacaProvider({ connect: vi.fn() })).toBeNull();
    expect(
      detectProvider({ paytaca: { address: vi.fn() } }).paytaca,
    ).toBeNull();
    expect(detectProvider({}).paytaca).toBeNull();
  });

  it('connects and normalizes a plain P2PKH address to token-aware', async () => {
    const rawAddress = legacyAddress('bchtest', false);
    const provider = asPaytacaProvider({
      connect: vi.fn(async () => ({ connected: true, address: rawAddress })),
      address: vi.fn(async () => rawAddress),
      signTransaction: vi.fn(async () => undefined),
    }) as PaytacaProvider;
    const address = await connectPaytaca(provider);
    expect(address.address.startsWith('bchtest:z')).toBe(true);
    expect(address.lockingBytecode).toBe(userAddress().lockingBytecode);
  });

  it('falls back to address() when connect() returns no address', async () => {
    const rawAddress = legacyAddress('bchtest', true);
    const provider = asPaytacaProvider({
      connect: vi.fn(async () => undefined),
      address: vi.fn(async () => rawAddress),
      signTransaction: vi.fn(async () => undefined),
    }) as PaytacaProvider;
    await expect(connectPaytaca(provider)).resolves.toMatchObject({
      address: rawAddress,
    });
  });

  it('refuses mainnet and non-P2PKH addresses', () => {
    expect(() =>
      normalizeProviderAddress(legacyAddress('bitcoincash', true)),
    ).toThrow(/chipnet/);
    expect(() => normalizeProviderAddress('not-an-address')).toThrow(
      /network prefix/,
    );
  });
});

describe('fixed P2SH32 token lock', () => {
  function build() {
    return buildSpikeTokenLock({
      address: userAddress(),
      funding: {
        tipHeight: 200_000,
        utxos: [
          {
            txid: '11'.repeat(32),
            vout: 0,
            satoshis: 10_000n,
            height: 199_990,
            category: PUSD_CATEGORY.replace(/^0x/, ''),
            amount: 2n,
          },
        ],
      },
    });
  }

  it('builds a token-aware P2SH32 output without broadcasting', () => {
    const lock = build();
    expect(lock.p2sh32Address.startsWith('bchtest:p')).toBe(true);
    expect(lock.tokenAddress.startsWith('bchtest:r')).toBe(true);
    expect(lock.request.broadcast).toBe(false);
    expect(lock.tokenCategory).toBe(PUSD_CATEGORY.slice(2));
    expect(lock.request.transaction.outputs[0]?.token?.amount).toBe(1n);
  });

  it('requires a token UTXO', () => {
    expect(() =>
      buildSpikeTokenLock({
        address: userAddress(),
        funding: {
          tipHeight: 200_000,
          utxos: [
            {
              txid: '22'.repeat(32),
              vout: 0,
              satoshis: 10_000n,
              height: 199_990,
              category: null,
              amount: null,
            },
          ],
        },
      }),
    ).toThrow(/No CashToken UTXO/);
  });

  it('accepts a signed transaction with every input signed', () => {
    const lock = build();
    const signedTransaction = {
      ...lock.request.transaction,
      inputs: lock.request.transaction.inputs.map((input) => ({
        ...input,
        unlockingBytecode: new Uint8Array([1, 2, 3]),
      })),
    };
    const summary = inspectSignedSpikeLock(
      binToHex(encodeTransaction(signedTransaction)),
      lock,
    );
    expect(summary.signedInputs).toBe(summary.inputCount);
    expect(summary.tokenAmount).toBe(1n);
    expect(summary.p2sh32LockingBytecode).toBe(
      lock.p2sh32LockingBytecode.slice(2),
    );
  });

  it('rejects a wallet response that leaves an input unsigned', () => {
    const lock = build();
    expect(() => inspectSignedSpikeLock(lock.txHex, lock)).toThrow(
      /unsigned transaction/,
    );
  });
});

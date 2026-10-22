import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signOrderId, verifyOrderSignature } from '../src/signing.js';
import { orderId } from '../src/terms.js';
import { baseTerms } from './fixtures/terms.js';
describe('EIP-191 raw order-id signatures', () => {
  it('round-trips a runtime-generated signer, rejects hex text and another account', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const id = orderId(baseTerms);
    const signature = await signOrderId(id, account);
    expect(await verifyOrderSignature(id, signature, account.address)).toBe(
      true,
    );
    const textSignature = await account.signMessage({ message: id });
    expect(await verifyOrderSignature(id, textSignature, account.address)).toBe(
      false,
    );
    expect(
      await verifyOrderSignature(
        id,
        signature,
        privateKeyToAccount(generatePrivateKey()).address,
      ),
    ).toBe(false);
    expect(await verifyOrderSignature(id, '0x00', account.address)).toBe(false);
    expect(await verifyOrderSignature(id, signature, '0x00')).toBe(false);
    await expect(signOrderId('0x00', account)).rejects.toThrow();
  });
});

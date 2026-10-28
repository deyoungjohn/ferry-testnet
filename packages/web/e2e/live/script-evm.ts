import { parseExtendedJson } from '@wizardconnect/core';
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { Page } from '@playwright/test';

const noncesAbi = parseAbi([
  'function nonces(address owner) view returns (uint256)',
]);
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

export class ScriptEvmWallet {
  readonly address: Address;
  readonly #account: ReturnType<typeof privateKeyToAccount>;
  readonly #client = createPublicClient({
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  constructor(privateKey: Hex) {
    this.#account = privateKeyToAccount(privateKey);
    this.address = this.#account.address;
  }

  async readPermitNonce(): Promise<string> {
    const nonce = await this.#client.readContract({
      address: USDC_ADDRESS,
      abi: noncesAbi,
      functionName: 'nonces',
      args: [this.address],
    });
    return nonce.toString();
  }

  async signTypedData(typedDataWire: string): Promise<string> {
    const typedData = parseExtendedJson(typedDataWire) as TypedDataDefinition;
    return this.#account.signTypedData(typedData);
  }

  async attach(page: Page): Promise<void> {
    await page.exposeFunction('__ferryScriptEvmNonce', () =>
      this.readPermitNonce(),
    );
    await page.exposeFunction('__ferryScriptEvmSign', (typedDataWire: string) =>
      this.signTypedData(typedDataWire),
    );
    await page.addInitScript(
      ({ address }) => {
        const target = window as unknown as {
          __ferryScriptEvm?: unknown;
          __ferryScriptEvmNonce: () => Promise<string>;
          __ferryScriptEvmSign: (wire: string) => Promise<string>;
        };
        target.__ferryScriptEvm = {
          address,
          readPermitNonce: () => target.__ferryScriptEvmNonce(),
          signTypedData: (wire: string) => target.__ferryScriptEvmSign(wire),
        };
      },
      { address: this.address },
    );
  }
}

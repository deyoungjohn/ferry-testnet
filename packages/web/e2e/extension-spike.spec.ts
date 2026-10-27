import {
  binToHex,
  encodeTransaction,
  hexToBin,
  sha256,
} from '@bitauth/libauth';
import { expect, test } from '@playwright/test';
import { parseBchAddress } from '../src/lib/bch/address';
import { MOCK_BCH_USER_ADDRESS, PUSD_CATEGORY } from '../src/lib/config';
import { buildSpikeTokenLock } from '../src/lib/wallet/extension-spike';

const tipHeight = 200_000;
const tokenUtxo = {
  txid: '11'.repeat(32),
  vout: 0,
  satoshis: 10_000n,
  height: 199_990,
  category: PUSD_CATEGORY.replace(/^0x/, ''),
  amount: 2n,
};

function signedFixture() {
  const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
  if (!parsed.ok) throw new Error(parsed.error);
  const lock = buildSpikeTokenLock({
    address: parsed.value,
    funding: { tipHeight, utxos: [tokenUtxo] },
  });
  const signedTransaction = {
    ...lock.request.transaction,
    inputs: lock.request.transaction.inputs.map((input) => ({
      ...input,
      unlockingBytecode: new Uint8Array([1, 2, 3]),
    })),
  };
  const signedTransactionHex = binToHex(encodeTransaction(signedTransaction));
  return {
    signedTransactionHex,
    signedTransactionHash: txidOf(signedTransactionHex),
  };
}

function txidOf(txHex: string): string {
  const second = sha256.hash(sha256.hash(hexToBin(txHex)));
  second.reverse();
  return binToHex(second);
}

test('injected provider can fetch an address and sign a P2SH32 token lock', async ({
  page,
}) => {
  const { signedTransactionHex, signedTransactionHash } = signedFixture();

  await page.routeWebSocket(/chipnet\.imaginary\.cash/, (ws) => {
    ws.onMessage((message) => {
      const request = JSON.parse(String(message)) as {
        id?: number;
        method?: string;
      };
      if (typeof request.id !== 'number') return;
      if (request.method === 'server.version') {
        ws.send(
          JSON.stringify({ id: request.id, result: ['Ferry probe', '1.4'] }),
        );
        return;
      }
      if (request.method === 'blockchain.headers.subscribe') {
        ws.send(
          JSON.stringify({ id: request.id, result: { height: tipHeight } }),
        );
        return;
      }
      if (request.method === 'blockchain.scripthash.listunspent') {
        ws.send(
          JSON.stringify({
            id: request.id,
            result: [
              {
                tx_hash: tokenUtxo.txid,
                tx_pos: tokenUtxo.vout,
                value: Number(tokenUtxo.satoshis),
                height: tokenUtxo.height,
                token_data: {
                  category: tokenUtxo.category,
                  amount: Number(tokenUtxo.amount),
                },
              },
            ],
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          id: request.id,
          error: { message: 'unknown method' },
        }),
      );
    });
  });

  await page.addInitScript(
    ({ address, signedHex, signedHash }) => {
      const target = window as unknown as {
        paytaca?: unknown;
        __spikeCalls?: unknown[];
      };
      target.__spikeCalls = [];
      target.paytaca = {
        connect: async () => ({ connected: true, address }),
        address: async () => address,
        connected: async () => true,
        signTransaction: async (request: {
          broadcast?: boolean;
          userPrompt?: string;
          transaction?: {
            inputs?: unknown[];
            outputs?: { token?: { amount?: bigint } }[];
          };
        }) => {
          target.__spikeCalls?.push({
            broadcast: request.broadcast,
            userPrompt: request.userPrompt,
            inputCount: request.transaction?.inputs?.length ?? 0,
            tokenOutput: Boolean(request.transaction?.outputs?.[0]?.token),
          });
          return {
            signedTransaction: signedHex,
            signedTransactionHash: signedHash,
          };
        },
      };
    },
    {
      address: MOCK_BCH_USER_ADDRESS,
      signedHex: signedTransactionHex,
      signedHash: signedTransactionHash,
    },
  );

  await page.goto('/dev/wallet-extension');
  await expect(
    page.getByRole('heading', { name: 'Wallet-extension probe.' }),
  ).toBeVisible();
  await expect(page.getByText('provider found')).toBeVisible();

  await page.getByRole('button', { name: 'Connect Paytaca' }).click();
  await expect(page.getByText('Tip 200,000')).toBeVisible();
  await expect(page.getByText('1 CashToken UTXO found')).toBeVisible();

  await page.getByRole('button', { name: 'Build P2SH32 token lock' }).click();
  await expect(page.getByText('Fixed test lock')).toBeVisible();
  await expect(page.getByText('not broadcast')).toBeVisible();

  await page.getByRole('button', { name: 'Sign in Paytaca' }).click();
  await expect(page.getByText('Signature returned')).toBeVisible();
  await expect(page.getByText('1/1')).toBeVisible();
  await expect(page.getByText(/matches/)).toBeVisible();

  const calls = await page.evaluate(
    () =>
      (window as unknown as { __spikeCalls?: unknown[] }).__spikeCalls ?? [],
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    broadcast: false,
    inputCount: 1,
    tokenOutput: true,
  });
});

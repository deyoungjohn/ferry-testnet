import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { serializeApiJson } from '@ferry/core';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { WebSocketServer } from 'ws';
import { ferryHtlcAbi } from '@ferry/htlc-evm/abi';
import { parseBchAddress } from '../../src/lib/bch/address';
import {
  FERRY_HTLC_ADDRESS,
  MOCK_BCH_USER_ADDRESS,
} from '../../src/lib/config';
import { FERRY_HTLC_DEPLOYED_BYTECODE } from '../../src/lib/contract-bytecode';
import { buildRecoveryFile, type RecoveryFile } from '../../src/lib/recovery';
import { createMockSolverClient } from '../../src/lib/solver/mock';
import { generateSecret, hashLockForSecret } from '../../src/lib/swap';
import { evmLockId } from '@ferry/core';

const RPC_URL = 'http://127.0.0.1:8545';
const mockTokenAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const USER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' as Address;
const SOLVER_RECIPIENT =
  '0x000000000000000000000000000000000000bEEF' as Address;
const FILE_PATH = fileURLToPath(
  new URL('../../../../recover.html', import.meta.url),
);
const MOCK_USDC_ARTIFACT = fileURLToPath(
  new URL(
    '../../../../packages/htlc-evm/out/MockUSDCWithPermit.sol/MockUSDCWithPermit.json',
    import.meta.url,
  ),
);

type RpcLog = { readonly method: string; readonly params: readonly unknown[] };

let server: WebSocketServer;
let electrumUrl: string;
let file: RecoveryFile;
let token: Address;
let mockTip = 100;
let mockUtxoVisible = true;
let lockId: Hex;
const requests: RpcLog[] = [];
const broadcasts: string[] = [];

async function rpc<T>(
  method: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? 'RPC error');
  return body.result as T;
}

async function sendTransaction(transaction: {
  readonly from: Address;
  readonly to?: Address;
  readonly data: Hex;
}): Promise<Hex> {
  return rpc<Hex>('eth_sendTransaction', [
    {
      from: transaction.from,
      ...(transaction.to ? { to: transaction.to } : {}),
      data: transaction.data,
      gas: '0x1000000',
    },
  ]);
}

async function waitForReceipt(hash: Hex): Promise<{
  readonly contractAddress?: Address;
  readonly status: string;
}> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await rpc<{
      contractAddress?: Address;
      status: string;
    } | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Transaction was not mined');
}

test.beforeAll(async () => {
  const bch = parseBchAddress(MOCK_BCH_USER_ADDRESS);
  if (!bch.ok) throw new Error(bch.error);
  const solver = createMockSolverClient();
  const quote = await solver.quote({
    direction: 'COUNTER_TO_BCH',
    bchToken: 'PUSD',
    counterChain: 'base',
    counterSymbol: 'USDC',
    amountIn: 10_000_000n,
    userCounterAddress: USER,
    userBchLockingBytecode: bch.value.lockingBytecode,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe',
  });
  file = buildRecoveryFile(quote.orderId, quote.terms, generateSecret());
  lockId = evmLockId(file.terms.userCounterAddress, file.terms.hashLock);

  server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  electrumUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as {
        readonly id?: number;
        readonly method?: string;
        readonly params?: readonly unknown[];
      };
      if (typeof message.id !== 'number' || !message.method) return;
      const params = message.params ?? [];
      requests.push({ method: message.method, params });
      let result: unknown;
      if (message.method === 'server.version') {
        result = ['Ferry recover', '1.4'];
      } else if (message.method === 'blockchain.headers.subscribe') {
        result = { height: mockTip };
      } else if (message.method === 'blockchain.scripthash.listunspent') {
        result = mockUtxoVisible
          ? [
              {
                tx_hash: 'aa'.repeat(32),
                tx_pos: 0,
                value: 3_000,
                height: 99,
                token_data: {
                  category: file.terms.bchTokenCategory,
                  amount: file.terms.bchTokenAmount.toString(),
                },
              },
            ]
          : [];
      } else if (message.method === 'blockchain.transaction.broadcast') {
        broadcasts.push(String(params[0]));
        result = 'bb'.repeat(32);
      } else {
        result = null;
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });

  await rpc('anvil_setCode', [
    FERRY_HTLC_ADDRESS,
    FERRY_HTLC_DEPLOYED_BYTECODE,
  ]);
  const artifact = JSON.parse(readFileSync(MOCK_USDC_ARTIFACT, 'utf8')) as {
    readonly bytecode: { readonly object: string };
  };
  const deployHash = await sendTransaction({
    from: USER,
    data: artifact.bytecode.object as Hex,
  });
  const deployed = await waitForReceipt(deployHash);
  if (!deployed.contractAddress) throw new Error('Mock token did not deploy');
  token = deployed.contractAddress;

  const mintHash = await sendTransaction({
    from: USER,
    to: token,
    data: encodeFunctionData({
      abi: mockTokenAbi,
      functionName: 'mint',
      args: [USER, file.terms.counterAmount],
    }),
  });
  await waitForReceipt(mintHash);
  const approveHash = await sendTransaction({
    from: USER,
    to: token,
    data: encodeFunctionData({
      abi: mockTokenAbi,
      functionName: 'approve',
      args: [FERRY_HTLC_ADDRESS, file.terms.counterAmount],
    }),
  });
  await waitForReceipt(approveHash);

  const lockHash = await sendTransaction({
    from: USER,
    to: FERRY_HTLC_ADDRESS,
    data: encodeFunctionData({
      abi: ferryHtlcAbi,
      functionName: 'lock',
      args: [
        token,
        SOLVER_RECIPIENT,
        file.terms.counterAmount,
        file.terms.hashLock,
        BigInt(file.terms.counterDeadline),
      ],
    }),
  });
  await waitForReceipt(lockHash);
  await rpc('evm_setNextBlockTimestamp', [
    Number(file.terms.counterDeadline) + 1,
  ]);
  await rpc('evm_mine', []);
});

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('E2E-07 BCH claim from file:// with a mocked Electrum', async ({
  page,
}) => {
  await page.goto(pathToFileURL(FILE_PATH).href);
  await expect(
    page.getByRole('heading', { level: 1, name: /finish without us/i }),
  ).toBeVisible();
  await page.locator('#recovery-file').setInputFiles({
    name: 'ferry-recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeApiJson(file)),
  });
  await expect(page.locator('#file-status')).toContainText(
    'recomputed and matches',
  );
  await expect(page.locator('#summary-card')).toBeVisible();
  await page.locator('#electrum-url').fill(electrumUrl);
  await page.locator('#base-rpc-url').fill(RPC_URL);
  await page.getByRole('button', { name: 'Check both chains' }).click();
  await expect(page.locator('#check-status')).toContainText('BCH tip 100');
  await expect(page.getByRole('button', { name: 'Claim BCH' })).toBeVisible();
  await page.getByRole('button', { name: 'Claim BCH' }).click();
  await expect(page.locator('#action-status')).toContainText(
    'BCH claim broadcast',
  );
  expect(broadcasts.length).toBe(1);
  expect(broadcasts[0]?.length ?? 0).toBeGreaterThan(100);

  const secretHex = file.secret.slice(2);
  const leaked = requests.filter(
    (request) =>
      request.method !== 'blockchain.transaction.broadcast' &&
      JSON.stringify(request).includes(secretHex),
  );
  expect(leaked.length).toBe(0);
});

test('E2E-07 EVM refund when the solver never counter-locked', async ({
  page,
}) => {
  mockUtxoVisible = false;
  await page.exposeFunction(
    '__ferryRpc',
    (method: string, params: readonly unknown[]) => rpc(method, params),
  );
  await page.addInitScript(
    ({ user }) => {
      const bridge = (
        window as unknown as {
          __ferryRpc: (
            method: string,
            params: readonly unknown[],
          ) => Promise<unknown>;
        }
      ).__ferryRpc;
      Object.defineProperty(window, 'ethereum', {
        configurable: true,
        value: {
          request: async ({
            method,
            params = [],
          }: {
            method: string;
            params?: readonly unknown[];
          }) => {
            if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
              return [user];
            }
            if (method === 'eth_chainId') return '0x14a34';
            return bridge(method, params);
          },
        },
      });
    },
    { user: USER },
  );

  await page.goto(pathToFileURL(FILE_PATH).href);
  await page.locator('#recovery-file').setInputFiles({
    name: 'ferry-recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeApiJson(file)),
  });
  await expect(page.locator('#file-status')).toContainText(
    'recomputed and matches',
  );
  await page.locator('#electrum-url').fill(electrumUrl);
  await page.locator('#base-rpc-url').fill(RPC_URL);
  await page.getByRole('button', { name: 'Check both chains' }).click();
  await expect(page.locator('#check-status')).toContainText('BCH tip 100');
  await expect(page.getByRole('button', { name: 'Claim BCH' })).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Refund USDC with wallet' }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/recover-standalone.png',
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Refund USDC with wallet' }).click();
  await expect(page.locator('#action-status')).toContainText(
    'Base refund submitted',
  );
  const balance = await rpc<Hex>('eth_call', [
    {
      to: token,
      data: encodeFunctionData({
        abi: mockTokenAbi,
        functionName: 'balanceOf',
        args: [USER],
      }),
    },
    'latest',
  ]);
  expect(BigInt(balance)).toBe(file.terms.counterAmount);
  const lockState = await rpc<Hex>('eth_call', [
    {
      to: FERRY_HTLC_ADDRESS,
      data: encodeFunctionData({
        abi: ferryHtlcAbi,
        functionName: 'locks',
        args: [lockId],
      }),
    },
    'latest',
  ]);
  expect(Number(BigInt(lockState.slice(-64)))).toBe(3);
});

test('E2E-07 BCH refund after the refund height', async ({ page }) => {
  mockUtxoVisible = true;
  mockTip = file.terms.bchRefundHeight + 10;
  await page.goto(pathToFileURL(FILE_PATH).href);
  await page.locator('#recovery-file').setInputFiles({
    name: 'ferry-recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeApiJson(file)),
  });
  await expect(page.locator('#file-status')).toContainText(
    'recomputed and matches',
  );
  await page.locator('#electrum-url').fill(electrumUrl);
  await page.locator('#base-rpc-url').fill(RPC_URL);
  await page.getByRole('button', { name: 'Check both chains' }).click();
  await expect(page.locator('#check-status')).toContainText(
    `BCH tip ${mockTip}`,
  );
  await expect(page.getByRole('button', { name: 'Refund BCH' })).toBeVisible();
  await page.getByRole('button', { name: 'Refund BCH' }).click();
  await expect(page.locator('#action-status')).toContainText(
    'BCH refund broadcast',
  );
  expect(broadcasts.length).toBe(2);
});

test('E2E-07 refuses a recovery file whose BCH address was tampered with', async ({
  page,
}) => {
  await page.goto(pathToFileURL(FILE_PATH).href);
  const tampered = {
    ...file,
    contracts: {
      ...file.contracts,
      bch: {
        ...file.contracts.bch,
        htlcAddress: 'bchtest:zznldca5825k6le8hpnwxhzugn82j2gm8uzgy6y6j8',
      },
    },
  };
  await page.locator('#recovery-file').setInputFiles({
    name: 'ferry-tampered.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeApiJson(tampered)),
  });
  await expect(page.locator('#file-status')).toContainText(
    'does not match the recovered terms',
  );
  await expect(page.locator('#summary-card')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Claim BCH' })).toBeHidden();
});

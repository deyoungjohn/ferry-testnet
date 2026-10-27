import { test, expect } from '@playwright/test';
import { PUSD_CATEGORY } from '../../src/lib/config';
import {
  LIVE_SOLVER_URL,
  LIVE_SKIP_REASON,
  liveEnv,
  liveSolverReady,
} from './live-env';
import { ScriptBchWallet } from './script-wallet';

test('real reverse swap through the UI, script-signed BCH lock, gasless claim to DONE', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  test.skip(!(await liveSolverReady(request)), LIVE_SKIP_REASON);

  const fulcrumUrl = liveEnv('BCH_CHIPNET_ELECTRUM_URLS').split(',')[0]?.trim();
  if (!fulcrumUrl) throw new Error('No BCH_CHIPNET_ELECTRUM_URLS configured');

  const wallet = new ScriptBchWallet(liveEnv('USER_BCH_WIF'), fulcrumUrl);
  await wallet.connect();
  const utxos = await wallet.listUtxos();
  const category = PUSD_CATEGORY.replace(/^0x/, '').toLowerCase();
  const funding = utxos.find(
    (utxo) =>
      utxo.token?.category.replace(/^0x/, '').toLowerCase() === category &&
      BigInt(utxo.token.amount) >= 100n,
  );
  if (!funding) {
    wallet.close();
    test.skip(
      true,
      'The USER_BCH_WIF address has no 1.00 tPUSD UTXO; fund it before the live reverse proof.',
    );
  }

  await wallet.attach(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1&direction=reverse');

  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByLabel('You send amount').fill('1.00');
  await page.getByRole('button', { name: 'Fast ≤ $25' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();

  await expect(page.getByText('Live solver', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const recoveryButton = page.getByRole('button', {
    name: /Download recovery file/i,
  });
  await expect(recoveryButton).toBeVisible({ timeout: 30_000 });
  const recoveryDownload = page.waitForEvent('download');
  await recoveryButton.click();
  await recoveryDownload;

  const fundingPanel = page.getByText('Fund the BCH lock');
  await expect(fundingPanel).toBeVisible();
  const signButton = page.getByRole('button', { name: 'Sign with BCH wallet' });
  await expect(signButton).toBeEnabled();
  await signButton.click();

  await page.waitForURL(/\/swap\/0x[0-9a-f]{64}$/, { timeout: 120_000 });
  const orderId = page.url().split('/').at(-1);
  if (!orderId) throw new Error('Missing order id after funding');
  const lockAt = Date.now();

  const claimButton = page.getByRole('button', {
    name: 'Claim USDC (gasless)',
  });
  await expect(claimButton).toBeVisible({ timeout: 180_000 });
  const claimAt = Date.now();
  await claimButton.click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Done' }),
  ).toBeVisible({ timeout: 180_000 });
  const doneAt = Date.now();

  const links = await page
    .locator('a[href*="/tx/"]')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute('href')),
    );
  expect(links.some((href) => href?.includes('blockexplorer.cash'))).toBe(true);
  expect(links.some((href) => href?.includes('sepolia.basescan.org'))).toBe(
    true,
  );
  expect(links).toHaveLength(4);

  const orderResponse = await request.get(
    `${LIVE_SOLVER_URL}/v1/orders/${orderId}`,
  );
  expect(orderResponse.ok()).toBe(true);
  const order = (await orderResponse.json()) as {
    readonly status: string;
    readonly txIds: {
      readonly userLockTxId?: string;
      readonly solverLockTxId?: string;
      readonly userClaimTxId?: string;
      readonly solverClaimTxId?: string;
    };
  };
  expect(order.status).toBe('DONE');
  expect(wallet.signRequests).toHaveLength(1);
  expect(wallet.signRequests[0]?.broadcast).toBe(false);
  expect(JSON.stringify(wallet.signRequests[0]?.sourceOutputs)).toContain(
    '<bigint:',
  );
  expect(order.txIds.userLockTxId).toBe(wallet.broadcasts[0]);
  expect(order.txIds.solverLockTxId).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(order.txIds.userClaimTxId).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(order.txIds.solverClaimTxId).toMatch(/^[0-9a-fA-F]{64}$/);

  console.log(
    JSON.stringify(
      {
        orderId,
        txIds: order.txIds,
        timingsMs: {
          quoteAndLock: lockAt - startedAt,
          lockToClaim: claimAt - lockAt,
          claimToDone: doneAt - claimAt,
          total: doneAt - startedAt,
        },
      },
      null,
      2,
    ),
  );
  wallet.close();
});

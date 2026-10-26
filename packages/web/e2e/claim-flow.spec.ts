import { expect, test } from '@playwright/test';

async function reachStatus(page: import('@playwright/test').Page, query = '') {
  await page.goto(`/?mock=1${query}`);
  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();
  const downloadButton = page.getByRole('button', {
    name: /download recovery file/i,
  });
  await expect(downloadButton).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent('download');
  await downloadButton.click();
  await download;
  await page.getByRole('button', { name: /ferry it/i }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /lock|quote|seen/i,
  );
}

test('auto-claim shows a state, treats duplicate broadcast as success and reaches DONE', async ({
  page,
}) => {
  test.setTimeout(75_000);
  await reachStatus(
    page,
    '&claimBroadcastDuplicate=1&claimBroadcastDelayMs=1200',
  );
  await expect(page.getByText(/Claiming your tPUSD…/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole('heading', { level: 1, name: /done/i }),
  ).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText(/both sides settled/i)).toBeVisible();
});

test('remembered BCH wallet is a normal offline state and can be forgotten', async ({
  page,
}) => {
  await page.goto('/?mock=1&bchOffline=1');
  await expect(page.getByText(/Paytaca \(offline\)/i)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reconnect BCH' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Forget wallet' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Forget wallet' }).click();
  await expect(page.getByText(/Paytaca \(offline\)/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect BCH' })).toBeVisible();
});

test('claim stall after 90 seconds shows a next step', async ({ page }) => {
  test.setTimeout(75_000);
  await page.clock.install();
  await reachStatus(page, '&holdClaim=1');
  await expect(page.getByText(/Claim on chain, waiting/i)).toBeVisible({
    timeout: 20_000,
  });
  await page.clock.fastForward(91_000);
  await expect(
    page.getByText(/solver has not released USDC after 90 seconds/i),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/open recovery/i)).toBeVisible();
});

test('auto-claim needs no live BCH wallet', async ({ page }) => {
  test.setTimeout(75_000);
  await page.goto('/?mock=1&bchOffline=1&claimBroadcastDuplicate=1');
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();
  const downloadButton = page.getByRole('button', {
    name: /download recovery file/i,
  });
  await expect(downloadButton).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent('download');
  await downloadButton.click();
  await download;
  await page.getByRole('button', { name: /ferry it/i }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /done/i }),
  ).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText(/both sides settled/i)).toBeVisible();
});

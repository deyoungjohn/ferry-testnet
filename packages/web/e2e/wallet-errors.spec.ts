import { expect, test } from '@playwright/test';

async function prepareSwap(
  page: import('@playwright/test').Page,
  query: string,
) {
  await page.goto(`/?mock=1&${query}`);
  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();
  const downloadButton = page.getByRole('button', {
    name: /download recovery file/i,
  });
  await expect(downloadButton).toBeVisible({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await downloadButton.click();
  await download;
}

test('a wallet rejection clears the pending banner and shows the reason', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await prepareSwap(page, 'walletReject=1');
  await page.getByRole('button', { name: /ferry it/i }).click();
  await expect(page.getByRole('alert')).toContainText(
    /user rejected the request/i,
  );
  await expect(page.getByText(/waiting for your wallet/i)).toHaveCount(0);
});

test('a second wallet request names itself while pending', async ({ page }) => {
  test.setTimeout(45_000);
  await prepareSwap(page, 'walletDelayMs=1200');
  await page.getByRole('button', { name: /ferry it/i }).click();
  await expect(
    page.getByText(/waiting for your wallet: sign the usdc permit/i),
  ).toBeVisible();
  await expect(page.getByText(/open your wallet extension/i)).toBeVisible();
});

test('a quote expiring mid-signing locks nothing and says so', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await prepareSwap(page, 'quoteTtl=10&walletDelayMs=6000');
  await page.getByRole('button', { name: /ferry it/i }).click();
  await expect(
    page.getByText(/expired while your wallet was signing/i),
  ).toBeVisible({ timeout: 25_000 });
  await expect(page).toHaveURL(/\/\?mock=1/);
});

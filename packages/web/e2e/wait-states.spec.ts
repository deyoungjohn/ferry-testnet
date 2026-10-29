import { expect, test } from '@playwright/test';

async function reachReverseStatus(
  page: import('@playwright/test').Page,
  query: string,
): Promise<void> {
  await page.goto(`/?mock=1&direction=reverse&${query}`);
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
  await page.getByRole('button', { name: 'Sign with BCH wallet' }).click();
  await page.waitForURL(/\/swap\/0x[0-9a-f]{64}$/, { timeout: 20_000 });
}

test('safe reverse lane explains the BCH confirmation wait and stalls', async ({
  page,
}) => {
  test.setTimeout(75_000);
  await page.clock.install();
  await reachReverseStatus(page, 'holdStatus=USER_LOCK_SEEN');

  await expect(
    page.getByText('Waiting for 1 BCH confirmation (0 of 1)'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(/chipnet blocks can take several minutes/i),
  ).toBeVisible();
  await expect(page.getByText(/fast lane/i)).toBeVisible();
  await expect(page.getByText(/^Elapsed:/)).toBeVisible();
  await expect(page.getByText(/BCH lock ·/)).toBeVisible();

  await page.clock.fastForward(200_000);
  await expect(
    page.getByText(/This step is taking longer than expected/i),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('link', { name: 'Open Recovery' })).toBeVisible();
});

test('a solver-side BCH claim delay is separate from the user USDC arrival', async ({
  page,
}) => {
  test.setTimeout(75_000);
  await reachReverseStatus(page, 'holdAfterClaim=1');
  // The gasless USDC claim runs automatically.
  await expect(page.getByText('Your USDC arrived')).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText(/solver is finishing its BCH claim separately/i),
  ).toBeVisible();
  await expect(page.getByText(/Base claim ·/)).toBeVisible();
});

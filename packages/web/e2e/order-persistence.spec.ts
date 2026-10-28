import { expect, test } from '@playwright/test';

test('a created order survives a mock solver restart', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');

  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();

  const downloadButton = page.getByRole('button', {
    name: /download recovery file/i,
  });
  await expect(downloadButton).toBeVisible({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await downloadButton.click();
  const file = await download;
  const match = file
    .suggestedFilename()
    .match(/^ferry-(0x[0-9a-f]{64})\.json$/);
  expect(match).not.toBeNull();
  const orderId = match?.[1];
  expect(orderId).toBeDefined();

  await page.goto(`/swap/${orderId}?mock=1`);

  await expect(
    page.getByText(/solver has no record of this order/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/showing the last record saved in this browser/i),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download recovery file' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open recovery page' }),
  ).toBeVisible();
  await expect(page.getByText(/order not found/i)).toHaveCount(0);
});

test('an unknown order still explains that no local record exists', async ({
  page,
}) => {
  await page.goto(`/swap/0x${'99'.repeat(32)}?mock=1`);
  await expect(
    page.getByText('The solver has no record of this order.'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Code: ORDER_NOT_FOUND')).toBeVisible();
  await expect(
    page.getByText(/Showing the last record saved in this browser/i),
  ).toHaveCount(0);
});

import { expect, test } from '@playwright/test';

test('PL happy path: create an invoice, open it, quote and lock', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/pay?mock=1');

  await page.getByRole('button', { name: 'Connect BCH wallet' }).click();
  await page.getByRole('button', { name: 'Create pay link' }).click();

  await expect(page.getByText(/10 tPUSD invoice/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Verified').first()).toBeVisible();

  const preview = page.getByRole('link', { name: 'Preview' });
  const href = await preview.getAttribute('href');
  expect(href).toMatch(/^\/p\/[1-9A-HJ-NP-Za-km-z]+$/);
  expect(href).not.toContain('bchtest');
  expect(href).not.toContain('10');
  await preview.click();

  await expect(
    page.getByRole('heading', { level: 1, name: /pay 10 tPUSD/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get exact quote' }).click();

  await expect(page.getByText('You pay')).toBeVisible({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /download recovery file/i }).click();
  await download;
  await page.getByRole('button', { name: /pay .* USDC on Base/i }).click();

  await expect(page).toHaveURL(/\/swap\/0x[0-9a-f]{64}/, {
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /lock|quote|seen/i,
  );

  await page.screenshot({
    path: 'test-results/ui-paylink-happy.png',
    fullPage: true,
  });
});

test('PL reserved invoice blocks a second payer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/p/MockReservedLink1111?mock=1');

  await expect(
    page.getByRole('heading', { level: 1, name: /pay 40 tPUSD/i }),
  ).toBeVisible();
  await expect(page.getByText('This invoice is being paid.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Get exact quote' }),
  ).toBeDisabled();

  await page.screenshot({
    path: 'test-results/ui-paylink-reserved.png',
    fullPage: true,
  });
});

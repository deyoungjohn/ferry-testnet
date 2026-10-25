import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`home renders at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto('/?mock=1');

    await expect(
      page.getByRole('heading', { level: 1, name: /without a bridge/i }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Swap' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /get quote/i }),
    ).toBeVisible();

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: `test-results/home-${viewport.name}-${viewport.width}x${viewport.height}.png`,
      fullPage: false,
    });
  });
}

test('UI-01 happy path through DONE', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');

  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();

  await expect(
    page.getByRole('button', { name: /download recovery file/i }),
  ).toBeVisible({ timeout: 15_000 });

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /download recovery file/i }).click();
  await download;

  await page.getByRole('button', { name: /ferry it/i }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /lock|quote|seen/i,
  );

  await expect(page.getByRole('button', { name: 'Claim tPUSD' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Claim tPUSD' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: /done/i }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/both sides settled/i)).toBeVisible();

  await page.screenshot({
    path: 'test-results/ui-01-happy.png',
    fullPage: true,
  });
});

test('UI-01 refund path screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const orderId = `0x${'55'.repeat(32)}`;
  await page.goto(`/swap/${orderId}?mock=1&scenario=refund`);

  await expect(
    page.getByRole('heading', { level: 1, name: /rejected/i }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Refund USDC' })).toBeVisible();

  await page.getByRole('button', { name: 'Connect Base wallet' }).click();
  await expect(page.getByRole('button', { name: 'Refund USDC' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refund USDC' }).click();
  await expect(page.getByText(/refund submitted/i)).toBeVisible();

  await page.screenshot({
    path: 'test-results/ui-01-refund.png',
    fullPage: true,
  });
});

test('UI-03 reverse BCH to USDC happy path through DONE', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1&direction=reverse');

  await expect(
    page.getByRole('button', { name: 'Switch swap direction' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();

  await expect(
    page.getByRole('button', { name: /download recovery file/i }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: 'Sign with BCH wallet' }),
  ).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /download recovery file/i }).click();
  await download;

  await expect(
    page.getByRole('button', { name: 'Sign with BCH wallet' }),
  ).toBeVisible();
  await expect(page.getByText('QR / manual funding fallback')).toBeVisible();
  await page.getByRole('button', { name: 'Sign with BCH wallet' }).click();
  await expect(
    page.getByRole('button', { name: 'Claim USDC (gasless)' }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Claim USDC (gasless)' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: /done/i }),
  ).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText(/both sides settled/i)).toBeVisible();

  await page.screenshot({
    path: 'test-results/ui-03-reverse-happy.png',
    fullPage: true,
  });
});

test('UI-03 direction toggle quotes reverse without a query', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');

  const toggle = page.getByRole('button', { name: 'Switch swap direction' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();

  await expect(
    page.getByRole('button', { name: /download recovery file/i }),
  ).toBeVisible({ timeout: 15_000 });
});

test('UI-03 reverse BCH refund path screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const orderId = `0x${'66'.repeat(32)}`;
  await page.goto(`/swap/${orderId}?mock=1&scenario=refund&direction=reverse`);

  await expect(
    page.getByRole('heading', { level: 1, name: /rejected/i }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: 'Refund tPUSD' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Connect BCH wallet' }).click();
  await expect(
    page.getByRole('button', { name: 'Refund tPUSD' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Refund tPUSD' }).click();
  await expect(page.getByText(/BCH refund broadcast/i)).toBeVisible();

  await page.screenshot({
    path: 'test-results/ui-03-reverse-refund.png',
    fullPage: true,
  });
});

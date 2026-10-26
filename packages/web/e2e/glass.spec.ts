import { PNG } from 'pngjs';
import { expect, test } from '@playwright/test';
import { openWalletDialog } from './wallet-ready';

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(red: number, green: number, blue: number): number {
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

function contrast(foreground: number, background: number): number {
  const lighter = Math.max(foreground, background);
  const darker = Math.min(foreground, background);
  return (lighter + 0.05) / (darker + 0.05);
}

test('glass nav turns on after 24px of scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');

  const nav = page.locator('header[data-scrolled]');
  await expect(nav).toHaveAttribute('data-scrolled', 'false');
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(nav).toHaveAttribute('data-scrolled', 'true');
  await expect(nav).toHaveClass(/glass/);
  const box = await nav.boundingBox();
  expect(box?.y).toBeLessThanOrEqual(1);
});

test('wallet sheet uses glass, keeps two layers, and opens on mobile', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(page.locator('header[data-scrolled]')).toHaveAttribute(
    'data-scrolled',
    'true',
  );

  await openWalletDialog(page);
  await expect(page.locator('[data-glass-panel="modal"]')).toBeVisible();
  expect(await page.locator('.glass:visible').count()).toBe(2);

  await page.screenshot({
    path: 'test-results/glass-wallet-modal.png',
    fullPage: false,
  });

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-glass-panel="modal"]')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(page.locator('header[data-scrolled]')).toHaveAttribute(
    'data-scrolled',
    'true',
  );
  await openWalletDialog(page);
  await expect(page.locator('[data-glass-panel="sheet"]')).toBeVisible();
  expect(await page.locator('.glass:visible').count()).toBe(2);

  await page.screenshot({
    path: 'test-results/glass-wallet-sheet.png',
    fullPage: false,
  });
});

test('token picker, network popover, toast and status drawer are glass', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');

  await page.getByRole('button', { name: /Testnet/ }).click();
  await expect(page.getByText('BCH chipnet + Base Sepolia')).toBeVisible();
  await page.keyboard.press('Escape');

  await page
    .getByRole('region', { name: 'Swap' })
    .getByRole('button', { name: /USDC/ })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Select a token' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /tPUSD.*Bitcoin Cash/i }).click();
  const direction = page.getByRole('button', {
    name: 'Switch swap direction',
  });
  await expect(direction).toHaveAttribute('aria-pressed', 'true');
  await direction.click();
  await expect(direction).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();

  await expect(
    page.getByRole('button', { name: /download recovery file/i }),
  ).toBeVisible({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /download recovery file/i }).click();
  await download;
  await expect(page.locator('[data-glass-panel="toast"]')).toContainText(
    /recovery file downloaded/i,
  );
  await page
    .getByRole('button', { name: 'Dismiss notification', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Review and confirm', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Review and confirm' }),
  ).toBeVisible();
  expect(await page.locator('.glass:visible').count()).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  const orderId = `0x${'77'.repeat(32)}`;
  await page.goto(`/swap/${orderId}?mock=1&scenario=refund`);
  await expect(
    page.getByRole('heading', { level: 1, name: /rejected/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open timeline drawer' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Swap timeline (mock)' }),
  ).toBeVisible();
  expect(await page.locator('.glass:visible').count()).toBeLessThanOrEqual(2);
});

test('body text on glass clears 4.5:1 over the lime glow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');
  await openWalletDialog(page);

  const panel = page.locator('[data-glass-panel="modal"]');
  await expect(panel).toBeVisible();
  await page.addStyleTag({
    content:
      '[data-glass-panel] > * { visibility: hidden !important; } [data-glass-panel]::before { display: none !important; }',
  });

  const screenshot = await panel.screenshot();
  const image = PNG.sync.read(screenshot);
  const insetX = Math.max(12, Math.floor(image.width * 0.15));
  const insetY = Math.max(12, Math.floor(image.height * 0.15));
  let brightest = 0;

  for (let y = insetY; y < image.height - insetY; y += 1) {
    for (let x = insetX; x < image.width - insetX; x += 1) {
      const offset = (image.width * y + x) * 4;
      const alpha = image.data[offset + 3] ?? 255;
      if (alpha < 255) continue;
      const pixel = luminance(
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      );
      if (pixel > brightest) brightest = pixel;
    }
  }

  const text = luminance(0xf4, 0xf4, 0xf5);
  const muted = luminance(0x8b, 0x8b, 0x92);
  expect(contrast(text, brightest)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(muted, brightest)).toBeGreaterThanOrEqual(4.5);
});

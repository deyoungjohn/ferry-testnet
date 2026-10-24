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
    await page.goto('/');

    await expect(
      page.getByRole('heading', { level: 1, name: /without a bridge/i }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Swap' })).toBeVisible();
    await expect(page.getByRole('button', { name: /ferry it/i })).toBeVisible();

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

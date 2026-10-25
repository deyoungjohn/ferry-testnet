import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
] as const;

const SECTIONS = [
  '#stats',
  '#features',
  '#recent-swaps',
  '#pegs',
  '#how-it-works',
  '#faq',
] as const;

for (const viewport of VIEWPORTS) {
  test(`page map fits ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto('/?mock=1');
    await expect(page.getByText(/no completed swaps yet/i)).toBeVisible();

    for (const selector of SECTIONS) {
      const section = page.locator(selector);
      await expect(section).toBeVisible();
      const box = await section.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width,
      );
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.screenshot({
      path: `test-results/pagemap-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

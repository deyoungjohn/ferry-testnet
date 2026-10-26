import { expect, test } from '@playwright/test';

const ORDER_ID = `0x${'55'.repeat(32)}`;

test('mock status never exposes explorer links or hides the simulation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/swap/${ORDER_ID}?mock=1&scenario=refund`);

  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /rejected/i,
  );
  await expect(
    page.getByText(/Mock interface — no funds move/i).first(),
  ).toBeVisible();
  await expect(page.getByText(/mock, not on chain/i).first()).toBeVisible();
  await expect(page.getByText(/explorer links disabled/i)).toBeVisible();
  expect(await page.locator('a[href*="basescan.org/tx/"]').count()).toBe(0);
  expect(
    await page.locator('a[href*="blockexplorer.cash/chipnet/tx/"]').count(),
  ).toBe(0);

  await page.getByRole('button', { name: 'Open timeline drawer' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Swap timeline (mock)' }),
  ).toBeVisible();
  expect(await page.locator('a[href*="basescan.org/tx/"]').count()).toBe(0);
  expect(
    await page.locator('a[href*="blockexplorer.cash/chipnet/tx/"]').count(),
  ).toBe(0);
});

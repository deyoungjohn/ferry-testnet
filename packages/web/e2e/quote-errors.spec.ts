import { expect, test } from '@playwright/test';

async function connect(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
}

test('solver rejection shows the solver code and reason', async ({ page }) => {
  await page.goto('/?mock=1&quoteFailure=rejected');
  await connect(page);
  await page.getByRole('button', { name: 'Get quote' }).click();
  await expect(page.getByRole('alert')).toContainText(/QUOTE_REJECTED/);
  await expect(page.getByRole('alert')).toContainText(/smaller amount/i);
});

test('solver outage tells the user how to recover', async ({ page }) => {
  await page.goto('/?mock=1&quoteFailure=unavailable');
  await connect(page);
  await page.getByRole('button', { name: 'Get quote' }).click();
  await expect(page.getByRole('alert')).toContainText(/solver unavailable/i);
  await expect(page.getByRole('alert')).toContainText(
    /start the local solver/i,
  );
});

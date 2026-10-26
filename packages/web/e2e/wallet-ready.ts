import { expect, type Page } from '@playwright/test';

export async function openWalletDialog(page: Page) {
  await page
    .getByRole('button', { name: /wallet connection: connect/i })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Connect wallets' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

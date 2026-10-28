import { expect, test } from '@playwright/test';

const QR_TITLE = 'Connect a BCH wallet';

async function expectQr(page: import('@playwright/test').Page) {
  await expect(page.getByText(QR_TITLE, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('canvas')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Copy URI', exact: true }),
  ).toBeVisible();
}

test('real WizardConnect: Connect BCH opens a QR, closes, and reopens', async ({
  page,
}) => {
  await page.goto('/');
  const connect = page.getByRole('button', {
    name: 'Connect BCH',
    exact: true,
  });

  await connect.click();
  await expectQr(page);
  await expect(
    page.getByRole('button', { name: 'Connecting BCH…', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText(QR_TITLE, { exact: true })).toHaveCount(0);
  await expect(connect).toHaveText('Connect BCH');

  await connect.click();
  await expectQr(page);
});

test('real WizardConnect: a stale restored attempt is replaced by a fresh QR', async ({
  page,
}) => {
  await page.routeWebSocket(/.*/, () => {
    // Keep the relay socket open but inert; the test only needs the local
    // reconnect state and the freshly generated QR URI.
  });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'wizardconnect-session',
      JSON.stringify({
        privateKey: '11'.repeat(32),
        secret: '22'.repeat(8),
        walletPublicKey: '33'.repeat(32),
        walletName: 'Stale test wallet',
      }),
    );
  });
  await page.goto('/');

  const reconnect = page.getByRole('button', {
    name: 'Reconnecting BCH…',
    exact: true,
  });
  await expect(reconnect).toBeVisible({ timeout: 20_000 });
  await reconnect.click();
  await expectQr(page);
  await expect(
    page.getByRole('button', { name: 'Connecting BCH…', exact: true }),
  ).toBeVisible();
});

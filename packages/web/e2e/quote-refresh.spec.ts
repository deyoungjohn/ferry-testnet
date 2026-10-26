import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('swap quote refreshes with a new secret and re-arms recovery', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1&quoteTtl=8');

  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get quote' }).click();

  const downloadButton = page.getByRole('button', {
    name: /download recovery file/i,
  });
  await expect(downloadButton).toBeVisible({ timeout: 15_000 });

  const firstDownload = page.waitForEvent('download');
  await downloadButton.click();
  const first = await firstDownload;
  const firstPath = await first.path();
  expect(firstPath).not.toBeNull();
  const firstFile = JSON.parse(await readFile(firstPath!, 'utf8')) as {
    readonly secret: string;
    readonly orderId: string;
  };

  await expect(
    page.getByRole('button', { name: /recovery file downloaded/i }),
  ).toBeVisible();

  await expect(downloadButton).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole('button', { name: /ferry it/i })).toBeDisabled();

  const secondDownload = page.waitForEvent('download');
  await downloadButton.click();
  const second = await secondDownload;
  const secondPath = await second.path();
  expect(secondPath).not.toBeNull();
  const secondFile = JSON.parse(await readFile(secondPath!, 'utf8')) as {
    readonly secret: string;
    readonly orderId: string;
  };

  expect(secondFile.orderId).not.toBe(firstFile.orderId);
  expect(secondFile.secret).not.toBe(firstFile.secret);

  await expect(
    page.getByRole('button', { name: /recovery file downloaded/i }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /ferry it/i })).toBeEnabled();
});

test('pay-link exact quote refreshes before expiry', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/p/MockPayLink111111111?mock=1&quoteTtl=8');

  await page.getByRole('button', { name: 'Connect Base' }).click();
  await page.getByRole('button', { name: 'Get exact quote' }).click();

  const downloadButton = page.getByRole('button', {
    name: /download recovery file first/i,
  });
  await expect(downloadButton).toBeVisible({ timeout: 15_000 });

  const firstDownload = page.waitForEvent('download');
  await downloadButton.click();
  const first = await firstDownload;
  const firstPath = await first.path();
  expect(firstPath).not.toBeNull();
  const firstFile = JSON.parse(await readFile(firstPath!, 'utf8')) as {
    readonly orderId: string;
  };

  await expect(
    page.getByRole('button', { name: /recovery file downloaded/i }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /download recovery file first/i }),
  ).toBeVisible({ timeout: 25_000 });

  const secondDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: /download recovery file first/i })
    .click();
  const second = await secondDownload;
  const secondPath = await second.path();
  expect(secondPath).not.toBeNull();
  const secondFile = JSON.parse(await readFile(secondPath!, 'utf8')) as {
    readonly orderId: string;
  };

  expect(secondFile.orderId).not.toBe(firstFile.orderId);
});

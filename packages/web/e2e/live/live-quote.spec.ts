import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('web obtains signed forward and reverse quotes from the live solver', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const direction of ['forward', 'reverse'] as const) {
    await page.goto(
      direction === 'reverse' ? '/?mock=1&direction=reverse' : '/?mock=1',
    );
    await page.getByRole('button', { name: 'Connect BCH' }).click();
    await page.getByRole('button', { name: 'Connect Base' }).click();
    await page.getByRole('button', { name: 'Get quote' }).click();

    await expect(page.getByText('Live solver')).toBeVisible({
      timeout: 30_000,
    });
    const downloadButton = page.getByRole('button', {
      name: /download recovery file/i,
    });
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });
    const download = page.waitForEvent('download');
    await downloadButton.click();
    const file = await download;
    const filePath = await file.path();
    expect(filePath).not.toBeNull();
    const parsed = JSON.parse(await readFile(filePath!, 'utf8')) as {
      readonly solverKind?: string;
    };
    expect(parsed.solverKind).toBe('live');
  }
});

import { expect, test } from '@playwright/test';

async function connect(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Connect BCH' }).click();
  await page.getByRole('button', { name: 'Connect Base' }).click();
}

async function quote(page: import('@playwright/test').Page, failure: string) {
  await page.goto(`/?mock=1&quoteFailure=${failure}`);
  await connect(page);
  await page.getByRole('button', { name: 'Get quote' }).click();
}

test('solver inventory refusal uses human copy and keeps the code', async ({
  page,
}) => {
  await quote(page, 'rejected');
  await expect(page.getByRole('alert')).toContainText(
    /does not have enough inventory/i,
  );
  await expect(page.getByRole('alert')).toContainText(/try a smaller amount/i);
  await expect(page.getByText('Code: INSUFFICIENT_INVENTORY')).toBeVisible();
});

test('unreachable solver is distinct from a solver response', async ({
  page,
}) => {
  await quote(page, 'unavailable');
  await expect(page.getByRole('alert')).toContainText(
    /cannot reach the solver/i,
  );
  await expect(page.getByRole('alert')).toContainText(
    /check that the solver is running/i,
  );
  await expect(page.getByText('Code: UNREACHABLE')).toBeVisible();
});

test('BCH tip failure explains the condition and next step', async ({
  page,
}) => {
  await quote(page, 'bch-tip');
  await expect(page.getByRole('alert')).toContainText(
    /cannot get a healthy Bitcoin Cash tip/i,
  );
  await expect(page.getByRole('alert')).toContainText(
    /check the solver health line/i,
  );
  await expect(page.getByText('Code: BCH_TIP_UNHEALTHY')).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText(
    /BCH_TIP_UNHEALTHY: BCH quorum/i,
  );
});

test('quoting paused and unknown codes stay actionable and reportable', async ({
  page,
}) => {
  await quote(page, 'quoting-disabled');
  await expect(page.getByRole('alert')).toContainText(/quoting is paused/i);
  await expect(page.getByText('Code: QUOTING_DISABLED')).toBeVisible();

  await quote(page, 'unknown');
  await expect(page.getByRole('alert')).toContainText(/unexpected error/i);
  await expect(page.getByText('Code: FUTURE_CODE')).toBeVisible();
});

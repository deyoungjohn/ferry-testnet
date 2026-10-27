import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openWalletDialog } from './wallet-ready';

const ORDER_ID = `0x${'77'.repeat(32)}`;

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    JSON.stringify(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })),
      null,
      2,
    ),
  ).toEqual([]);
}

async function tabTo(page: Page, target: Locator, limit = 80): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(
    `Could not reach keyboard target after ${limit.toString()} tabs`,
  );
}

const AXE_ROUTES = [
  {
    name: 'home',
    url: '/?mock=1',
    ready: (page: Page) =>
      page.getByRole('heading', { level: 1, name: /without a bridge/i }),
  },
  {
    name: 'swap status',
    url: `/swap/${ORDER_ID}?mock=1&scenario=refund`,
    ready: (page: Page) =>
      page.getByRole('heading', { level: 1, name: /rejected/i }),
  },
  {
    name: 'pay link',
    url: '/p/MockReservedLink1111?mock=1',
    ready: (page: Page) =>
      page.getByRole('heading', { level: 1, name: /pay 40 tPUSD/i }),
  },
  {
    name: 'recover',
    url: '/recover?mock=1',
    ready: (page: Page) =>
      page.getByRole('heading', { level: 1, name: /recover a swap/i }),
  },
] as const;

for (const route of AXE_ROUTES) {
  test(`axe: ${route.name}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(route.url);
    await expect(route.ready(page)).toBeVisible({ timeout: 15_000 });
    await expectNoAxeViolations(page);
  });
}

test('keyboard-only swap reaches DONE', async ({ page }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?mock=1');

  const connectBch = page.getByRole('button', { name: 'Connect BCH' });
  await tabTo(page, connectBch);
  await expect(connectBch).toBeFocused();
  await page.keyboard.press('Enter');

  const connectBase = page.getByRole('button', { name: 'Connect Base' });
  await tabTo(page, connectBase);
  await page.keyboard.press('Enter');

  const amount = page.getByLabel('You send amount');
  await tabTo(page, amount);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('12.00');

  const quote = page.getByRole('button', { name: 'Get quote' });
  await tabTo(page, quote);
  await page.keyboard.press('Enter');

  const recovery = page.getByRole('button', {
    name: /download recovery file/i,
  });
  await expect(recovery).toBeVisible({ timeout: 15_000 });
  await tabTo(page, recovery);
  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  await download;

  const ferry = page.getByRole('button', { name: /ferry it/i });
  await tabTo(page, ferry);
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('heading', { level: 1, name: /done/i }),
  ).toBeVisible({ timeout: 40_000 });
});

test('prefers-reduced-motion keeps the wallet dialog usable', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?mock=1');
  expect(
    await page.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
  ).toBe('auto');

  const dialog = await openWalletDialog(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('prefers-reduced-transparency removes backdrop filters', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await page.goto('/?mock=1');
  expect(
    await page.evaluate(
      () => window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
    ),
  ).toBe(true);

  await openWalletDialog(page);
  const panel = page.locator('[data-glass-panel="modal"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const styles = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    const webkitStyle = style as CSSStyleDeclaration & {
      webkitBackdropFilter: string;
    };
    return {
      backdropFilter: style.backdropFilter,
      webkitBackdropFilter: webkitStyle.webkitBackdropFilter,
      backgroundImage: style.backgroundImage,
    };
  });
  expect(styles.backdropFilter).toBe('none');
  expect(styles.webkitBackdropFilter ?? 'none').toBe('none');
  expect(styles.backgroundImage).toBe('none');
});

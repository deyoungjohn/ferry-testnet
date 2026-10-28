import { test, expect } from '@playwright/test';
import type { Hex } from 'viem';
import {
  LIVE_SOLVER_URL,
  LIVE_SKIP_REASON,
  liveEnv,
  liveSolverReady,
} from './live-env';
import { ScriptBchWallet } from './script-wallet';
import { ScriptEvmWallet } from './script-evm';

const directions = ['forward', 'reverse'] as const;
const lanes = ['fast', 'safe'] as const;

async function runSwap(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  direction: (typeof directions)[number],
  lane: (typeof lanes)[number],
) {
  const fulcrumUrl = liveEnv('BCH_CHIPNET_ELECTRUM_URLS').split(',')[0]?.trim();
  if (!fulcrumUrl) throw new Error('No BCH_CHIPNET_ELECTRUM_URLS configured');

  const bch = new ScriptBchWallet(liveEnv('USER_BCH_WIF'), fulcrumUrl);
  const evm = new ScriptEvmWallet(liveEnv('USER_EVM_PRIVATE_KEY') as Hex);
  await bch.connect();
  await bch.attach(page);
  await evm.attach(page);

  const startedAt = Date.now();
  try {
    await page.goto(
      direction === 'reverse' ? '/?mock=1&direction=reverse' : '/?mock=1',
    );
    await page.getByRole('button', { name: 'Connect BCH' }).click();
    await page.getByRole('button', { name: 'Connect Base' }).click();
    await page.getByLabel('You send amount').fill('1.00');
    await page
      .getByRole('button', { name: lane === 'fast' ? 'Fast ≤ $25' : 'Safe' })
      .click();
    await page.getByRole('button', { name: 'Get quote' }).click();
    await expect(page.getByText('Live solver', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const recoveryButton = page.getByRole('button', {
      name: /download recovery file/i,
    });
    await expect(recoveryButton).toBeVisible({ timeout: 30_000 });
    const recoveryDownload = page.waitForEvent('download');
    await recoveryButton.click();
    await recoveryDownload;
    const recoveryAt = Date.now();

    if (direction === 'forward') {
      await page.getByRole('button', { name: 'Review and confirm' }).click();
      await page
        .getByRole('button', { name: 'Confirm and ferry' })
        .click({ timeout: 30_000 });
    } else {
      await page
        .getByRole('button', { name: 'Sign with BCH wallet' })
        .click({ timeout: 30_000 });
    }

    await page.waitForURL(/\/swap\/0x[0-9a-f]{64}$/, { timeout: 120_000 });
    const orderId = page.url().split('/').at(-1);
    if (!orderId) throw new Error('Missing order id');
    const lockAt = Date.now();

    let claimAt = lockAt;
    if (direction === 'reverse') {
      const claimButton = page.getByRole('button', {
        name: 'Claim USDC (gasless)',
      });
      await expect(claimButton).toBeVisible({ timeout: 1_000_000 });
      claimAt = Date.now();
      await claimButton.click();
    }

    await expect(
      page.getByRole('heading', { level: 1, name: 'Done' }),
    ).toBeVisible({ timeout: 1_000_000 });
    const doneAt = Date.now();

    const orderResponse = await request.get(
      `${LIVE_SOLVER_URL}/v1/orders/${orderId}`,
    );
    expect(orderResponse.ok()).toBe(true);
    const order = (await orderResponse.json()) as {
      readonly status: string;
      readonly txIds: {
        readonly userLockTxId?: string;
        readonly solverLockTxId?: string;
        readonly userClaimTxId?: string;
        readonly solverClaimTxId?: string;
      };
    };
    expect(order.status).toBe('DONE');
    const links = await page
      .locator('a[href*="/tx/"]')
      .evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getAttribute('href')),
      );
    expect(links.some((href) => href?.includes('blockexplorer.cash'))).toBe(
      true,
    );
    expect(links.some((href) => href?.includes('sepolia.basescan.org'))).toBe(
      true,
    );

    console.log(
      JSON.stringify({
        direction,
        lane,
        orderId,
        txIds: order.txIds,
        timingsMs: {
          quoteAndRecovery: recoveryAt - startedAt,
          recoveryToLock: lockAt - recoveryAt,
          lockToClaim: claimAt - lockAt,
          claimToDone: doneAt - claimAt,
          total: doneAt - startedAt,
        },
      }),
    );
  } finally {
    bch.close();
  }
}

test.describe.configure({ mode: 'serial' });

for (const direction of directions) {
  for (const lane of lanes) {
    test(`${direction} · ${lane} lane · live walkthrough`, async ({
      page,
      request,
    }) => {
      test.setTimeout(1_200_000);
      test.skip(!(await liveSolverReady(request)), LIVE_SKIP_REASON);
      await runSwap(page, request, direction, lane);
    });
  }
}

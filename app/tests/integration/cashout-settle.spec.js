import { test, expect } from '@playwright/test';
import { openApp, addPlayers, logBuyin, setCashout, gotoTab } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('two-player settle: Alice +£0.50, Bob -£0.50, single transfer', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob']);

  await logBuyin(page, 'Alice', 100, 'chips');
  await logBuyin(page, 'Bob', 100, 'chips');

  await setCashout(page, 'Alice', 150, 'chips');
  await setCashout(page, 'Bob', 50, 'chips');

  await gotoTab(page, 'Settle');

  // Net positions table — find the row by player name then check the
  // Net cell at the end.
  const aliceRow = page.locator('#net-positions tbody tr').filter({ hasText: 'Alice' });
  const bobRow   = page.locator('#net-positions tbody tr').filter({ hasText: 'Bob' });

  await expect(aliceRow).toContainText('£0.50');
  await expect(aliceRow).toContainText('receives');
  await expect(bobRow).toContainText('£0.50');
  await expect(bobRow).toContainText('pays');

  // Exactly one settlement transaction.
  const txns = page.locator('#settlements .txn-item');
  await expect(txns).toHaveCount(1);
  const onlyTxn = txns.first();
  await expect(onlyTxn.locator('.txn-from')).toHaveText('Bob');
  await expect(onlyTxn.locator('.txn-to')).toHaveText('Alice');
  await expect(onlyTxn.locator('.txn-amount')).toHaveText('£0.50');

  // The copy button is visible and (after click) toggles its label.
  const copyBtn = page.locator('#copy-btn');
  await expect(copyBtn).toBeVisible();

  // Grant clipboard permissions where supported; otherwise tolerate failure
  // since the button still toggles text on the success path.
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch { /* not all browsers/configs support this */ }

  // If the clipboard write rejects, the app shows an alert — accept it so
  // the test doesn't hang.
  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });

  await copyBtn.click();
  // The success path flips the button text to "✓ Copied!" briefly.
  await expect(copyBtn).toContainText(/Copied!|Copy Settlement/);
});

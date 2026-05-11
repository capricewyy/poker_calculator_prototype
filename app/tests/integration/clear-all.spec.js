import { test, expect } from '@playwright/test';
import { openApp, addPlayers, logBuyin, gotoTab } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('"Clear All Data" wipes players, buy-ins, and selectors', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob']);
  await logBuyin(page, 'Alice', 100, 'chips');
  await logBuyin(page, 'Bob', 50, 'chips');

  await gotoTab(page, 'Setup');

  // Accept the destructive confirm dialog.
  page.once('dialog', async (d) => { await d.accept(); });

  await page.locator('button.btn-danger:has-text("Clear All Data")').click();

  // Players tab is empty again.
  await gotoTab(page, 'Players');
  await expect(page.locator('#players-list')).toContainText('No players added yet');

  // Buy-in history empty.
  await gotoTab(page, 'Buy-ins');
  await expect(page.locator('#buyin-summary')).toContainText('Add players first');

  // Settle view also resets.
  await gotoTab(page, 'Settle');
  await expect(page.locator('#net-positions')).toContainText('Add players first');
});

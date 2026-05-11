import { test, expect } from '@playwright/test';
import { openApp, addPlayer, logBuyin, gotoTab } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('state survives a page reload', async ({ page }) => {
  await addPlayer(page, 'Alice');
  await logBuyin(page, 'Alice', 20, 'money');

  await page.reload();

  // Players tab still has Alice.
  await gotoTab(page, 'Players');
  await expect(page.locator('#players-list')).toContainText('Alice');

  // Buy-ins tab still shows the £20 entry.
  await gotoTab(page, 'Buy-ins');
  const summary = page.locator('#buyin-summary');
  await expect(summary).toContainText('Alice — Total: £20.00');
  await expect(summary).toContainText('£20.00');
});

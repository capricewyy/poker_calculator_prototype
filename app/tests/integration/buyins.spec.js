import { test, expect } from '@playwright/test';
import { openApp, addPlayers, gotoTab, logBuyin } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('initial buy-in and rebuy accrue under the right player', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob']);

  // Default rate: 100 chips = £1.00. So 100 chips => £1.00.
  await logBuyin(page, 'Alice', 100, 'chips');
  await logBuyin(page, 'Alice', 5, 'money');

  await gotoTab(page, 'Buy-ins');
  const summary = page.locator('#buyin-summary');

  // Section label shows Alice's total = £6.00.
  await expect(summary).toContainText('Alice — Total: £6.00');

  // First entry is the buy-in (chips), second is "Rebuy #1" (money).
  await expect(summary).toContainText('Buy-in');
  await expect(summary).toContainText('100 chips = £1.00');
  await expect(summary).toContainText('Rebuy #1');
  await expect(summary).toContainText('£5.00');
});

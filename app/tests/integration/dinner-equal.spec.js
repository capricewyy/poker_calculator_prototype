import { test, expect } from '@playwright/test';
import { openApp, addPlayers, gotoTab } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('equal-split dinner logs payer, total, and per-person share', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob', 'Carol']);

  await gotoTab(page, 'Dinner');
  await page.locator('#dinner-desc').fill('Pizza');
  await page.selectOption('#dinner-payer', { label: 'Alice' });
  await page.selectOption('#dinner-split-mode', 'equal');

  // Defaults to all-checked, all three participants — just enter total.
  await page.locator('#dinner-total-amount').fill('30');
  await page.locator('button.btn-primary:has-text("Add Dinner Bill")').click();

  const dinners = page.locator('#dinners-list');
  await expect(dinners).toContainText('Pizza');
  await expect(dinners).toContainText('Alice');
  await expect(dinners).toContainText('paid £30.00');
  // Equal split of 30 across 3 = 10 each.
  await expect(dinners).toContainText('Alice: £10.00');
  await expect(dinners).toContainText('Bob: £10.00');
  await expect(dinners).toContainText('Carol: £10.00');
});

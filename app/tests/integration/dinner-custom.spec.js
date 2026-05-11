import { test, expect } from '@playwright/test';
import { openApp, addPlayers, gotoTab } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('custom-amount dinner logs per-player shares and rolls up to total', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob', 'Carol']);

  await gotoTab(page, 'Dinner');
  await page.locator('#dinner-desc').fill('Sushi');
  await page.selectOption('#dinner-payer', { label: 'Alice' });
  await page.selectOption('#dinner-split-mode', 'custom');

  // Fill per-player amounts. The inputs are tagged with data-player=<id>,
  // so locate them via the surrounding row containing the name.
  const rows = page.locator('#dinner-form-detail .dinner-row');
  await rows.filter({ hasText: 'Alice' }).locator('input.dinner-share-input').fill('15');
  await rows.filter({ hasText: 'Bob' }).locator('input.dinner-share-input').fill('10');
  await rows.filter({ hasText: 'Carol' }).locator('input.dinner-share-input').fill('5');

  // The live total info bar should update.
  await expect(page.locator('#dinner-custom-total')).toHaveText('£30.00');

  await page.locator('button.btn-primary:has-text("Add Dinner Bill")').click();

  const dinners = page.locator('#dinners-list');
  await expect(dinners).toContainText('Sushi');
  await expect(dinners).toContainText('paid £30.00');
  await expect(dinners).toContainText('Custom');
  await expect(dinners).toContainText('Alice: £15.00');
  await expect(dinners).toContainText('Bob: £10.00');
  await expect(dinners).toContainText('Carol: £5.00');
});

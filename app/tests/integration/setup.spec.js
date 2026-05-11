import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('chip rate and currency can be configured', async ({ page }) => {
  // App boots on the Setup tab.
  await expect(page.locator('#tab-setup')).toHaveClass(/active/);

  await page.locator('#chip-count').fill('200');
  await page.locator('#chip-money').fill('2.00');
  await page.locator('#currency-symbol').fill('$');
  await page.locator('button.btn-primary:has-text("Save")').click();

  // The rate display is the persistent source of truth.
  await expect(page.locator('#rate-display')).toHaveText('200 chips = $2.00');
  await expect(page.locator('#rate-per-chip')).toHaveText('$0.0100');
});

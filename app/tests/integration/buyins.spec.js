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

test('default unit on the Buy-ins tab is "buyin"', async ({ page }) => {
  await addPlayers(page, ['Alice']);
  await gotoTab(page, 'Buy-ins');
  await expect(page.locator('#buyin-unit')).toHaveValue('buyin');
});

test('logging a buy-in in the "buyin" unit converts using the default buy-in size', async ({ page }) => {
  await addPlayers(page, ['Alice']);

  // Defaults: 100 chips = £1.00 and 1 buy-in = 100 chips => 1 buy-in = £1.00.
  await logBuyin(page, 'Alice', 1, 'buyin');

  await gotoTab(page, 'Buy-ins');
  const summary = page.locator('#buyin-summary');
  await expect(summary).toContainText('Alice — Total: £1.00');
  await expect(summary).toContainText('Buy-in');
  await expect(summary).toContainText('1 buy-in');
});

test('"Start everyone" gives each registered player a single starting buy-in', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob', 'Charlie']);
  await gotoTab(page, 'Buy-ins');
  await page.locator('button:has-text("Start everyone with 1 buy-in")').click();

  // Defaults: 1 buy-in = 100 chips = £1.00. Each player should be at £1.00.
  const summary = page.locator('#buyin-summary');
  await expect(summary).toContainText('Alice — Total: £1.00');
  await expect(summary).toContainText('Bob — Total: £1.00');
  await expect(summary).toContainText('Charlie — Total: £1.00');
});

test('"Start everyone" skips players who already have at least one buy-in', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob']);
  // Alice already has a £5 cash buy-in logged.
  await logBuyin(page, 'Alice', 5, 'money');

  await gotoTab(page, 'Buy-ins');
  await page.locator('button:has-text("Start everyone with 1 buy-in")').click();

  const summary = page.locator('#buyin-summary');
  // Alice is unchanged at £5; Bob now has £1.
  await expect(summary).toContainText('Alice — Total: £5.00');
  await expect(summary).toContainText('Bob — Total: £1.00');
});

test('changing the chip count in setup also changes how the "buyin" unit converts', async ({ page }) => {
  // App boots on the Setup tab. The chip count doubles as one buy-in's size:
  // setting 50 chips = £1.00 means 1 buy-in = 50 chips = £1.00.
  await page.locator('#chip-count').fill('50');
  await page.locator('button.btn-primary:has-text("Save")').click();

  await addPlayers(page, ['Alice']);
  await logBuyin(page, 'Alice', 2, 'buyin'); // 2 buy-ins = 100 chips = £2.00

  await gotoTab(page, 'Buy-ins');
  await expect(page.locator('#buyin-summary')).toContainText('Alice — Total: £2.00');
});

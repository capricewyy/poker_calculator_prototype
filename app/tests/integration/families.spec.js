import { test, expect } from '@playwright/test';
import { openApp, addPlayers, logBuyin, setCashout, gotoTab } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('family members do not transact with each other in the settlement', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob', 'Carol', 'Dave']);

  // Create "The Smiths" containing Alice + Bob.
  await gotoTab(page, 'Players');
  await page.locator('#family-name').fill('The Smiths');

  // Each checkbox row has the player's name in its label.
  const memberRows = page.locator('#family-form-members .dinner-row');
  await memberRows.filter({ hasText: 'Alice' }).locator('input[type=checkbox]').check();
  await memberRows.filter({ hasText: 'Bob' }).locator('input[type=checkbox]').check();

  await page.locator('button.btn-primary:has-text("Create Family")').click();

  // Family list shows the new family.
  await expect(page.locator('#families-list')).toContainText('The Smiths');

  // Log the chip flow.
  await logBuyin(page, 'Alice', 100, 'chips');
  await logBuyin(page, 'Bob', 100, 'chips');
  await logBuyin(page, 'Carol', 100, 'chips');
  await logBuyin(page, 'Dave', 100, 'chips');

  await setCashout(page, 'Alice', 200, 'chips');
  await setCashout(page, 'Bob', 50, 'chips');
  await setCashout(page, 'Carol', 100, 'chips');
  await setCashout(page, 'Dave', 50, 'chips');

  await gotoTab(page, 'Settle');

  // Family subtotal section appears with "The Smiths".
  await expect(page.locator('#net-positions')).toContainText('Family subtotals');
  await expect(page.locator('#net-positions')).toContainText('The Smiths');

  // No transaction should be Alice<->Bob. The principal node names in a
  // settlement row are rendered in .txn-from and .txn-to; family member
  // names show up only inside the small sub-label, which we don't check.
  const txns = page.locator('#settlements .txn-item');
  const count = await txns.count();
  for (let i = 0; i < count; i++) {
    const from = (await txns.nth(i).locator('.txn-from').textContent())?.trim();
    const to   = (await txns.nth(i).locator('.txn-to').textContent())?.trim();
    const pair = new Set([from, to]);
    // No txn should be exactly Alice <-> Bob: that would mean a within-family
    // transfer wasn't collapsed.
    expect(pair.has('Alice') && pair.has('Bob')).toBe(false);
  }

  // And the family should appear by name on at least one txn node.
  const principalNames = [];
  for (let i = 0; i < count; i++) {
    principalNames.push((await txns.nth(i).locator('.txn-from').textContent())?.trim());
    principalNames.push((await txns.nth(i).locator('.txn-to').textContent())?.trim());
  }
  expect(principalNames).toContain('The Smiths');
});

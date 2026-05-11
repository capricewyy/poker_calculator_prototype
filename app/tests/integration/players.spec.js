import { test, expect } from '@playwright/test';
import { openApp, addPlayer, addPlayers, gotoTab, tabBadge } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('add four players, see them in the list and badge count', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob', 'Carol', 'Dave']);

  const list = page.locator('#players-list');
  await expect(list.locator('.row-item')).toHaveCount(4);
  for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
    await expect(list).toContainText(name);
  }

  expect(await tabBadge(page, 'Players')).toBe('4');
});

test('duplicate player name shows an alert and is not added', async ({ page }) => {
  await addPlayer(page, 'Alice');

  // Wire up the dialog handler before triggering the duplicate add.
  let dialogMessage = null;
  page.once('dialog', async (d) => {
    dialogMessage = d.message();
    await d.dismiss();
  });

  await page.locator('#player-name').fill('Alice');
  await page.locator('button.btn-primary:has-text("Add Player")').click();

  // Give the dialog handler a chance to fire.
  await expect.poll(() => dialogMessage).toMatch(/already exists/i);

  // Still exactly one Alice.
  const aliceRows = page.locator('#players-list .row-item').filter({ hasText: 'Alice' });
  await expect(aliceRows).toHaveCount(1);
});

test('removing a player drops them from the list', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob', 'Carol']);

  page.once('dialog', async (d) => { await d.accept(); });

  // Click the Remove button on Bob's row.
  const bobRow = page.locator('#players-list .row-item').filter({ hasText: 'Bob' });
  await bobRow.locator('button:has-text("Remove")').click();

  await expect(page.locator('#players-list .row-item')).toHaveCount(2);
  await expect(page.locator('#players-list')).not.toContainText('Bob');
});

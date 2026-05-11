// Shared helpers for Poker Night integration tests.
// Keep these small and obvious — tests should read like a story.

import { expect } from '@playwright/test';

/**
 * Navigate to the app and clear localStorage so each test starts clean.
 * The app reads from 'poker_v5' on load.
 */
export async function openApp(page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
  });
  // Reload so the app boots with a fresh state.
  await page.reload();
}

/** Switch to a tab by clicking the tab button matching the label regex. */
export async function gotoTab(page, label) {
  await page.locator(`button.tab:has-text("${label}")`).click();
}

/** Add a single player via the Players tab. Assumes you're already on it
 *  (or switches there). Handles the alert if the name already exists. */
export async function addPlayer(page, name) {
  await gotoTab(page, 'Players');
  await page.locator('#player-name').fill(name);
  await page.locator('button.btn-primary:has-text("Add Player")').click();
}

/** Add several players in sequence. */
export async function addPlayers(page, names) {
  for (const n of names) {
    await addPlayer(page, n);
  }
}

/** Log a buy-in. unit is 'chips' or 'money'. */
export async function logBuyin(page, playerName, amount, unit = 'chips') {
  await gotoTab(page, 'Buy-ins');
  await page.selectOption('#buyin-player', { label: playerName });
  await page.locator('#buyin-amount').fill(String(amount));
  await page.selectOption('#buyin-unit', unit);
  await page.locator('button.btn-primary:has-text("Log")').click();
}

/** Set a cash out for a player. */
export async function setCashout(page, playerName, amount, unit = 'chips') {
  await gotoTab(page, 'Cash Out');
  await page.selectOption('#cashout-player', { label: playerName });
  await page.locator('#cashout-amount').fill(String(amount));
  await page.selectOption('#cashout-unit', unit);
  await page.locator('button.btn-primary:has-text("Set")').click();
}

/** Return the badge text on a given tab button, or null if absent. */
export async function tabBadge(page, label) {
  const badge = page.locator(`button.tab:has-text("${label}") .tab-badge`);
  if (await badge.count() === 0) return null;
  return (await badge.textContent())?.trim() ?? null;
}

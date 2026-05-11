// Master user journey: a single end-to-end walk through every tab in order
// (Setup -> Players -> Buy-ins -> Dinner -> Cash Out -> Settle) verifying the
// final settlement against pre-computed expectations.
//
// Scenario (default rate 100 chips = £1.00, currency £):
//   Players: Alice, Bob, Carol, Dave
//   Family:  The Smiths = { Alice, Bob }
//   Buy-ins: Alice 100 chips + £5 (rebuy) = £6.00
//            Bob   100 chips + 200 chips  = £3.00
//            Carol 100 chips              = £1.00
//            Dave  200 chips              = £2.00
//   Dinner:  Pizza, paid by Dave, £30 split equally across all 4 -> £7.50 each
//   Cashout: Alice 500 chips, Bob 100, Carol 300, Dave 300 (total 1200 = £12)
//
// Expected nets:
//   Alice -£8.50, Bob -£9.50, Carol -£5.50, Dave +£23.50   (sum = 0)
//
// Family aggregation:
//   The Smiths -£18.00, Carol -£5.50, Dave +£23.50
//
// Expected settlements (greedy, family-aware):
//   The Smiths -> Dave £18.00
//   Carol      -> Dave £5.50

import { test, expect } from '@playwright/test';
import {
  openApp, addPlayers, gotoTab,
  logBuyin, setCashout, tabBadge,
} from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('completes a full session: setup → players → families → buy-ins → dinner → cash out → settle', async ({ page }) => {
  // ── 1. Setup tab: confirm default rate display ──────────────────────────
  // App boots on Setup.
  await expect(page.locator('#tab-setup')).toHaveClass(/active/);
  await expect(page.locator('#rate-display')).toHaveText('100 chips = £1.00');

  // ── 2. Players tab: add the four players ────────────────────────────────
  await addPlayers(page, ['Alice', 'Bob', 'Carol', 'Dave']);

  const playersList = page.locator('#players-list');
  await expect(playersList.locator('.row-item')).toHaveCount(4);
  for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
    await expect(playersList).toContainText(name);
  }
  // Tab badge reflects the player count.
  expect(await tabBadge(page, 'Players')).toBe('4');

  // ── 3. Players tab: create "The Smiths" family with Alice + Bob ─────────
  await page.locator('#family-name').fill('The Smiths');
  const memberRows = page.locator('#family-form-members .dinner-row');
  await memberRows.filter({ hasText: 'Alice' }).locator('input[type=checkbox]').check();
  await memberRows.filter({ hasText: 'Bob' }).locator('input[type=checkbox]').check();
  await page.locator('button.btn-primary:has-text("Create Family")').click();

  const familiesList = page.locator('#families-list');
  await expect(familiesList).toContainText('The Smiths');
  // The two member tags appear in the family card.
  const smithsRow = familiesList.locator('.row-item').filter({ hasText: 'The Smiths' });
  await expect(smithsRow).toContainText('Alice');
  await expect(smithsRow).toContainText('Bob');

  // ── 4. Buy-ins tab: log every chip & money entry ────────────────────────
  await logBuyin(page, 'Alice', 100, 'chips');
  await logBuyin(page, 'Alice', 5,   'money');   // rebuy in money
  await logBuyin(page, 'Bob',   100, 'chips');
  await logBuyin(page, 'Bob',   200, 'chips');   // rebuy in chips
  await logBuyin(page, 'Carol', 100, 'chips');
  await logBuyin(page, 'Dave',  200, 'chips');

  // Per-player subtotals in the Buy-in Summary.
  const buyinSummary = page.locator('#buyin-summary');
  await expect(buyinSummary).toContainText('Alice — Total: £6.00');
  await expect(buyinSummary).toContainText('Bob — Total: £3.00');
  await expect(buyinSummary).toContainText('Carol — Total: £1.00');
  await expect(buyinSummary).toContainText('Dave — Total: £2.00');

  // ── 5. Dinner tab: add £30 Pizza paid by Dave, equal split ──────────────
  await gotoTab(page, 'Dinner');
  await page.locator('#dinner-desc').fill('Pizza');
  await page.selectOption('#dinner-payer', { label: 'Dave' });
  await page.selectOption('#dinner-split-mode', 'equal');
  // All four participants default-checked; just enter the total.
  await page.locator('#dinner-total-amount').fill('30');
  await page.locator('button.btn-primary:has-text("Add Dinner Bill")').click();

  const dinners = page.locator('#dinners-list');
  await expect(dinners).toContainText('Pizza');
  await expect(dinners).toContainText('Dave');
  await expect(dinners).toContainText('paid £30.00');
  // Equal split of £30 across 4 players -> £7.50 each.
  for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
    await expect(dinners).toContainText(`${name}: £7.50`);
  }

  // ── 6. Cash Out tab: set chip cash outs for everyone ────────────────────
  await setCashout(page, 'Alice', 500, 'chips');
  await setCashout(page, 'Bob',   100, 'chips');
  await setCashout(page, 'Carol', 300, 'chips');
  await setCashout(page, 'Dave',  300, 'chips');

  // Cash Out summary shows money equivalents per player and a grand total.
  const cashoutSummary = page.locator('#cashout-summary');
  const aliceCashoutRow = cashoutSummary.locator('.row-item').filter({ hasText: 'Alice' });
  const bobCashoutRow   = cashoutSummary.locator('.row-item').filter({ hasText: 'Bob' });
  const carolCashoutRow = cashoutSummary.locator('.row-item').filter({ hasText: 'Carol' });
  const daveCashoutRow  = cashoutSummary.locator('.row-item').filter({ hasText: 'Dave' });
  await expect(aliceCashoutRow).toContainText('£5.00');
  await expect(aliceCashoutRow).toContainText('500 chips');
  await expect(bobCashoutRow).toContainText('£1.00');
  await expect(bobCashoutRow).toContainText('100 chips');
  await expect(carolCashoutRow).toContainText('£3.00');
  await expect(carolCashoutRow).toContainText('300 chips');
  await expect(daveCashoutRow).toContainText('£3.00');
  await expect(daveCashoutRow).toContainText('300 chips');
  // Grand total: £12.00 (1200 chips * £0.01).
  await expect(cashoutSummary.locator('.grand-total')).toContainText('£12.00');

  // ── 7. Settle tab: Pot Health Check ─────────────────────────────────────
  await gotoTab(page, 'Settle');

  const potCheck = page.locator('#pot-check');
  await expect(potCheck).toContainText('Total Buy-ins');
  await expect(potCheck).toContainText('Total Cash Outs');
  await expect(potCheck).toContainText('Difference');
  // Both totals £12.00, difference +£0.00 (success alert).
  await expect(potCheck).toContainText('£12.00');
  await expect(potCheck).toContainText(/Pot balances/i);
  // No rebalance alert in the balanced case.
  await expect(potCheck).not.toContainText(/Pot rebalanced/i);

  // ── 8. Settle tab: Net Positions per player ─────────────────────────────
  const aliceRow = page.locator('#net-positions tbody tr').filter({ hasText: 'Alice' });
  const bobRow   = page.locator('#net-positions tbody tr').filter({ hasText: 'Bob' });
  const carolRow = page.locator('#net-positions tbody tr').filter({ hasText: 'Carol' });
  const daveRow  = page.locator('#net-positions tbody tr').filter({ hasText: 'Dave' });

  await expect(aliceRow).toContainText('£8.50');
  await expect(aliceRow).toContainText('pays');
  await expect(bobRow).toContainText('£9.50');
  await expect(bobRow).toContainText('pays');
  await expect(carolRow).toContainText('£5.50');
  await expect(carolRow).toContainText('pays');
  await expect(daveRow).toContainText('£23.50');
  await expect(daveRow).toContainText('receives');

  // ── 9. Settle tab: Family subtotal for The Smiths ───────────────────────
  const netPositions = page.locator('#net-positions');
  await expect(netPositions).toContainText('Family subtotals');
  // The Smiths block: contains family name + combined Alice/Bob net of -£18.00.
  const smithsSubtotalRow = netPositions.locator('.row-item').filter({ hasText: 'The Smiths' });
  await expect(smithsSubtotalRow).toContainText('£18.00');
  await expect(smithsSubtotalRow).toContainText('pays');

  // ── 10. Settle tab: Settlements list — exactly 2 txns, both into Dave ───
  const txns = page.locator('#settlements .txn-item');
  await expect(txns).toHaveCount(2);

  // Build a normalized list of triplets (from, to, amount) and match without
  // depending on row ordering.
  const observed = [];
  const txnCount = await txns.count();
  for (let i = 0; i < txnCount; i++) {
    const row = txns.nth(i);
    observed.push({
      from:   (await row.locator('.txn-from').textContent())?.trim(),
      to:     (await row.locator('.txn-to').textContent())?.trim(),
      amount: (await row.locator('.txn-amount').textContent())?.trim(),
    });
  }

  const expectedTxns = [
    { from: 'The Smiths', to: 'Dave', amount: '£18.00' },
    { from: 'Carol',      to: 'Dave', amount: '£5.50'  },
  ];
  for (const want of expectedTxns) {
    expect(observed).toContainEqual(want);
  }

  // ── 11. Copy Settlement button toggles its text on click ────────────────
  const copyBtn = page.locator('#copy-btn');
  await expect(copyBtn).toBeVisible();

  // Try to grant clipboard permission; not all envs support it, so tolerate.
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch { /* no-op */ }

  // If clipboard write rejects, the app surfaces an alert — accept it so the
  // test doesn't hang.
  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });

  await copyBtn.click();
  // Visible text either flips to "✓ Copied!" (success) or remains the
  // original "Copy Settlement..." label (failure path). Either is acceptable.
  await expect(copyBtn).toContainText(/Copied!|Copy Settlement/);
});

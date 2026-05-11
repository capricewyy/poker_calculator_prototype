import { test, expect } from '@playwright/test';
import { openApp, addPlayers, logBuyin, setCashout, gotoTab } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('chip miscount triggers auto-rebalance and nets still sum to zero', async ({ page }) => {
  await addPlayers(page, ['Alice', 'Bob']);

  // Total buy-ins: 200 chips.
  await logBuyin(page, 'Alice', 100, 'chips');
  await logBuyin(page, 'Bob', 100, 'chips');

  // Total cash-outs: 210 chips (5% over).
  await setCashout(page, 'Alice', 120, 'chips');
  await setCashout(page, 'Bob', 90, 'chips');

  await gotoTab(page, 'Settle');

  // The pot health card surfaces the rebalance alert.
  await expect(page.locator('#pot-check')).toContainText(/Pot rebalanced/i);
  await expect(page.locator('#pot-check')).toContainText('210');
  await expect(page.locator('#pot-check')).toContainText('200');

  // Read the visible net amounts and confirm they sum to zero.
  const rows = page.locator('#net-positions tbody tr');
  await expect(rows).toHaveCount(2);

  // Net cell is the last <td>. Parse the signed amount.
  const nets = await rows.evaluateAll((trs) =>
    trs.map((tr) => {
      const last = tr.querySelector('td:last-child');
      const txt = last ? last.textContent : '';
      // Match leading + or − (unicode minus) followed by currency + number.
      const m = txt.match(/([+−-])\s*[^\d-]?\s*([\d.]+)/);
      if (!m) return NaN;
      const sign = m[1] === '+' ? 1 : -1;
      return sign * parseFloat(m[2]);
    })
  );
  expect(nets.length).toBe(2);
  const total = nets.reduce((s, n) => s + n, 0);
  expect(Math.abs(total)).toBeLessThan(0.01);
});

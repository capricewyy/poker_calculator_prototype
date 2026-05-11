// ──────────────────────────────────────────
//  SETTLE
// ──────────────────────────────────────────
import { state } from '../state.js';
import { curr, fmtMoney, fmtSigned } from '../calc/chip-math.js';
import { calcNets, aggregateForSettlement, minimizeTransactions } from '../calc/settlement.js';
import { getPlayerFamily } from './families.js';

export function renderSettle() {
  if (!state.players.length) {
    document.getElementById('pot-check').innerHTML      = '<div class="empty">Add players first</div>';
    document.getElementById('net-positions').innerHTML  = '<div class="empty">Add players first</div>';
    document.getElementById('settlements').innerHTML    = '<div class="empty">Nothing to settle yet</div>';
    document.getElementById('settle-warnings').innerHTML = '';
    document.getElementById('copy-btn').style.display  = 'none';
    return;
  }

  const result = calcNets();
  const { rows: nets, scaleFactor, rebalanced, totalBuyinChips, totalCashoutChips } = result;

  // ── Pot health check ──────────────────────────────
  const totalBuyin   = nets.reduce((s, r) => s + r.buyin,   0);
  const totalCashout = nets.reduce((s, r) => s + r.cashout, 0);
  const diff         = totalCashout - totalBuyin;
  const hasCashouts  = Object.keys(state.cashouts).length > 0;

  let potHtml = `<div class="pot-bar">
    <div class="pot-stat">
      <div class="pot-stat-label">Total Buy-ins</div>
      <div class="pot-stat-value yellow">${curr()}${totalBuyin.toFixed(2)}</div>
    </div>
    <div class="pot-stat">
      <div class="pot-stat-label">Total Cash Outs${rebalanced ? ' (rebalanced)' : ''}</div>
      <div class="pot-stat-value yellow">${curr()}${totalCashout.toFixed(2)}</div>
    </div>
    <div class="pot-stat">
      <div class="pot-stat-label">Difference</div>
      <div class="pot-stat-value ${Math.abs(diff) < 0.01 ? 'green' : 'red'}">${fmtSigned(diff)}</div>
    </div>
  </div>`;
  if (rebalanced) {
    const direction = scaleFactor > 1 ? 'inflated' : 'deflated';
    const pct = Math.abs((scaleFactor - 1) * 100);
    potHtml += `<div class="alert alert-info" style="margin-top:10px;margin-bottom:0">
      &#9878;&#65039; <strong>Pot rebalanced.</strong>
      Cash-outs totalled <strong>${Math.round(totalCashoutChips)}</strong> chips
      vs buy-ins of <strong>${Math.round(totalBuyinChips)}</strong> chips.
      Each cash-out has been ${direction} by ${pct.toFixed(2)}%
      (treating ${Math.round(totalCashoutChips)} chips as ${curr()}${totalBuyin.toFixed(2)}).
    </div>`;
  } else if (hasCashouts) {
    potHtml += Math.abs(diff) < 0.01
      ? `<div class="alert alert-success" style="margin-top:10px;margin-bottom:0">&#10003; Pot balances — buy-ins equal cash outs.</div>`
      : `<div class="alert alert-warn" style="margin-top:10px;margin-bottom:0">&#9888; Pot is off by ${fmtMoney(diff)} — auto-rebalance kicks in once every player has cashed out.</div>`;
  }
  document.getElementById('pot-check').innerHTML = potHtml;

  // ── Missing cash-out warnings ─────────────────────
  const missing = state.players.filter(p => !(p.id in state.cashouts));
  let warnHtml  = '';
  if (missing.length) {
    warnHtml = `<div class="alert alert-warn" style="margin-bottom:10px">
      &#9888; Cash out not set for: <strong>${missing.map(p => p.name).join(', ')}</strong>.
      Their cash out is counted as ${curr()}0.00.
    </div>`;
  }
  document.getElementById('settle-warnings').innerHTML = warnHtml;

  // ── Net positions table ───────────────────────────
  let tbl = `<div style="overflow-x:auto"><table class="summary-table">
    <thead><tr>
      <th>Player</th><th>Buy-in</th>
      <th>Cash Out${rebalanced ? ' (adj.)' : ''}</th>
      <th>Dinner Share</th><th>Dinner Paid</th><th>Net</th>
    </tr></thead><tbody>`;

  nets.forEach(({ player, buyin, cashout, rawCashoutChips, rawCashoutMoney, share, paid, net }) => {
    const cls  = net >= 0 ? 'net-pos' : 'net-neg';
    const sign = net >= 0 ? '+' : '&minus;';
    const fam  = getPlayerFamily(player.id);
    const nameCell = `<strong>${player.name}</strong>${fam ? ` <span class="tag tag-green" style="margin-left:4px">&#128106; ${fam.name}</span>` : ''}`;
    const cashoutCell = rebalanced
      ? `${curr()}${cashout.toFixed(2)}<div style="color:#6b7280;font-size:0.75rem;margin-top:2px">${Math.round(rawCashoutChips)} chips &mdash; raw ${curr()}${rawCashoutMoney.toFixed(2)}</div>`
      : `${curr()}${cashout.toFixed(2)}`;
    tbl += `<tr>
      <td>${nameCell}</td>
      <td>${curr()}${buyin.toFixed(2)}</td>
      <td>${cashoutCell}</td>
      <td>${share > 0 ? curr()+share.toFixed(2) : '&mdash;'}</td>
      <td>${paid  > 0 ? curr()+paid.toFixed(2)  : '&mdash;'}</td>
      <td class="${cls}">
        <strong>${sign}${curr()}${Math.abs(net).toFixed(2)}</strong>
        <span class="badge ${net >= 0 ? 'badge-green' : 'badge-red'}">${net >= 0 ? 'receives' : 'pays'}</span>
      </td>
    </tr>`;
  });
  tbl += '</tbody></table></div>';

  // ── Family subtotals (used for settlement) ────────
  const items = aggregateForSettlement(nets);
  const familyItems = items.filter(it => it.isFamily);
  if (familyItems.length) {
    tbl += `<div class="section-label" style="margin-top:18px">&#128106; Family subtotals (used for settlement)</div>`;
    tbl += familyItems.map(it => {
      const cls  = it.net >= 0 ? 'net-pos' : 'net-neg';
      const sign = it.net >= 0 ? '+' : '&minus;';
      return `<div class="row-item">
        <div>
          <div class="item-name">${it.name}</div>
          <div class="item-meta">${it.members.join(', ')}</div>
        </div>
        <div class="${cls}" style="font-weight:700">
          ${sign}${curr()}${Math.abs(it.net).toFixed(2)}
          <span class="badge ${it.net >= 0 ? 'badge-green' : 'badge-red'}">${it.net >= 0 ? 'receives' : 'pays'}</span>
        </div>
      </div>`;
    }).join('');
  }

  document.getElementById('net-positions').innerHTML = tbl;

  // ── Transactions (family-aware) ───────────────────
  const txns = minimizeTransactions(items);
  const itemsByName = {};
  items.forEach(it => { itemsByName[it.name] = it; });
  const copyBtn = document.getElementById('copy-btn');
  if (!txns.length) {
    document.getElementById('settlements').innerHTML =
      `<div class="alert alert-success" style="text-align:center;font-size:1rem">&#127881; Everyone is settled up!</div>`;
    copyBtn.style.display = 'none';
  } else {
    document.getElementById('settlements').innerHTML = txns.map(t => {
      const fromIt = itemsByName[t.from];
      const toIt   = itemsByName[t.to];
      const fromSub = fromIt && fromIt.isFamily
        ? `<div style="font-size:0.7rem;color:#6b7280;margin-top:2px">${fromIt.members.join(', ')}</div>` : '';
      const toSub   = toIt   && toIt.isFamily
        ? `<div style="font-size:0.7rem;color:#6b7280;margin-top:2px">${toIt.members.join(', ')}</div>` : '';
      return `<div class="txn-item">
        <div><span class="txn-from">${t.from}</span>${fromSub}</div>
        <span class="txn-arrow">&rarr;</span>
        <div><span class="txn-to">${t.to}</span>${toSub}</div>
        <span class="txn-amount">${fmtMoney(t.amount)}</span>
      </div>`;
    }).join('');
    copyBtn.style.display = 'block';
    copyBtn._txns = txns;
  }
}

export function copySettlement() {
  const txns = document.getElementById('copy-btn')._txns || [];
  if (!txns.length) return;
  const lines = ['Poker Night Settlements', '─'.repeat(28),
    ...txns.map(t => `${t.from} → ${t.to}: ${fmtMoney(t.amount)}`)
  ].join('\n');
  navigator.clipboard.writeText(lines)
    .then(() => {
      const btn = document.getElementById('copy-btn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = '📋 Copy Settlement to Clipboard', 1800);
    })
    .catch(() => alert('Copy failed — please copy manually.'));
}

// ──────────────────────────────────────────
//  TABS
// ──────────────────────────────────────────
import { state } from '../state.js';
import { renderAll } from '../refresh.js';
import { calcNets, aggregateForSettlement, minimizeTransactions } from '../calc/settlement.js';

export function showTab(btn, name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  renderAll();
}

export function updateTabBadges() {
  const missing = state.players.filter(p => !(p.id in state.cashouts)).length;

  setBadge('tab-btn-players', state.players.length || null);
  setBadge('tab-btn-buyins',  state.buyins.length  || null);
  setBadge('tab-btn-dinner',  state.dinners.length || null);
  setBadge('tab-btn-cashout', (state.players.length && missing) ? missing : null, missing > 0);

  const result = state.players.length ? calcNets() : { rows: [] };
  const items  = result.rows.length ? aggregateForSettlement(result.rows) : [];
  const txns   = items.length ? minimizeTransactions(items) : [];
  setBadge('tab-btn-settle', txns.length || null, txns.length > 0);
}

export function setBadge(btnId, count, warn = false) {
  const btn = document.getElementById(btnId);
  let badge = btn.querySelector('.tab-badge');
  if (!count) { if (badge) badge.remove(); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge'; btn.appendChild(badge); }
  badge.textContent = count;
  badge.style.background = warn ? '#dc2626' : '#374151';
}

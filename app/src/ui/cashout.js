// ──────────────────────────────────────────
//  CASH OUT
// ──────────────────────────────────────────
import { state, save } from '../state.js';
import { renderAll } from '../refresh.js';
import { curr, c2m, toChips } from '../calc/chip-math.js';

export function setCashout() {
  const playerId  = document.getElementById('cashout-player').value;
  const rawAmount = parseFloat(document.getElementById('cashout-amount').value);
  const unit      = document.getElementById('cashout-unit').value;
  if (!playerId || isNaN(rawAmount) || rawAmount < 0) {
    alert('Select a player and enter a valid amount.'); return;
  }
  state.cashouts[playerId] = toChips(rawAmount, unit);
  document.getElementById('cashout-amount').value = '';
  save(); renderAll();
}

export function clearCashout(playerId) {
  delete state.cashouts[playerId];
  save(); renderAll();
}

export function renderCashout() {
  const el = document.getElementById('cashout-summary');
  if (!state.players.length) {
    el.innerHTML = '<div class="empty">Add players first</div>'; return;
  }
  const totalMoney = Object.values(state.cashouts).reduce((s, c) => s + c2m(c), 0);
  let html = state.players.map(p => {
    const chips = state.cashouts[p.id];
    const has   = chips !== undefined;
    return `<div class="row-item">
      <div class="item-name">${p.name}</div>
      ${has
        ? `<div style="display:flex;align-items:center;gap:10px">
            <div>
              <span class="item-value">${curr()}${c2m(chips).toFixed(2)}</span>
              <span style="color:#6b7280;font-size:0.82rem"> (${Math.round(chips)} chips)</span>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="clearCashout('${p.id}')">Clear</button>
          </div>`
        : '<span style="color:#4b5563">Not set</span>'}
    </div>`;
  }).join('');
  html += `<div class="grand-total">Total cashed out: ${curr()}${totalMoney.toFixed(2)}</div>`;
  el.innerHTML = html;
}

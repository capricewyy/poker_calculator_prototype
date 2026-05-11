// ──────────────────────────────────────────
//  BUY-INS
// ──────────────────────────────────────────
import { state, save } from '../state.js';
import { renderAll } from '../refresh.js';
import { curr, c2m, toChips } from '../calc/chip-math.js';

export function addBuyin() {
  const playerId  = document.getElementById('buyin-player').value;
  const rawAmount = parseFloat(document.getElementById('buyin-amount').value);
  const unit      = document.getElementById('buyin-unit').value;
  if (!playerId || !rawAmount || rawAmount <= 0) {
    alert('Select a player and enter a valid amount.'); return;
  }
  const chips = toChips(rawAmount, unit);
  state.buyins.push({ id: 'b_' + Date.now(), playerId, chips, originalAmount: rawAmount, unit });
  document.getElementById('buyin-amount').value = '1';
  save(); renderAll();
  document.getElementById('buyin-amount').focus();
}

export function removeBuyin(id) {
  state.buyins = state.buyins.filter(b => b.id !== id);
  save(); renderAll();
}

export function startEveryoneWithBuyin() {
  const haveBuyin = new Set(state.buyins.map(b => b.playerId));
  state.players.forEach(p => {
    if (haveBuyin.has(p.id)) return;
    state.buyins.push({
      id: `b_${Date.now()}_${p.id}`,
      playerId: p.id,
      chips: state.chipCount,
      originalAmount: 1,
      unit: 'buyin',
    });
  });
  save(); renderAll();
}

export function renderBuyins() {
  const el = document.getElementById('buyin-summary');
  if (!state.players.length) {
    el.innerHTML = '<div class="empty">Add players first</div>'; return;
  }
  let html = '';
  state.players.forEach(p => {
    const pb    = state.buyins.filter(b => b.playerId === p.id);
    const total = pb.reduce((s, b) => s + c2m(b.chips), 0);
    html += `<div class="section-label">${p.name} &mdash; Total: ${curr()}${total.toFixed(2)}</div>`;
    if (!pb.length) {
      html += `<div style="color:#4b5563;font-size:0.85rem;padding:4px 0 10px">No buy-ins logged</div>`;
      return;
    }
    pb.forEach((b, i) => {
      const label = i === 0 ? 'Buy-in' : `Rebuy #${i}`;
      const moneyStr =
        b.unit === 'chips' ? `${b.originalAmount} chips = ${curr()}${c2m(b.chips).toFixed(2)}` :
        b.unit === 'buyin' ? `${b.originalAmount} buy-in${b.originalAmount === 1 ? '' : 's'} = ${curr()}${c2m(b.chips).toFixed(2)}` :
        `${curr()}${b.originalAmount.toFixed(2)}`;
      html += `<div class="row-item">
        <div>
          <span class="tag tag-yellow">${label}</span>
          <span style="margin-left:6px">${moneyStr}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="removeBuyin('${b.id}')">&#x2715;</button>
      </div>`;
    });
  });
  el.innerHTML = html;
}

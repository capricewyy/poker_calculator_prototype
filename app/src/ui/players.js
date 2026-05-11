// ──────────────────────────────────────────
//  PLAYERS
// ──────────────────────────────────────────
import { state, save } from '../state.js';
import { renderAll } from '../refresh.js';
import { curr, c2m } from '../calc/chip-math.js';
import { getPlayerFamily } from './families.js';

export function addPlayer() {
  const el   = document.getElementById('player-name');
  const name = el.value.trim();
  if (!name) return;
  if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    alert('A player with this name already exists.'); return;
  }
  const id = 'p_' + Date.now();
  state.players.push({ id, name });
  el.value = '';
  save(); renderAll();
  el.focus();
}

export function removePlayer(id) {
  if (!confirm('Remove this player and all their data?')) return;
  state.players = state.players.filter(p => p.id !== id);
  state.buyins  = state.buyins.filter(b => b.playerId !== id);
  state.dinners = state.dinners.filter(d => d.payerId !== id);
  state.dinners.forEach(d => {
    if (d.splitMode === 'custom' && d.shares && id in d.shares) {
      d.totalAmount -= d.shares[id];
      delete d.shares[id];
    }
    d.participants = d.participants.filter(pid => pid !== id);
  });
  state.dinners = state.dinners.filter(d => d.participants.length > 0 && d.totalAmount > 0);
  state.families.forEach(f => { f.memberIds = f.memberIds.filter(pid => pid !== id); });
  state.families = state.families.filter(f => f.memberIds.length >= 2);
  delete state.cashouts[id];
  save(); renderAll();
}

export function renderPlayers() {
  const el = document.getElementById('players-list');
  if (!state.players.length) {
    el.innerHTML = '<div class="empty">No players added yet</div>'; return;
  }
  el.innerHTML = state.players.map(p => {
    const buyinTotal = state.buyins
      .filter(b => b.playerId === p.id)
      .reduce((s, b) => s + c2m(b.chips), 0);
    const nBuyins = state.buyins.filter(b => b.playerId === p.id).length;
    const co = state.cashouts[p.id] !== undefined ? c2m(state.cashouts[p.id]) : null;
    const fam = getPlayerFamily(p.id);
    return `<div class="row-item">
      <div>
        <div class="item-name">
          ${p.name}
          ${fam ? `<span class="tag tag-green" style="margin-left:6px">&#128106; ${fam.name}</span>` : ''}
        </div>
        <div class="item-meta">
          ${nBuyins} buy-in${nBuyins !== 1 ? 's' : ''} &mdash; total ${curr()}${buyinTotal.toFixed(2)}
          &nbsp;&bull;&nbsp;
          Cash out: ${co !== null ? curr()+co.toFixed(2) : '<span style="color:#4b5563">not set</span>'}
        </div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removePlayer('${p.id}')">Remove</button>
    </div>`;
  }).join('');
}

export function updateSelects() {
  ['buyin-player', 'dinner-payer', 'cashout-player'].forEach(id => {
    const el   = document.getElementById(id);
    const prev = el.value;
    el.innerHTML = !state.players.length
      ? '<option value="">— add players first —</option>'
      : state.players.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    if (prev && state.players.some(p => p.id === prev)) el.value = prev;
  });
}

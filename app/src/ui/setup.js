// ──────────────────────────────────────────
//  SETUP
// ──────────────────────────────────────────
import { state, save } from '../state.js';
import { renderAll } from '../refresh.js';
import { curr, chipVal } from '../calc/chip-math.js';

export function saveChipRate(btn) {
  const count = parseFloat(document.getElementById('chip-count').value);
  const money = parseFloat(document.getElementById('chip-money').value);
  const sym   = document.getElementById('currency-symbol').value.trim() || '£';
  if (!count || !money || count <= 0 || money <= 0) {
    alert('Please enter valid positive values.'); return;
  }
  state.chipCount = count;
  state.chipMoney = money;
  state.currency  = sym;
  save();
  renderAll();
  btn.textContent = '✓ Saved';
  setTimeout(() => btn.textContent = 'Save', 1400);
}

export function clearAll() {
  if (!confirm('Delete ALL data for this session — are you sure?')) return;
  state.players = []; state.buyins = []; state.cashouts = {};
  state.dinners = []; state.families = [];
  save(); renderAll();
}

export function updateRateDisplay() {
  document.getElementById('chip-count').value       = state.chipCount;
  document.getElementById('chip-money').value       = state.chipMoney.toFixed(2);
  document.getElementById('currency-symbol').value  = state.currency;
  document.getElementById('rate-display').textContent =
    `${state.chipCount} chips = ${curr()}${state.chipMoney.toFixed(2)}`;
  document.getElementById('rate-per-chip').textContent =
    `${curr()}${chipVal().toFixed(4)}`;
}

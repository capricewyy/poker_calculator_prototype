// ──────────────────────────────────────────
//  DINNER
// ──────────────────────────────────────────
import { state, save } from '../state.js';
import { renderAll } from '../refresh.js';
import { curr } from '../calc/chip-math.js';
import { getDinnerShareFor } from '../calc/settlement.js';

export function renderDinnerForm() {
  const el = document.getElementById('dinner-form-detail');
  if (!el) return;
  if (!state.players.length) {
    el.innerHTML = '<div class="alert alert-warn" style="margin-bottom:12px">Add players first.</div>';
    return;
  }
  const mode = document.getElementById('dinner-split-mode').value;
  if (mode === 'equal') {
    el.innerHTML = `
      <div class="form-row">
        <div class="form-group" style="max-width:200px">
          <label>Total amount</label>
          <input type="number" id="dinner-total-amount" min="0" step="0.01" placeholder="0.00"
                 onkeydown="if(event.key==='Enter')addDinner()" />
        </div>
      </div>
      <div class="section-label">Who ate? (split equally)</div>
      <div class="toggle-row">
        <button type="button" class="btn btn-secondary btn-sm" onclick="setDinnerFormParticipants(true)">Select All</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="setDinnerFormParticipants(false)">Clear All</button>
      </div>
      <div id="dinner-form-participants" style="margin-bottom:12px">
        ${state.players.map(p => `
          <div class="dinner-row">
            <input type="checkbox" id="dfp_${p.id}" data-player="${p.id}" checked />
            <label for="dfp_${p.id}">${p.name}</label>
          </div>`).join('')}
      </div>`;
  } else {
    el.innerHTML = `
      <div class="section-label">Custom amounts per person</div>
      <p style="color:#6b7280;font-size:0.82rem;margin-bottom:8px">Leave blank or 0 if they didn't eat.</p>
      <div style="margin-bottom:8px">
        ${state.players.map(p => `
          <div class="dinner-row">
            <label style="flex:1;text-transform:none;font-weight:500;color:#e5e7eb;letter-spacing:0;font-size:0.92rem">${p.name}</label>
            <input type="number" data-player="${p.id}" class="dinner-share-input" min="0" step="0.01" placeholder="0.00"
                   style="max-width:120px" oninput="updateDinnerCustomTotal()"
                   onkeydown="if(event.key==='Enter')addDinner()" />
          </div>`).join('')}
      </div>
      <div class="info-bar" style="margin-bottom:12px">
        Bill total: <span id="dinner-custom-total">${curr()}0.00</span>
      </div>`;
  }
}

export function setDinnerFormParticipants(all) {
  document.querySelectorAll('#dinner-form-participants input[type=checkbox]')
    .forEach(cb => cb.checked = all);
}

export function updateDinnerCustomTotal() {
  let total = 0;
  document.querySelectorAll('.dinner-share-input').forEach(input => {
    const v = parseFloat(input.value);
    if (!isNaN(v)) total += v;
  });
  const el = document.getElementById('dinner-custom-total');
  if (el) el.textContent = curr() + total.toFixed(2);
}

export function addDinner() {
  if (!state.players.length) { alert('Add players first.'); return; }
  const payerId = document.getElementById('dinner-payer').value;
  const desc    = document.getElementById('dinner-desc').value.trim() || 'Dinner bill';
  const mode    = document.getElementById('dinner-split-mode').value;
  if (!payerId) { alert('Select a payer.'); return; }

  const entry = { id: 'd_' + Date.now(), payerId, desc, splitMode: mode };

  if (mode === 'equal') {
    const totalAmount = parseFloat(document.getElementById('dinner-total-amount').value);
    if (!totalAmount || totalAmount <= 0) { alert('Enter a valid total amount.'); return; }
    const participants = Array.from(
      document.querySelectorAll('#dinner-form-participants input[type=checkbox]:checked')
    ).map(cb => cb.dataset.player);
    if (!participants.length) { alert('Select at least one participant who ate.'); return; }
    entry.totalAmount  = totalAmount;
    entry.participants = participants;
    entry.shares       = {};
  } else {
    const shares = {};
    let total = 0;
    document.querySelectorAll('.dinner-share-input').forEach(input => {
      const v = parseFloat(input.value);
      if (!isNaN(v) && v > 0) {
        shares[input.dataset.player] = v;
        total += v;
      }
    });
    if (total <= 0) { alert('Enter at least one share amount greater than 0.'); return; }
    entry.totalAmount  = total;
    entry.participants = Object.keys(shares);
    entry.shares       = shares;
  }

  state.dinners.push(entry);
  document.getElementById('dinner-desc').value = '';
  save();
  renderAll();
}

export function removeDinner(id) {
  state.dinners = state.dinners.filter(d => d.id !== id);
  save(); renderAll();
}

export function renderDinner() {
  renderDinnerForm();
  const listEl = document.getElementById('dinners-list');
  if (!state.dinners.length) {
    listEl.innerHTML = '<div class="empty">No dinners logged yet</div>';
    return;
  }
  listEl.innerHTML = state.dinners.map(d => {
    const payer = state.players.find(p => p.id === d.payerId);
    const breakdown = d.participants.map(pid => {
      const player = state.players.find(p => p.id === pid);
      const share  = getDinnerShareFor(d, pid);
      return `${player ? player.name : '?'}: ${curr()}${share.toFixed(2)}`;
    }).join(' &bull; ');
    return `<div class="row-item" style="display:block">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">
        <div>
          <span class="tag tag-blue">${d.desc}</span>
          <span style="margin-left:6px;font-weight:600">${payer ? payer.name : '?'}</span>
          <span style="color:#6b7280;font-size:0.82rem;margin-left:6px">paid ${curr()}${d.totalAmount.toFixed(2)}</span>
          <span class="tag" style="margin-left:6px">${d.splitMode === 'equal' ? 'Equal' : 'Custom'}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="removeDinner('${d.id}')">&#x2715;</button>
      </div>
      <div style="color:#9ca3af;font-size:0.82rem">${breakdown || '<em>no participants</em>'}</div>
    </div>`;
  }).join('');
}

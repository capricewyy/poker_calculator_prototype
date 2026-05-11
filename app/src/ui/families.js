// ──────────────────────────────────────────
//  FAMILIES
// ──────────────────────────────────────────
import { state, save } from '../state.js';
import { renderAll } from '../refresh.js';

export function getPlayerFamily(playerId) {
  return state.families.find(f => f.memberIds.includes(playerId));
}

export function getUnassignedPlayers() {
  return state.players.filter(p => !getPlayerFamily(p.id));
}

export function addFamily() {
  const name = document.getElementById('family-name').value.trim();
  if (!name) { alert('Enter a family name.'); return; }
  const memberIds = Array.from(
    document.querySelectorAll('#family-form-members input[type=checkbox]:checked')
  ).map(cb => cb.dataset.player);
  if (memberIds.length < 2) { alert('Pick at least 2 players.'); return; }
  // Yank these players out of any existing family first.
  state.families.forEach(f => {
    f.memberIds = f.memberIds.filter(id => !memberIds.includes(id));
  });
  state.families = state.families.filter(f => f.memberIds.length >= 2);
  state.families.push({ id: 'f_' + Date.now(), name, memberIds });
  document.getElementById('family-name').value = '';
  save(); renderAll();
}

export function removeFamily(id) {
  if (!confirm('Remove this family grouping?')) return;
  state.families = state.families.filter(f => f.id !== id);
  save(); renderAll();
}

export function removeFamilyMember(familyId, playerId) {
  const f = state.families.find(x => x.id === familyId);
  if (!f) return;
  f.memberIds = f.memberIds.filter(id => id !== playerId);
  if (f.memberIds.length < 2) {
    state.families = state.families.filter(x => x.id !== familyId);
  }
  save(); renderAll();
}

export function addFamilyMember(familyId) {
  const select = document.getElementById('add-member-' + familyId);
  if (!select) return;
  const playerId = select.value;
  if (!playerId) return;
  // Pull the player out of any other family first.
  state.families.forEach(f => {
    if (f.id !== familyId) f.memberIds = f.memberIds.filter(id => id !== playerId);
  });
  state.families = state.families.filter(f => f.memberIds.length >= 2 || f.id === familyId);
  const f = state.families.find(x => x.id === familyId);
  if (f && !f.memberIds.includes(playerId)) f.memberIds.push(playerId);
  save(); renderAll();
}

export function renderFamilyForm() {
  const el = document.getElementById('family-form-members');
  if (!el) return;
  if (!state.players.length) {
    el.innerHTML = '<div class="empty">Add players first</div>';
    return;
  }
  el.innerHTML = state.players.map(p => {
    const fam = getPlayerFamily(p.id);
    return `<div class="dinner-row">
      <input type="checkbox" id="ffm_${p.id}" data-player="${p.id}" ${fam ? 'disabled' : ''} />
      <label for="ffm_${p.id}" style="${fam ? 'opacity:0.55' : ''}">
        ${p.name}
        ${fam ? `<span class="tag" style="margin-left:6px">in: ${fam.name}</span>` : ''}
      </label>
    </div>`;
  }).join('');
}

export function renderFamilies() {
  renderFamilyForm();
  const listEl = document.getElementById('families-list');
  if (!state.families.length) {
    listEl.innerHTML = '<div class="empty">No families yet &mdash; everyone settles individually.</div>';
    return;
  }
  const unassigned = getUnassignedPlayers();
  listEl.innerHTML = state.families.map(f => {
    const memberTags = f.memberIds.map(id => {
      const p = state.players.find(x => x.id === id);
      return `<span class="tag tag-green" style="margin-right:6px;padding:3px 8px">
        ${p ? p.name : '?'}
        <button class="btn btn-sm btn-secondary" style="margin-left:6px;padding:0 6px;font-size:0.7rem;line-height:1.4"
                onclick="removeFamilyMember('${f.id}','${id}')" title="Remove from family">&times;</button>
      </span>`;
    }).join(' ');
    const addOptions = unassigned.length
      ? `<select id="add-member-${f.id}" onchange="addFamilyMember('${f.id}')" style="max-width:200px;margin-top:8px">
           <option value="">+ add member…</option>
           ${unassigned.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
         </select>`
      : '';
    return `<div class="row-item" style="display:block">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
        <div class="item-name">&#128106; ${f.name}</div>
        <button class="btn btn-danger btn-sm" onclick="removeFamily('${f.id}')">Remove</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${memberTags}
      </div>
      ${addOptions}
    </div>`;
  }).join('');
}

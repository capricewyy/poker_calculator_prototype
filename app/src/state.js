// ──────────────────────────────────────────
//  STATE
// ──────────────────────────────────────────
export const state = {
  chipCount: 100,
  chipMoney: 1.00,
  currency: '£',
  players: [],   // [{id, name}]
  buyins: [],    // [{id, playerId, chips, originalAmount, unit}]
  cashouts: {},  // {playerId: chips}
  dinners: [],   // [{id, payerId, desc, splitMode:'equal'|'custom', totalAmount, participants:[playerId], shares:{playerId:amount}}]
  families: [],  // [{id, name, memberIds:[playerId]}]
};

// ──────────────────────────────────────────
//  PERSIST
// ──────────────────────────────────────────
export function save() {
  try { localStorage.setItem('poker_v5', JSON.stringify(state)); } catch(e) {}
}

export function load() {
  try {
    let d = JSON.parse(localStorage.getItem('poker_v5') || 'null');
    if (!d) {
      const v4 = JSON.parse(localStorage.getItem('poker_v4') || 'null');
      if (v4) d = { ...v4, families: [] };
    }
    if (!d) {
      const v3 = JSON.parse(localStorage.getItem('poker_v3') || 'null');
      if (v3) d = { ...migrateV3(v3), families: [] };
    }
    if (!d) return;
    Object.assign(state, d);
    state.cashouts = state.cashouts || {};
    state.dinners  = state.dinners  || [];
    state.families = state.families || [];
    state.currency = state.currency || '£';
  } catch(e) {}
}

export function migrateV3(old) {
  const eaters = old.dinnerEaters || [];
  const dinners = (old.dinnerPayments || []).map(p => ({
    id: p.id,
    payerId: p.payerId,
    desc: p.desc,
    splitMode: 'equal',
    totalAmount: p.amount,
    participants: eaters.slice(),
    shares: {},
  }));
  return {
    chipCount: old.chipCount,
    chipMoney: old.chipMoney,
    currency:  old.currency,
    players:   old.players  || [],
    buyins:    old.buyins   || [],
    cashouts:  old.cashouts || {},
    dinners,
  };
}

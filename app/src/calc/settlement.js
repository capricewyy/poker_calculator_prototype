// ──────────────────────────────────────────
//  SETTLEMENT
//  Pure derivation. Reads `state` for inputs, returns derived values.
//  No DOM access.
// ──────────────────────────────────────────
import { state } from '../state.js';
import { c2m } from './chip-math.js';

export function getDinnerShareFor(dinner, playerId) {
  if (dinner.splitMode === 'equal') {
    if (!dinner.participants.includes(playerId) || !dinner.participants.length) return 0;
    return dinner.totalAmount / dinner.participants.length;
  }
  return (dinner.shares && dinner.shares[playerId]) || 0;
}

export function calcNets() {
  const totalBuyinChips   = state.buyins.reduce((s, b) => s + b.chips, 0);
  const totalCashoutChips = Object.values(state.cashouts).reduce((s, c) => s + c, 0);
  const allCashedOut = state.players.length > 0 && state.players.every(p => p.id in state.cashouts);

  let scaleFactor = 1;
  let rebalanced  = false;
  if (allCashedOut && totalCashoutChips > 0 && Math.abs(totalCashoutChips - totalBuyinChips) > 0.0001) {
    scaleFactor = totalBuyinChips / totalCashoutChips;
    rebalanced  = true;
  }

  const dinnerPaidMap  = {};
  const dinnerShareMap = {};
  state.players.forEach(p => { dinnerPaidMap[p.id] = 0; dinnerShareMap[p.id] = 0; });
  state.dinners.forEach(d => {
    if (d.payerId in dinnerPaidMap) dinnerPaidMap[d.payerId] += d.totalAmount;
    state.players.forEach(p => {
      dinnerShareMap[p.id] += getDinnerShareFor(d, p.id);
    });
  });

  const rows = state.players.map(p => {
    const buyin = state.buyins.filter(b => b.playerId === p.id)
                              .reduce((s, b) => s + c2m(b.chips), 0);
    const rawCashoutChips = p.id in state.cashouts ? state.cashouts[p.id] : 0;
    const rawCashoutMoney = c2m(rawCashoutChips);
    const cashout = rawCashoutMoney * scaleFactor;
    const share   = dinnerShareMap[p.id];
    const paid    = dinnerPaidMap[p.id] || 0;
    const net     = cashout - buyin - share + paid;
    return { player: p, buyin, cashout, rawCashoutChips, rawCashoutMoney, share, paid, net };
  });

  return { rows, scaleFactor, rebalanced, totalBuyinChips, totalCashoutChips, allCashedOut };
}

export function aggregateForSettlement(rows) {
  // Collapse family members into a single virtual node so internal
  // family transfers vanish from the settlement plan.
  const items = []; // [{ name, net, isFamily, members?: [name] }]
  const accounted = new Set();

  state.families.forEach(f => {
    let famNet = 0;
    const memberNames = [];
    f.memberIds.forEach(id => {
      const row = rows.find(r => r.player.id === id);
      if (row) {
        famNet += row.net;
        memberNames.push(row.player.name);
        accounted.add(id);
      }
    });
    if (memberNames.length) {
      items.push({ name: f.name, net: famNet, isFamily: true, members: memberNames });
    }
  });

  rows.forEach(r => {
    if (!accounted.has(r.player.id)) {
      items.push({ name: r.player.name, net: r.net, isFamily: false });
    }
  });

  return items;
}

export function minimizeTransactions(items) {
  const creditors = [];
  const debtors   = [];
  items.forEach(({ name, net }) => {
    if (net >  0.005) creditors.push({ name, amount:  net });
    if (net < -0.005) debtors.push(  { name, amount: -net });
  });
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort(  (a, b) => b.amount - a.amount);

  const txns = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const amt = Math.min(creditors[i].amount, debtors[j].amount);
    txns.push({ from: debtors[j].name, to: creditors[i].name, amount: amt });
    creditors[i].amount -= amt;
    debtors[j].amount   -= amt;
    if (creditors[i].amount < 0.005) i++;
    if (debtors[j].amount   < 0.005) j++;
  }
  return txns;
}

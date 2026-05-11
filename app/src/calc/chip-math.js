// ──────────────────────────────────────────
//  CHIP / MONEY HELPERS
//  Pure: imports `state` for read-only access to currency + chip rate.
//  No DOM access.
// ──────────────────────────────────────────
import { state } from '../state.js';

export const curr      = () => state.currency || '£';
export const chipVal   = () => state.chipMoney / state.chipCount;
export const c2m       = chips => chips * chipVal();
export const m2c       = money => money / chipVal();
export const toChips   = (amount, unit) => unit === 'chips' ? amount : m2c(amount);
export const fmtMoney  = n => curr() + Math.abs(n).toFixed(2);
export const fmtSigned = n => (n >= 0 ? '+' : '−') + curr() + Math.abs(n).toFixed(2);

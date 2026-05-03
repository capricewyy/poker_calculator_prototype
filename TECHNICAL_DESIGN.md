# Poker Night — Technical Design (Prototype Snapshot)

A starting-point document describing what the current prototype is, how it
works, and where the seams are for evolving it into a "real" web or mobile app
with persistent history, seasons, groups, and multi-device sync.

---

## 1. What the prototype is today

A single self-contained HTML file ([poker-calculator-v2.html](poker-calculator-v2.html))
that runs entirely client-side in a browser. Friends have used it during home
games to track buy-ins, rebuys, dinner bills, cash-outs, and settlements for **one
session at a time**. There is no backend, no account, and no notion of history
beyond "the most recent session in this browser."

### Files
- [poker-calculator.html](poker-calculator.html) — v1 (no families). Storage key `poker_v4`.
- [poker-calculator-v2.html](poker-calculator-v2.html) — v2 (current). Storage key `poker_v5`. Migrates `poker_v3` → `poker_v4` → `poker_v5`.

### Stack
- Plain HTML + CSS + vanilla JS, no build step, no dependencies.
- `localStorage` for persistence (~5MB per origin, single-browser, single-device).
- All state lives in a single JS object (`state`) and is re-rendered top-down on every change (`renderAll()`).

---

## 2. Feature surface

Six tabs, each backed by a slice of `state`:

| Tab | Purpose | State touched |
|---|---|---|
| **Setup** | Define `chips ↔ money` rate and currency symbol | `chipCount`, `chipMoney`, `currency` |
| **Players** | Add/remove players; group into "families" (couples/roommates) | `players`, `families` |
| **Buy-ins** | Log buy-ins and rebuys, in chips or money | `buyins` |
| **Dinner** | Log dinner bills with payer + equal-or-custom split | `dinners` |
| **Cash Out** | Record what each player leaves the table with | `cashouts` |
| **Settle** | Compute nets, rebalance pot, minimize transfers | derived |

Tab badges show counts/warnings (e.g. how many players still need a cash-out).

---

## 3. Data model (current `state` shape)

```js
state = {
  // Setup
  chipCount: 100,        // chips per `chipMoney`
  chipMoney: 1.00,       // money equivalent
  currency:  '£',

  // Players
  players: [{ id: 'p_<ts>', name: string }],

  // Family groupings (for settlement purposes only)
  families: [{ id: 'f_<ts>', name: string, memberIds: [playerId] }],

  // Buy-in / rebuy log
  buyins: [{
    id: 'b_<ts>',
    playerId,
    chips: number,           // canonical: always stored in chips
    originalAmount: number,  // what the user typed
    unit: 'chips' | 'money', // how they typed it
  }],

  // Dinner bills (multiple per session)
  dinners: [{
    id: 'd_<ts>',
    payerId,
    desc: string,
    splitMode: 'equal' | 'custom',
    totalAmount: number,             // money
    participants: [playerId],
    shares: { [playerId]: number },  // only used in custom mode
  }],

  // Cash-out per player (chips)
  cashouts: { [playerId]: chips },
}
```

**Observations**

- All monetary state derives from chips via `chipVal = chipMoney / chipCount`.
- IDs are timestamp-based strings (`p_…`, `b_…`, `d_…`, `f_…`). Fine for a
  single-device, single-session app; collision-prone the moment two devices
  generate IDs offline and try to merge.
- A "session" is implicit — there's only ever one. To get a new game you hit
  **Clear All Data**.

---

## 4. Core algorithms

### 4.1 Chip ↔ money conversion ([poker-calculator-v2.html:365-371](poker-calculator-v2.html#L365-L371))
```
c2m(chips)  = chips * (chipMoney / chipCount)
m2c(money)  = money / (chipMoney / chipCount)
```
All buy-ins and cash-outs are **stored in chips** so that changing the rate
later doesn't corrupt history. Dinner amounts are stored in money (they
represent real-world bills, not chips).

### 4.2 Net position per player ([poker-calculator-v2.html:898-933](poker-calculator-v2.html#L898-L933))
```
net = cashout − buy-ins − dinner_share + dinner_paid
```
Positive net → receives. Negative → pays.

### 4.3 Pot rebalancing
If every player has a cash-out logged but `Σ cashout_chips ≠ Σ buyin_chips`
(typical: chips were miscounted at end-of-night), each cash-out is multiplied
by `scaleFactor = totalBuyinChips / totalCashoutChips` so the pot conserves
money. This handles the real-world "we have 12 extra chips, who has them?"
problem gracefully.

### 4.4 Family-aware settlement ([poker-calculator-v2.html:935-987](poker-calculator-v2.html#L935-L987))
1. Aggregate per-player nets into a flat list of "items," collapsing each
   family into a single virtual node with a summed net.
2. Split items into creditors (net > 0) and debtors (net < 0); sort each
   descending.
3. Greedy two-pointer match: largest debtor pays largest creditor until one
   is satisfied; advance pointer; repeat. Produces at most `n − 1` transfers.

This is the standard "minimize debt transactions" greedy approximation. It's
not provably optimal in pathological cases but is fine for typical poker-night
sizes (≤ 12 people).

---

## 5. Persistence & migration

- Single `localStorage` key per version: `poker_v3` → `poker_v4` → `poker_v5`.
- On load, falls through versions and runs `migrateV3()` if needed.
- No remote sync, no export/import (other than copying settlements to the clipboard as text).

---

## 6. Why this won't carry the "real" features as-is

The features the user wants next — **persistent P/L history per player**,
**seasons / groups**, multi-device — break the prototype's core assumptions:

| Wanted feature | What it requires that we don't have |
|---|---|
| P/L history per player across sessions | A `Session` entity; `Player` as a first-class durable record (not "the people in this game"); a stable identity for players that survives across sessions |
| Seasons / groups | A `Group` entity (recurring playing group); a `Season` entity scoped to a group; sessions belong to seasons |
| Multi-device | A backend, auth, and sync — `localStorage` is per-browser |
| One person logs the game, others see results | Auth + sharing model (game owner, members, read-only viewers) |
| Stats / leaderboards | Aggregations over many sessions, ideally server-side |
| Conflict resolution if two people edit | Either server-authoritative writes or CRDT/last-writer-wins with proper IDs |
| Deletes that don't lose history | Soft deletes with `deleted_at`; current code mutates arrays in place |

The current ID scheme (timestamp strings minted on a single device) and the
single-session `state` blob both need to go.

---

## 7. Proposed target data model (for "real" features)

This is a sketch, not a final schema — intended as a reference for evaluating
each new feature.

```
User           id, email, display_name, auth_provider
Group          id, name, created_by (User), invite_code
GroupMember    group_id, user_id, role: owner | admin | member
Season         id, group_id, name, starts_on, ends_on, stake_rate
Player         id, group_id, display_name, linked_user_id (nullable)
                 — a Player belongs to a Group; may or may not be a real User account
Session        id, season_id, played_on, location, chip_rate, currency, status
SessionPlayer  session_id, player_id, seat_no
Buyin          id, session_id, player_id, chips, original_amount, unit, at
Dinner         id, session_id, payer_player_id, desc, total_amount, split_mode
DinnerShare    dinner_id, player_id, amount   — for both equal and custom (denormalized for query speed)
Cashout        session_id, player_id, chips, at
Family         id, session_id, name           — per-session, since couples come and go
FamilyMember   family_id, player_id
Settlement     id, session_id, from_player_id, to_player_id, amount, settled_at (nullable)
```

Key shifts vs. the prototype:
- **`Player` ≠ `User`.** A Player is "someone in this group's games" and may not have an account. Linking to a `User` is optional and happens via invite.
- **Families are session-scoped**, not global. (Same as today, but now explicit.)
- **`DinnerShare` is denormalized** so queries like "total dinner spend per
  player across the season" don't need to recompute splits.
- **`Settlement` is persisted** and has an optional `settled_at` so you can
  track who has actually paid up.
- **All IDs are server-issued (UUIDs)** to make multi-device safe.

P/L per player per season then falls out naturally:
```
session_pnl(player) = Σ cashout_chips * chip_rate
                    − Σ buyin_chips   * chip_rate
                    − Σ dinner_share
                    + Σ dinner_paid
season_pnl(player)  = Σ session_pnl over sessions in season
```

---

## 8. Architecture options for the next step

Three credible paths, in order of effort:

### A. **PWA (web app, installable)** — least change
- Wrap the existing UI in a small framework (React or Svelte), keep the calc logic, swap `localStorage` for IndexedDB (for size) + a thin sync layer.
- Ship as a Progressive Web App: works on iOS/Android home-screen, offline-first.
- Backend: Supabase or Firebase (auth + Postgres/Firestore + realtime) is enough to hit feature parity quickly.
- **Pro:** Single codebase, fastest to ship, no app-store gatekeeping.
- **Con:** Push notifications and "feels native" are weaker on iOS PWAs.

### B. **React Native / Expo + web target** — mobile-first, shared code
- Expo Router gives you iOS, Android, and web from one codebase.
- Reuse the calc logic verbatim (it's just functions).
- Same backend choice as A.
- **Pro:** Real native apps, real push, App Store/Play presence. Web still falls out for free.
- **Con:** More moving parts (EAS builds, store review, native debugging).

### C. **Native iOS + Native Android** — most polish, most work
- Only worth it if there's a feature that genuinely needs platform APIs (e.g. NFC chip-counting, ARKit chip recognition, Apple Pay/Google Pay settlement integration).
- For the features described so far, this is overkill.

**Recommendation to evaluate next:** start with **B (Expo + Supabase)**. It
gives a real mobile app, keeps a web entry point for desktop users, and lets
the existing calc code move over largely intact. Path A is the fallback if
mobile turns out to be a distraction.

---

## 9. What to keep, what to throw away

**Keep:**
- The chip-rate / `c2m` / `m2c` model.
- The pot rebalance behavior (it handles real human chip-counting errors).
- The family-aware settlement aggregation + greedy minimization.
- The "buy-in stored in chips, dinner stored in money" split.
- The UX flow of the six tabs — user-tested and works.

**Throw away or rebuild:**
- Single-blob `state` + `localStorage` persistence.
- Timestamp-string IDs.
- Top-down `renderAll()` re-render — fine for a one-pager, won't scale to a real app with screens, lists, charts.
- The implicit "one current session" assumption — this is the single biggest schema change.

---

## 10. Open questions to resolve before building

1. **Players without accounts:** Most home-game players won't sign up. Do
   non-account players still get history? (Yes, scoped to their group, until
   they claim their identity via invite — same model as Splitwise.)
2. **Who owns a session's data?** The host who logged it, the group, or every
   participant? Affects deletion rules and exports.
3. **Currency / stakes per session vs. per group?** A group might play
   different stakes on different nights.
4. **Settlement tracking:** do we track "Alice owes Bob £40" until paid, or
   stop at "here's the suggested transfers"?
5. **Offline-first vs. online-only:** poker nights happen in basements with
   bad wifi. Offline-first writes + sync-on-reconnect is probably the right
   call but adds complexity.
6. **Do dinner bills generalize?** Today it's "dinner." In practice, "drinks,"
   "snacks," "Uber home" are the same shape — should this be a generic
   "shared expenses" feature?

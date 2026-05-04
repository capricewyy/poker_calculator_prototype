# Poker Night — Feature Catalog

This is the source of truth for **what the product does and is supposed to
do**. Each item is a feature with a status. Read alongside
[overview.md](overview.md) for the principles that decide trade-offs, and
[TECHNICAL_DESIGN.md](../../TECHNICAL_DESIGN.md) for what the prototype already
implements.

Feature IDs are derived from the section letter plus the item number — item 5
in section B is **B5**, item 11 in section A is **A11**, and so on.
Cross-references throughout the doc use these IDs.

## Status legend

- **Built** — Works in the prototype today.
- **Partial** — Works in a limited or session-only form; needs to evolve.
- **Planned** — Required for the target product; not yet built.
- **Backlog** — Decided to defer; not on the current roadmap. Revisit after v1.
- **Open** — Still under discussion. Not yet committed.

---

## A. Session-night logging (the live game)

The flow a host runs while sitting at the table. This is the part that must
stay fast and forgiving.

1. Configure chip-to-money rate per session — **Built**
   - e.g. 100 chips = £1.
2. Configure currency symbol per session — **Built**
3. Add and remove players for the night — **Built**
4. Group players into "families" for joint settlement — **Built**
   - Couples, roommates. Session-scoped.
5. Log buy-ins and rebuys in chips OR money — **Built**
   - Stored canonically in chips so rate changes don't corrupt history.
6. Log shared expense ("dinner") with payer — **Built**
   - Currently labelled "Dinner". F4 (backlog) covers generalizing it.
7. Equal split of a shared expense across selected participants — **Built**
8. Custom per-person split of a shared expense — **Built**
9. Multiple shared expenses per session — **Built**
10. Record each player's final cash-out — **Built**
11. Auto-rebalance pot when chip totals don't match buy-ins — **Built**
    - Handles real-world miscount.
12. Compute per-player net (cash out − buyins − share + paid) — **Built**
13. Minimize transfer count (greedy debt settlement) — **Built**
14. Family-aware settlement (couples settle as one) — **Built**
15. Tab-level badges showing what's missing (e.g. players without cash-outs) — **Built**
    - UX nudge.
16. Copy settlement summary to clipboard — **Built**
17. Reset / clear current session — **Built**
    - Today this is the *only* way to start a new game.

## B. Cross-session continuity (the headline gap)

The single biggest shift from prototype to product. Today there is one
implicit "current session"; the product needs many.

1. A session is a discrete, durable record (not a rolling state) — **Planned**
2. A player has a stable identity across sessions within a group — **Planned**
3. Browse a list of past sessions — **Planned**
4. View the full settlement and details of a past session — **Planned**
   - Read-only by default.
5. Edit a past session — **Planned**
   - Rare flow. Downstream stats are NOT auto-updated; user triggers B11 to recompute.
6. Soft-delete a session without losing the historical trail — **Planned**
7. Per-player P/L across a season — **Planned**
   - Headline new capability.
8. Per-player lifetime P/L within a group — **Planned**
9. Group-level leaderboards (most won, most played, biggest single night) — **Planned**
10. Per-session and per-season summaries (avg pot, attendance, etc.) — **Planned**
11. Manual "refresh stats" action on the group/home page — **Planned**
    - Recomputes leaderboards and aggregates from authoritative session records. Used after a B5 edit or B6 delete.

## C. Groups and seasons

Recurring crews and the time-buckets they play in. Group **membership** is the
stable list of who *can* play; session **attendance** is per-night and is a
subset of the group's members. The two must not be conflated.

1. Create a group — **Planned**
   - A recurring playing crew.
2. Invite people to a group via link or code (invite-only, no discovery) — **Planned**
   - No public profiles; users only see groups they belong to.
3. Group has owner, admins, and members — **Planned**
   - **Owner/admin can edit any session in the group** (super-admin over D6).
   - Member is a play-only role.
4. Group-level default chip rate, currency, location — **Planned**
   - Overridable per session.
5. Create a season within a group — **Planned**
   - e.g. "Spring 2026".
6. Season has start/end dates and resets leaderboards — **Planned**
7. A session belongs to exactly one season (and therefore one group) — **Planned**
8. A user can belong to multiple groups — **Planned**
   - Tuesday crew + weekend crew, etc.
9. A user can leave a group — **Planned**
   - Their historical session participation stays; they lose ongoing access.

## D. Identity and sharing

The optional-account model. Designed to never block the host on a player
signing up.

1. Sign in via existing social or email identity (Google, Instagram, etc.) — **Planned**
   - **Default identity path.** We piggyback on third-party identity rather than running our own password store.
2. Name-only guest entry as a fallback when a player can't link an account — **Planned**
   - Splitwise-style. The host types a name; no account is created. Used when D1 isn't possible at the table.
3. Claim-by-invite: user-initiated auto-claim of a guest record on first sign-in — **Backlog**
   - When Bob eventually signs in, his historical Bob-rows merge in automatically. Deferred past v1 — the v1 path is the admin-driven manual merge in D4.
4. Admin-driven manual merge of unclaimed guest records into a signed-in player — **Planned**
   - **V1 substitute for D3.** When a previous guest signs up, a group admin opens a list of that group's unclaimed guest names and ticks the rows that belong to the new account (e.g. tick "Jack" and "J.W." to merge them into JACK W.'s account). Once merged, the player's history flows into D5/D7/D8 views as if they had been signed in all along. No user-initiated path in v1 — the merge always goes through an admin.
5. Read-only result view for a participant who has an account — **Planned**
   - "Here's what you owe / are owed for last night."
6. Permission model: group owner / admin / host / participant — **Planned**
   - Owner & admins (C3) can edit any session in the group.
   - Owner & admins also run the D4 manual-merge flow.
   - The host is the editor of record for the night they ran.
   - Participants view only.
7. Group-level shared visibility: every member of a group can view all members' P/L, ranking, and average profit within that group — **Planned**
   - Builds on B7–B9. Within a group, per-player stats and leaderboards are open to every member — not host-only and not self-only. Clarifies what "participants view only" in D6 means at the group level: *all* group stats are visible, not just the viewer's own row.
8. Personal cross-group P/L roll-up — **Planned**
   - A user can view their *own* combined P/L across every group they belong to. **Personal view only** — there is no cross-group leaderboard or ranking; users only ever see their own roll-up.
   - Aggregation must normalize for stakes (e.g. relative to each group's chip rate or average buy-in) so a high-stakes group doesn't dwarf a low-stakes one. Exact normalization formula is **Open**.
9. Export a session or season as CSV / JSON — **Open**
   - Useful for power users; not load-bearing.

## E. Platform and sync

Where the app runs and how data moves.

1. Web access (browser) — **Built**
   - Single HTML file today.
2. Installable mobile experience (PWA or native) — **Planned**
   - Architecture choice — see TECHNICAL_DESIGN §8.
3. Multi-device sync for a single user's data — **Planned**
4. Server-issued IDs replace timestamp string IDs — **Planned**
   - Required for safe multi-device merge.

## F. Settlement extensions and shared expenses (backlog)

Everything in this section is **deferred past v1**. The hard floor for
settlement is already covered by A16 (in-app summary + clipboard copy) — the
host can screenshot or paste it into the group's chat themselves.

1. Mark a settlement transfer as paid — **Backlog**
   - Nice-to-have; not required.
2. Show outstanding debts to a participant on their next session — **Backlog**
   - Depends on F1.
3. Send a reminder ("you still owe £40") via email or push — **Backlog**
   - Depends on F1.
4. Generalize "dinner" to arbitrary shared expenses (drinks, transport, etc.) — **Backlog**
   - Data shape is identical; only the UI label changes. Ships as "dinner" in v1.
5. Recurring expenses (e.g. weekly snack kitty) — **Backlog**
   - Lowest priority.

---

## Product decisions

These were the open product questions captured during spec drafting. Each is
now resolved. Use these as the source of truth when an answer affects schema,
permissions, or feature scope.

1. **Non-account players' history is merged in by an admin once they sign up.**
   User-initiated auto-claim (D3) is deferred to backlog. The v1 path is the
   admin-driven manual merge (D4): when a previous guest creates an account,
   a group admin ticks the unclaimed guest rows that belong to that
   identity (e.g. "Jack" and "J.W." into JACK W.) and the history flows
   into the player's account-level views. Until that merge runs, the
   guest's P/L lives only inside session records (visible to other group
   members per D7) and the guest has no account-level view of their own.

2. **Sessions are owned by the group; the host is the editor of record;
   group admins can override.** A session belongs to the group, not to the
   host who logged it. The host edits during/right after the night. **Group
   owners and admins (C3) act as super-admins and can edit any session in
   their group.** Group **membership** and session **attendance** are
   independent — not every member plays every night.

3. **Stakes default at the group level, override per session.** Each group
   sets a default chip rate and currency (C4); a session can override either
   when its night runs at different stakes. Season is *not* the default
   layer — it's purely a time-bucket for stats.

4. **Settlement tracking is nice-to-have, not required.** The hard floor is
   the existing in-app summary plus clipboard copy (A16): the host can
   screenshot or paste it into the group's chat. F1–F3 (mark-paid,
   carry-forward debts, reminders) sit in the backlog.

5. **Generic shared expenses are de-prioritized.** "Dinner" remains the only
   labelled shared-expense category for v1. F4 sits in the backlog.

6. **Session editing is rare; stats recompute is manual.** A settled session
   is treated as fixed for stat purposes. If a host needs to correct
   something after the fact, they edit the session (B5), then trigger a
   manual "refresh" (B11) on the group/home page that recomputes
   leaderboards and aggregates from authoritative records. No automatic
   cascade.

7. **Groups are invite-only and private; users can leave.** No discovery,
   no public profiles — a user only sees groups they belong to (C2). Leaving
   a group is supported (C9); historical participation is preserved when
   someone leaves.

8. **V1 cut confirmed.** Floor: All points in A, B, C, D1, D2, D5-9, all points in E.
   Section F is fully out of v1. The architect should validate this against
   effort.

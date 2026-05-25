# Poker Night — Identity & Permissions Design

**Status:** Draft for review · **Date:** 2026-05-25 · **Scope:** Auth provider integration, RLS matrix detail, guest-account binding mechanics, the group-join state machine with admin-driven merge at approval time, merge/unmerge contracts, and forward-compat for public signup. Phases 0–4 per [top-level-design.md](top-level-design.md) §15.

## 1. Context

Identity in this product is dual-shaped from day one: every name-only player (D2) is a `players` row with `linked_user_id IS NULL`, and any of those rows may late-bind to a real account (D1) without losing history. The destructive write that performs that bind — `internal_merge_player` — is the highest-stakes operation in the system (risk #4) and is reached through three trigger paths: **admin-driven merge during group-join approval** (v1 primary; admin recognizes the new account and selects unlinked guest records to merge as part of approving the join), **admin-direct cleanup merge** (v1 secondary; for guests that surface after admission), and **auto-claim by email match** (D3, post-v1).

The non-trivial work this doc owns:

- The D6 permission matrix expressed as predicates over `group_members.role` (now four-tier — `owner > admin > host > member`, see top-level Appendix C divergence 5), the linked user of `sessions.host_player_id`, and `auth.uid()`.
- The `group_join_requests` state machine where admission and merge happen atomically in one transaction.
- The session-creation host-eligibility gate.
- Forward-compat for public signup and group discoverability (top-level §6.2) without violating decision 7's "no public profiles" rule.

This is the **behavioral contract** that [db-backend.md](db-backend.md) realizes in SQL. Where this doc says "the admin can promote a member to host", db-backend.md says "the `UPDATE` policy on `group_members` requires `role_in_group(group_id) = 'owner'`" — same rule, different layer.

### Scope boundaries

**In scope:** Auth provider configuration and the OAuth handoff contract; the full D6 matrix across the four roles; every state machine and UX flow that touches identity (claim, join, merge, unmerge, leave, transfer, invite-redeem, invite-rotate); forward-compat dimensions for opening discovery and public signup.

**Out of scope:** DDL of the request tables and the actual RLS policy SQL ([db-backend.md](db-backend.md)); screens that render "waiting for admin review", the join-approval queue, leave-group, role management ([frontend.md](frontend.md)); auth provider outage response ([operations.md](operations.md)); per-environment OAuth client IDs and redirect URL configuration ([productionization.md](productionization.md)).

### Anchors in the top-level architecture

- §4.1 — Guest → account binding mechanism.
- §4.2 — Group join request table.
- §6 — Permission enforcement (the D6 matrix sketch).
- §6.1 — Invite-driven join + admin-merge flow.
- §6.2 — Forward-compatibility with public signup, discovery, and join requests.
- Risks #4, #8, #10, #11, #12, #13.
- Appendix C divergences 3, 4, 5.

---

## 2. Auth provider configuration

### 2.1 Provider choice

**Supabase Auth (GoTrue)** is the provider, bundled with the DB (no second vendor). Three sign-in methods:

- **Google OAuth** — primary for most users.
- **Apple Sign-In** — mandatory on iOS App Store for any app that ships third-party social login.
- **Email magic-link** — fallback when a user doesn't want to link a social identity, and for cross-device handoff (e.g. signing in on a new phone without re-authenticating Google).

> **Email magic-link in copy:** treated as a third option in UX copy, *not* "social". The user sees three labelled buttons: "Continue with Google", "Continue with Apple", "Continue with email". The product principle (overview.md #2) says "social or email account" — both qualify.

### 2.2 Per-environment configuration

Three Supabase projects, each with its own auth settings. Configured via Supabase Dashboard → Authentication → Providers.

| Environment | Google OAuth client | Apple OAuth client | Magic-link redirect URL |
|---|---|---|---|
| `local-dev` | dev-only Google OAuth client (or the staging one, with `localhost` redirect added) | not configured (Apple Sign-In requires production-style domain) | `http://localhost:8081/auth/callback` |
| `staging` | dedicated Google OAuth client; redirect `https://staging.pokernight.app/auth/callback` and `pokernight://auth/callback` | dedicated Apple Service ID + Key; redirect same as Google | `https://staging.pokernight.app/auth/callback` |
| `prod` | dedicated Google OAuth client; redirect `https://pokernight.app/auth/callback` and `pokernight://auth/callback` | dedicated Apple Service ID + Key; redirect same as Google | `https://pokernight.app/auth/callback` |

Per-env OAuth client IDs and secrets are stored as Supabase project secrets (Dashboard → Project Settings → API) and are never in the repo. The deep-link scheme `pokernight://` is registered in `app.json` per Expo conventions; the OAuth callback handler bridges deep-link back to the JS layer via `expo-auth-session`.

### 2.3 Session and token lifetime

GoTrue defaults are accepted with one override:

- **Access token TTL: 1 hour** (default).
- **Refresh token TTL: 30 days** (default). Sliding window: a successful refresh extends to 30 more days.
- **Session inactivity: 90 days.** A user who hasn't opened the app in 90 days must re-authenticate. (Set via `GOTRUE_JWT_EXP_REFRESH_MAX_AGE`.)

These are the bare-minimum override: a 90-day inactivity ceiling so a long-stale device cannot silently keep authority forever, but a 30-day rolling refresh so frequent users never see a sign-in screen.

### 2.4 Sign-up exposure (v1)

Supabase Auth accepts any authenticated user from any provider; v1 hides the standalone "Create account" CTA outside the invite-redemption flow. The deep link the user actually hits is `/invite/<code>`; that screen:

1. If signed in, calls `redeem_invite(<code>)` directly.
2. If signed out, presents the three sign-in buttons; on successful sign-in, automatically calls `redeem_invite(<code>)`.

The user is not asked "want to create an account or sign in?" — the choice is "sign in with X provider", and account creation is implicit on first-ever sign-in with that provider. (GoTrue creates an `auth.users` row automatically; a trigger fans out a `public.users` row — see db-backend.md §3.2 + the trigger sketch below.)

The trigger (placed in `0010_rpc_identity.sql`):

```sql
CREATE FUNCTION public.tg_on_auth_user_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.users (id, display_name, email)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
      NULLIF(NEW.raw_user_meta_data->>'name', ''),
      CASE WHEN NEW.email IS NOT NULL THEN split_part(NEW.email, '@', 1) END,
      'Player'                                         -- last-resort placeholder; user edits on first launch
    ),
    NEW.email                                          -- may be NULL (Apple privacy relay)
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER tg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_on_auth_user_created();
```

> **Display name.** From the provider's metadata when present; falls back to the email local part, then to "Player" as a last resort. Apple Sign-In only sends `full_name` on the *first* sign-in attempt for an account, so users who land via Apple commonly need to set their name on first app launch. The client surfaces a one-time "Set your display name" prompt when `users.display_name = 'Player'` AND no avatar is set.
>
> **Email.** Nullable. Apple's "Hide My Email" relay address is stored when present; subsequent sign-ins where Apple omits the email leave `users.email` untouched (the trigger only fires on `INSERT`). Magic-link is the v1 fallback when a user wants their real email on file.
>
> **Editing.** A `users` UPDATE policy permits `auth.uid() = id` for `display_name`, `avatar_url`, `home_currency`. Email is not user-editable in v1; it tracks `auth.users.email` and is updated by a sync-on-sign-in Edge Function (post-v1 — for v1 the email on file is whatever the first provider returned).

---

## 3. Identity model

### 3.1 `users` vs `players` — the two halves

| Entity | What it represents | Lifecycle |
|---|---|---|
| `users` | A real signed-in account. Mirrors `auth.users` 1:1. Owns email + display name + avatar + home currency. Cross-group identity. | Created on first sign-in by trigger §2.4. Soft-deletes are not supported — to leave the product entirely, a user contacts the dev via support runbook (operations.md). |
| `players` | A person who appears in this group's sessions. Group-scoped. **Always present** for anyone who participates, with or without an account. | Created by host when adding to a session (D2 guest) OR by `admin_approve_join_request` when admitting a new account (D1). Soft-deletable; can merge into another player (the bind in D4). |

A `player` may have `linked_user_id IS NULL` (a guest) or `linked_user_id` set (an account-attached player). Once linked, the player carries the user's identity into stats and sharing views. **A user may have at most one canonical player per group**, enforced by partial unique index (db-backend.md §3.2).

### 3.2 Why durable players, not durable users

A name-only guest is the table-side reality: the host needs to type "Jack" and start logging buy-ins in 10 seconds, with no email, no permission, no friction. The `players` row exists so the buy-in/cashout/family-membership rows have a stable FK target. When Jack eventually signs up, the merge moves his history into his account; the original `players` row stays in the DB (now non-canonical) so the historical session records still read as "Jack played that night".

### 3.3 The `effective_players` contract

Stats reads (B7–B10, D7, D8) go through `effective_players` (db-backend.md §4.2), which resolves any non-canonical `players` row to its canonical merge target. **Session-detail reads (B4) read raw `players`** — the original name on the night is preserved in history.

The rule for new code:

- **Aggregating across sessions?** Join through `effective_players`.
- **Reading one session's roster, buy-ins, settlement?** Join raw `players`.

`v_session_player_pnl` (db-backend.md §4.3) and the leaderboard derivations all use `effective_players`. pgTAP pins this with the `t_multi_season_no_double_count` and a `t_merge_does_not_alter_session_detail` test (the latter fixture: insert a merge, assert the session-detail view still shows the pre-merge name).

### 3.4 What the merge moves and what it doesn't

`internal_merge_player(guest_id, target_id)` performs **one mutation**: set `players.merged_into_player_id = target_id` on the guest row. That's it.

Nothing else moves:

- Buy-ins, cashouts, dinners, dinner shares, family memberships, session_players: all keep pointing at the guest's `players.id`. They are reachable via `effective_players` for stats and via raw `players` for session-detail.
- The guest's `display_name` is preserved (it's what appears in session history).
- The guest row is **not deleted** — neither hard nor soft.

This is what makes unmerge cheap: undoing is a single `UPDATE` on `players.merged_into_player_id = NULL`.

### 3.5 The dual display-name model

There are two `display_name` columns: `users.display_name` (the account's current name; cross-group; editable by the user) and `players.display_name` (the name the host typed on the night this player first appeared in *this* group; per-group; preserved in history).

The rules:

- **On guest add:** the host types a name into `players.display_name`. `linked_user_id IS NULL`. `users` is not involved.
- **On admission (`admin_approve_join_request`):** a new `players` row is created with `display_name = users.display_name` at admission time. Subsequent edits to `users.display_name` do **not** cascade — the player's session-history name is frozen.
- **Session-detail reads (B4)** show `players.display_name` (raw). Old sessions show the historical name; new sessions show the name at the time the player was added or admitted.
- **Stats / leaderboards / cross-group views (B7–B10, D7, D8)** show the *current* canonical name. The view body renders `COALESCE(users.display_name, players.display_name)` for canonical players, joining `users` via `linked_user_id`. This means if Jack later updates his account name to "JackW", leaderboards show "JackW" while session detail still shows "Jack" on the nights he was logged that way.
- **Editing `players.display_name`** is permitted only for unlinked guests (so a host can correct a typo). Once `linked_user_id` is set, the player's session-history name is locked; the user controls their account name separately.

This dual model is the contract every read path must honor. db-backend.md §4 view definitions encode it; pgTAP `t_merge_does_not_alter_session_detail` and a `t_user_rename_does_not_alter_session_detail` pin it.

### 3.6 What unmerge restores and what's lost

`admin_unmerge_player(player_id)` (db-backend.md §7.4) reverses the single mutation: sets `merged_into_player_id = NULL`. The guest is canonical again; their session history snaps back to standing alone.

Within the **7-day undo window**, unmerge is lossless: every row that was redirected via `effective_players` simply stops being redirected.

Beyond the 7-day RPC window, the operation rejects with `UNMERGE_WINDOW_EXPIRED`. The audit row still exists for 55 days (raw retention, top-level §12) so the dev can manually `UPDATE` the row from a support runbook — but the *user-facing* RPC stops working.

Beyond the 55-day raw audit window, the original `before` payload is no longer in `audit_log` (the monthly rollup keeps only counts). At that point, manual reconstruction is theoretically possible from PITR (top-level §12) but is documented as **not recoverable via standard tooling**. This is the operational boundary the dev communicates if a user asks to undo a 6-month-old mis-merge.

---

## 4. The four-role hierarchy

`owner > admin > host > member`. Each role is the union of itself plus everything below.

| Role | Can do | Cannot do |
|---|---|---|
| **owner** | Everything. Promote/demote anyone. Transfer ownership. Rotate invite code. Flip `discoverability` / `join_policy`. Edit any session. Approve/reject join requests. Direct-merge guests. | Nothing in product scope. |
| **admin** | Edit any session in the group. Approve/reject join requests. Direct-merge guests. Edit group name, defaults, time_zone (but NOT discoverability/join_policy). Create + edit seasons. | Promote/demote roles. Rotate invite code. Transfer ownership. |
| **host** | Create sessions. Edit sessions they host (`host_player_id` linked to them). Edit all live-session children (buy-ins, dinners, etc.) on those sessions. | Edit sessions they didn't host. Approve/reject join requests (admin-or-up only). Create or edit seasons. Edit group settings. |
| **member** | Read everything in the group. Read leaderboards. View own and others' P/L (D7). Run B11 stat refresh. View own personal roll-up (D8). Leave the group. | Create sessions. Edit anything. Approve requests. |

### Promotion / demotion authority

Per the user's call (per brainstorming): **owner-only for all role changes.** Admin cannot promote or demote anyone — only the owner can change roles. This trades operational friction (the owner has to remember to designate hosts) for clarity and a smaller RLS surface.

**Risk #12 mitigation** lives entirely in UX: the join-approval card includes a "Promote to host?" toggle (off by default) — if the owner is the one approving, they make both decisions in one tap and never hit the friction. If an admin approves, the toggle is hidden; the new joiner is `member` until the owner promotes. The owner sees a "Pending host promotions?" hint on the group page if more than 7 days pass with no new hosts and any sessions were created in that window.

The hierarchy in code is read by `role_in_group(g)` (db-backend.md §6.1). Comparisons in policies use the explicit lists (`IN ('owner', 'admin')`) rather than ordering on the enum — easier to grep, more defensive against enum reordering.

### Default role on admission

Every new admission via `admin_approve_join_request` defaults the role to `member`. The owner promotes from there (per above). Invite codes do **not** carry a role hint in v1; see "Risk-driven UX" §15. (Post-v1: per-invite role hint — schema gets a nullable `role` column on `groups` invite payload then.)

---

## 5. The D6 permission matrix (exhaustive)

This is the v1 contract. Implementation lives in [db-backend.md](db-backend.md) §6. Each row says **who** can do **what** to **which entity**, plus a notes column for non-obvious cases.

### 5.1 Reads

| Entity | owner | admin | host | member | signed-out | other-group |
|---|---|---|---|---|---|---|
| `groups` (within group) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `seasons` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `sessions`, `session_players`, `buyins`, `cashouts`, `dinners`, `dinner_shares`, `families`, `family_members` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `players` (raw, group-scoped) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `effective_players`, `v_session_player_pnl`, `v_group_member_pnl` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `v_my_pnl_personal` | self only | self only | self only | self only | ✗ | self only (across groups they're in) |
| `group_members` (within group) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `group_join_requests` (own pending or decided) | ✓ self | ✓ self | ✓ self | ✓ self | ✗ | ✓ self |
| `group_join_requests` (group's queue) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `stats_snapshots` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `audit_log` (own actions) | ✓ self | ✓ self | ✓ self | ✓ self | ✗ | ✓ self |
| `audit_log` (group rows) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `users` (own row) | ✓ self | ✓ self | ✓ self | ✓ self | ✗ | ✓ self |
| `users` (group-mate's row, basic profile only — display_name + avatar) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ (no shared group) |

### 5.2 Writes

| Entity / action | owner | admin | host | member | Notes |
|---|---|---|---|---|---|
| Create `groups` | ✓ any | ✓ any | ✓ any | ✓ any | Any authenticated user can create a group; they become its owner. RPC `create_group(name, time_zone, defaults)`. |
| Update `groups` (name, defaults, time_zone) | ✓ | ✓ | ✗ | ✗ | |
| Update `groups.discoverability`, `groups.join_policy` | ✓ | ✗ | ✗ | ✗ | Column-scoped owner-only (db-backend.md §6.3 pattern 4). |
| Rotate `groups.invite_code` | ✓ | ✗ | ✗ | ✗ | Via `rotate_invite_code` RPC. |
| Soft-delete `groups` | ✓ | ✗ | ✗ | ✗ | |
| Insert `group_members` | — | — | — | — | Only via `admin_approve_join_request` RPC. No direct INSERT for any role. |
| Update `group_members.role` | ✓ | ✗ | ✗ | ✗ | Owner-only. Per §4. |
| Update `group_members.left_at` (leave group) | ✓ self | ✓ self | ✓ self | ✓ self | Via `leave_group` RPC. **Sole owner rejected** (across roles: only the owner can encounter this case, but the rule applies uniformly — the RPC checks role + owner-count). |
| Transfer ownership | ✓ | ✗ | ✗ | ✗ | Via `transfer_ownership` RPC. Unilateral flip (no two-step accept) — top-level §10 below. |
| Create `seasons` | ✓ | ✓ | ✗ | ✗ | |
| Update `seasons` | ✓ | ✓ | ✗ | ✗ | |
| Soft-delete `seasons` | ✓ | ✓ | ✗ | ✗ | |
| Create `sessions` | ✓ | ✓ | ✓ | ✗ | Host-eligibility gate (top-level §4.5). |
| Update `sessions` (B5) | ✓ | ✓ | ✓ if host | ✗ | Hosts edit their own night; admins edit any. |
| Soft-delete `sessions` (B6) | ✓ | ✓ | ✓ if host | ✗ | Same authorization. |
| Insert/update/delete `session_players`, `buyins`, `cashouts`, `dinners`, `dinner_shares`, `families`, `family_members` | ✓ | ✓ | ✓ if session host | ✗ | Per-table policies via `can_edit_session(session_id)`. |
| Insert `players` (guest, in a session) | ✓ | ✓ | ✓ if session host | ✗ | Hosts add guests during the live session. |
| Update `players.display_name` | ✓ | ✓ | ✓ if session host (only for unlinked guests) | ✗ | See §3.5 (dual display-name model). |
| Soft-delete `players` | ✓ | ✓ | ✗ | ✗ | Rare; mostly used to retire a duplicate after merge. |
| Update `players.merged_into_player_id` | — | — | — | — | Only via `internal_merge_player` (called by `admin_approve_join_request` or `admin_merge_players`). |
| Insert `group_join_requests` (status=pending) | — | — | — | — | Only via `redeem_invite` RPC. |
| Update `group_join_requests` → `approved` | ✓ | ✓ | ✗ | ✗ | Via `admin_approve_join_request`. |
| Update `group_join_requests` → `rejected` | ✓ | ✓ | ✗ | ✗ | Via `admin_reject_join_request`. |
| Update `group_join_requests` → `withdrawn` | ✓ self | ✓ self | ✓ self | ✓ self | Direct UPDATE policy (db-backend.md §6.2). |
| Insert `audit_log` | — | — | — | — | Only via SECURITY DEFINER RPCs. |
| Call `refresh_stats_snapshots` (B11) | ✓ | ✓ | ✓ | ✓ | Any member. |
| Call `season_backfill_by_date_range` | ✓ | ✓ | ✗ | ✗ | |
| Call `admin_merge_players` (cleanup) | ✓ | ✓ | ✗ | ✗ | |
| Call `admin_unmerge_player` | ✓ | ✓ | ✗ | ✗ | 7-day RPC window. |
| Update own `users` row (display_name, avatar_url, home_currency) | ✓ self | ✓ self | ✓ self | ✓ self | RLS: `auth.uid() = id`. |

### 5.3 The "no public profiles" rule, enforced

The `users` row of someone the caller does not share *any* group with is invisible. Implementation: `users` SELECT policy reads `EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id = users.id AND gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND left_at IS NULL) AND gm.left_at IS NULL)`. The caller's own row is always visible (`OR auth.uid() = id`).

This rule survives every forward-compat addition in §11. The directory (post-v1) lists *groups*, not users; even a "listed" group's members are not enumerated outside that group's membership.

---

## 6. The group-join state machine

```
                  redeem_invite                 admin_approve_join_request
                     (user)                          (admin)
                       │                                │
                       ▼                                ▼
    (none)  ─────▶  pending  ────────────────▶   approved
                       │                                ▲
                       │ admin_reject_join_request       │  (merge-and-admit
                       ├──────────▶  rejected           │   in one txn)
                       │
                       │ self UPDATE
                       └──────────▶  withdrawn
```

### 6.1 Transitions

| From | To | Trigger | Authorization |
|---|---|---|---|
| (none) | `pending` | `redeem_invite(code)` (v1) or `request_to_join_group(group_id)` (post-v1) | Any authenticated user. RPC validates invite code or `groups.join_policy='request_to_join'`. |
| `pending` | `approved` | `admin_approve_join_request(request_id, merge_player_ids[])` | `owner` or `admin` in the target group. |
| `pending` | `rejected` | `admin_reject_join_request(request_id, note)` | `owner` or `admin`. |
| `pending` | `withdrawn` | UPDATE on `group_join_requests` by requester | Self, while `status = pending`. |
| any other transition | — | — | Rejected. |

### 6.2 Guards

- **At most one `pending` request per (group, user)** — partial unique index (db-backend.md §3.7). Re-submitting raises `JOIN_REQUEST_PENDING`.
- **Already-member check** — `redeem_invite` rejects with `ALREADY_MEMBER` if a live `group_members` row exists for the caller in that group.
- **Decided requests are immutable** — `admin_approve_join_request` on a non-`pending` request raises `REQUEST_NOT_PENDING`.

### 6.3 Approval atomicity contract

`admin_approve_join_request` runs in one Postgres transaction. The atomicity contract is **all-or-nothing across these mutations**:

1. The new canonical `players` row for the admitted user is created.
2. Every selected guest player is merged into it (`internal_merge_player` per guest).
3. The `group_members` admission row is inserted.
4. The request transitions to `approved`.
5. An `audit_log` row is written for the approval (with all merged guest ids).
6. A `pending_stat_refresh` row is enqueued.

If **any** step fails — including a merge of a guest that turns out to already be linked (race against another admin), or a unique-constraint violation on `group_members` (the user joined via another path between admin clicks and DB write) — the entire transaction rolls back. The user remains in `pending`, no guests are partially merged, the admin sees an error.

This is pinned by the `t_join_request_approval_atomicity` pgTAP test (db-backend.md §12.2).

### 6.4 The "waiting for admin" experience

Between `redeem_invite` and `admin_approve_join_request`, the user is in `pending`. Their experience:

- After successful `redeem_invite`, the app navigates to a "Waiting for [group name] admin to approve you" screen with the requested-at timestamp and a hint about typical response time.
- They can navigate freely to other groups they're already in, edit their own profile, etc. The pending-request indicator stays as a badge on the group tile in the groups list.
- On every cold-start or app foreground, the app polls `group_join_requests` for status changes. Realtime subscription is post-v1 (Phase 5, expo-notifications); v1 uses pull-on-foreground because the UX cost of "user manually refreshes" is bearable for friends-of-friends usage (top-level risk #13).
- When `status` changes to `approved`, the indicator clears and the group appears in the user's groups list.
- When `status` changes to `rejected`, the indicator changes to "Request declined" and the user can read the `decided_note` if present. They may withdraw (clearing it) and re-redeem the invite if invited again.

---

## 7. Approval-time merge flow (the highest-stakes UX)

Per top-level §6.1 and risk #4 + risk #8, this flow's correctness depends on giving the admin the right affordances for the search-and-pick step.

### 7.1 Behavior contract

When an admin opens a pending join request, the approval card renders:

- **Requester block:** display name, email (admin-only — never shown to other group members), avatar, when they requested.
- **Group context block:** their existing membership status (none for first-time; otherwise the audit history of their previous interactions with this group).
- **Guest-candidates list:** every unlinked, non-merged, live `player` in the group, ordered by recency-weighted score (most recently active first). Each row shows:
  - Display name
  - Last-played date
  - Sessions-played count
  - A checkbox (off by default)
- **Search affordance:** a typeahead over the candidates list, matching on display name.
- **Approve button** (always one tap; selecting zero guests is the common case).
- **Reject button** (opens a small modal with an optional note).

### 7.2 UI rules

- **Default to no-merge.** The cheap path is "Approve" with zero guests selected — first-time joiners with no prior session history.
- **Merging is opt-in.** The admin must actively tick a guest. No bulk-select-all, no "select recent N" shortcut. The friction is the safety.
- **Confirmation modal on merge.** If one or more guests are ticked, tapping "Approve" opens a confirmation modal naming every ticked guest: "Merge 'Jack' and 'J.W.' into [Requester]? This combines their session history. Undo within 7 days." (Top-level risk #4 mitigation.)
- **Ordering rationale visible.** A small "(last played 2026-04-12, 7 sessions)" footer per row helps the admin recognize. Recency weight is `1 / (1 + days_since_last_played)` — keeps recent guests at the top.
- **Email displayed inline.** The requester's email is shown on the approval card because the admin uses it as confirmation of identity ("yes that's Jack's gmail"). It is **never** shown to non-admins (D7 SELECT policy on `users` returns only display_name + avatar to non-admin group members).

### 7.3 What the admin does NOT see

- The user is not asked "which old guests are you?" on their side. The picker is admin-only. The user sees the "waiting" screen until decided.
- A guest from a *different* group is not shown — candidates are filtered to the target group's `players`.
- A guest already linked to another user (rare race) is filtered out; if a race occurs between rendering and approval, the txn rolls back per §6.3 and the admin sees a "One of the selected guests is no longer eligible" error.

### 7.4 Notification of decision

V1 channel: in-app indicator only (top-level risk #11 accepted for v1).

- The requester sees a badge on the relevant group tile in the groups list ("Approved" / "Declined") on next sign-in or foreground.
- A "Recent activity" entry appears in the requester's profile: "[Date]: Joined [Group]" or "[Date]: Request declined for [Group]" (with `decided_note` if present).
- No email, no push. Phase 5 adds expo-notifications + a Supabase Edge Function fan-out — schema requires no change (the `decided_at` timestamp is the only signal needed).

---

## 8. Direct admin merge (post-admission cleanup)

The same `internal_merge_player` body, reached via `admin_merge_players(target_user_id, guest_player_ids[])` instead of `admin_approve_join_request`. Used when:

- A user joins, the admin approves cleanly (no guests merged), and **later** a forgotten guest record surfaces — a session is restored from soft-delete, an old guest the admin didn't recognize at approval time turns out to be the new user.
- The product owner promotes ergonomics and wants to surface a "Players who might be duplicates" list (post-v1 enhancement; not v1 UI).

### 8.1 UX surface (v1)

A "Merge guest into account" action lives on a player's detail page (member roster view). The admin selects a guest, picks the user-linked target from a dropdown of live group_members, and confirms.

### 8.2 Authorization

`owner` or `admin` in the guest's group. Target user-linked player must also be in the same group (cross-group merge rejected with `MERGE_CROSS_GROUP`).

### 8.3 Atomicity

Each merge is its own transaction. A multi-guest call iterates `internal_merge_player` per guest under a single function call — if guest 3 fails, guests 1 and 2 stay merged. This is **intentional** in the cleanup path (no admission to undo) but the UI defaults to one-at-a-time selection so the admin sees each merge confirmed individually.

---

## 9. Unmerge

Reached via `admin_unmerge_player(player_id)`. The body is in db-backend.md §7.4. Behavioral notes:

- **7-day RPC window.** Past this, the RPC returns `UNMERGE_WINDOW_EXPIRED`.
- **What the user sees:** a "Player merged on [date] — undo" button on the guest's row in the player roster, visible only to `owner`/`admin`, visible only while within the 7-day window.
- **Past 7 days:** the button is hidden. A "Need to undo a merge older than 7 days?" link in the admin settings opens a help page directing the user to contact the dev with the affected ids. The dev runs a manual SQL UPDATE within the 55-day audit window (operations.md runbook).
- **Past 55 days:** not recoverable via standard tooling. The help page says so explicitly. PITR (top-level §12) is theoretically a path but is not user-facing.

The user-facing communication of the boundary is part of the help page; the *enforcement* is in the RPC body. UI does not check timestamps independently — every "undo" button click calls the RPC and surfaces the error if the window has expired (e.g. clock-skew or stale UI).

---

## 10. Ownership invariant + transfer flow

### 10.1 Non-orphanable owner

A live group always has at least one `group_members` row with `role='owner'` and `left_at IS NULL`. The two operations that could violate this:

- **Leave as sole owner:** `leave_group` RPC rejects with `SOLE_OWNER`. The user sees "Transfer ownership or invite a co-owner before leaving."
- **Demote the sole owner:** there is no demote-self RPC; `transfer_ownership` is the only path out of owner role and it requires designating a successor.

### 10.2 Transfer flow (unilateral, per brainstorming)

`transfer_ownership(group_id, new_owner_user_id)`:

1. Owner-only authorization.
2. Target must be a live member of the group (`SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND left_at IS NULL`).
3. In one transaction: demote current owner to `admin`, promote target to `owner`. Write `audit_log` row `group.ownership_transfer`.

UI behavior:

- The action lives in the group settings page, owner-only.
- The owner picks a successor from a dropdown of live members.
- **Confirmation modal** lists the consequences: "You will become an admin. [Target] becomes the new owner and can change roles, transfer ownership again, and access all admin actions. This is immediate and does not require [Target]'s acceptance."
- After confirmation, ownership flips. The new owner sees a "You've been made owner of [group]" toast on next foreground / sign-in.
- A second confirmation step is intentionally *not* added — the modal copy is the safety mechanism.

> **Why unilateral, not two-step.** Per brainstorming: the friends-of-friends audience does not benefit from a pending-acceptance state. The cost of a wrong transfer is reversible (the new owner can transfer back), and the cost of a stuck pending offer (target never accepts, but the original owner thinks they've transferred) is real. Unilateral is the cleaner default.

### 10.3 What happens on the demoted owner's side

The demoted owner becomes `admin`. They retain almost all admin privileges:

- Can still approve/reject join requests.
- Can still edit any session.
- Cannot rotate the invite code (owner-only).
- Cannot flip discoverability/join_policy (owner-only).
- Cannot transfer ownership again (owner-only).
- Cannot promote/demote (owner-only).

If the demoted owner needs the role back, the new owner can transfer it back. If the new owner refuses, the demoted owner can leave the group (admin can leave freely; non-orphanable rule does not apply).

---

## 11. Forward-compat dimensions (post-v1, schema present in v1)

Three dimensions are parameterized from day one. V1 ships only the most-restrictive value for each; subsequent phases activate the others.

| Dimension | Column | V1 values | Post-v1 values | Activation requires |
|---|---|---|---|---|
| Public sign-up CTA exposure | (no column; UI rule) | hidden outside `/invite/<code>` | shown on home page | UI change only; auth provider already accepts new users. |
| Group discoverability | `groups.discoverability` | `'private'` only | `'link_only'`, `'listed'` | Directory UI + RPC `request_to_join_group(group_id)`. Admin settings UI hides the `listed` option until directory ships. |
| Group entry policy | `groups.join_policy` | `'invite_only'` only | `'request_to_join'` | Directory or shareable-link flow. The `request_to_join_group` RPC creates a `group_join_requests` row with `created_via='discovery'`. |

### 11.1 The "users are never discoverable" guarantee

Forward-compat preserves decision 7's "no public profiles" rule by construction:

- The `users` SELECT policy (§5.3) restricts row visibility to shared-group members.
- A post-v1 directory (`discoverability='listed'`) lists **groups** with name, optional public note, member count. The member count is a `COUNT(*)` that does not enumerate users; the names of members are not in the listing.
- Joining a `listed` group via `request_to_join_group` creates a `group_join_requests` row with the requester's `users` row visible only to that group's `owner`/`admin` (not to other group members or to the public).
- After admission, the new member's `users` row becomes visible to the rest of the group via the SELECT policy. No new visibility surface.

### 11.2 The "privacy escalator" modal (post-v1)

Per top-level risk #10, flipping `discoverability` from `private` to `listed` should require an explicit confirmation. Implementation when the directory ships: a modal listing every consequence (the group name + member count appear in a directory; join requests start arriving; current members can opt out). V1 cannot ship the directory; v1 *can* ship the schema. The admin UI hides the `listed` and `request_to_join` options until activation.

---

## 12. Decision-notification contract

The single channel in v1: the **in-app indicator**.

- For the requester awaiting a decision: a badge on the relevant group tile in the groups list. Polled on cold-start and foreground; updated from `group_join_requests.status` and `group_join_requests.decided_at`.
- For the admin with pending requests: a badge on the group tile in the groups list ("[N] pending requests"). Polled on cold-start and foreground.
- For ownership transfer notification: a toast "You've been made owner of [group]" the first time the new owner opens the app post-transfer. Detected by reading `audit_log` for the user's own actions/passive actions on next sign-in.

**Post-v1** (Phase 5): native push notifications via `expo-notifications` + a Supabase Edge Function fan-out triggered on `group_join_requests` decision and on `group.ownership_transfer` audit row insert. No schema change is required; the trigger is data-layer plumbing.

**Email** is not used as a notification channel at any phase — top-level §10 reserves email for billing alerts and incidents only. The product principle (overview.md #2 "account management is light") and the friends-of-friends audience together justify "open the app to see what happened."

---

## 13. Test fixture behavior contract

Implementation of the seed (the SQL that creates these rows) lives in [db-backend.md](db-backend.md) §13. This section names **what fixtures exist** and **what each is used to verify**.

### 13.1 The fixture set

Two groups, four users plus one guest, exercised across scenarios:

| Fixture | Role | Purpose |
|---|---|---|
| `owner_user` | `owner` of "Tuesday Crew"; `owner` of "Weekend Crew" | Full-power tests; cross-group privacy tests (member of A; owner of B). |
| `admin_user` | `admin` of "Tuesday Crew" | Admin-only positive tests, owner-only negative tests, role-change rejection. |
| `host_user` | `host` of "Tuesday Crew" | Host-create-session positive, edit-own-session positive, edit-others-session negative, role-change negative. |
| `member_user` | `member` of "Tuesday Crew" | Member read-only tests, every write negative, leave-group positive. |
| `guest_attached_to_member_user` | guest `players` row in "Tuesday Crew" with `linked_user_id = NULL` and a session history | Merge/unmerge tests; the candidate the admin would tick. |
| `signed_out` (no JWT) | — | Authentication-required tests; every read returns 0 rows, every RPC raises `UNAUTHENTICATED`. |
| `outsider_user` | member of "Weekend Crew" only | Cross-group isolation tests (cannot read any "Tuesday Crew" row). |

### 13.2 What each scenario verifies

Each test uses `SET LOCAL request.jwt.claim.sub = '<fixture-uuid>'` to impersonate a fixture and asserts the expected behavior. Cross-references db-backend.md §12.2 for the test names.

| Scenario | Fixtures involved | Asserts |
|---|---|---|
| `t_session_create_requires_host_eligibility` | `member_user`, `host_user`, `admin_user`, `owner_user` | `member_user` INSERT into `sessions` fails (45403); others succeed. |
| `t_session_edit_host_or_admin` | `host_user` (as host of session A), `member_user`, `admin_user` | `host_user` can UPDATE session A; cannot UPDATE session B; `admin_user` can UPDATE both; `member_user` cannot UPDATE either. |
| `t_cross_group_isolation` | `member_user`, `outsider_user` | `outsider_user` cannot SELECT any "Tuesday Crew" row across every table. |
| `t_join_request_approval_atomicity` | `outsider_user` (requests to join), `admin_user` (approves with a malformed guest list) | Approval with a guest that is already-linked rolls back; `outsider_user` stays in `pending`, no `group_members` row appears, no guest is partially merged. |
| `t_join_request_no_duplicate_pending` | `outsider_user` | Two `redeem_invite` calls produce one row + `JOIN_REQUEST_PENDING`. |
| `t_ownership_non_orphanable` | `owner_user` | `leave_group` on a group where they're sole owner raises `SOLE_OWNER`. |
| `t_role_change_owner_only` | `admin_user` | UPDATE on `group_members.role` for any row raises `FORBIDDEN`. |
| `t_discoverability_owner_only` | `admin_user`, `owner_user` | UPDATE on `groups` touching `discoverability` fails for admin, succeeds for owner. |
| `t_unmerge_within_7_days` | `guest_attached_to_member_user`, `admin_user` | Merge then immediate unmerge succeeds; merge with a backdated audit row (8d via fixture) raises `UNMERGE_WINDOW_EXPIRED`. |
| `t_merge_does_not_alter_session_detail` | `guest_attached_to_member_user` (post-merge), session-detail query | Session-detail view still shows the guest's original `display_name` on rows from before the merge. |
| `t_users_visibility_shared_group_only` | `outsider_user`, `member_user` | `member_user` cannot read `outsider_user`'s row (no shared group). After `outsider_user` joins "Tuesday Crew", `member_user` can read display_name + avatar but NOT email. |

### 13.3 Auth fixture *implementation* note

The fixtures bypass real OAuth; pgTAP tests run as a Postgres role and `SET LOCAL request.jwt.claim.sub` to impersonate. Client-side tests (RNTL, Playwright, Maestro) get matching JWTs from a test-only Supabase Auth admin endpoint or from a local `SUPABASE_JWT_SECRET`-signed token — implementation lives in [frontend.md](frontend.md).

---

## 14. The `create_group` RPC (referenced in §5.2)

Not a destructive flow, but the only path to insert into `groups` + `group_members` together; same SECURITY DEFINER pattern. Sketch:

```sql
CREATE FUNCTION public.create_group(p_name text, p_time_zone text,
  p_default_chip_count numeric DEFAULT 100, p_default_chip_money numeric DEFAULT 1.00,
  p_default_currency text DEFAULT '£')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_group_id uuid := gen_uuid_v7();
  v_invite text := encode(gen_random_bytes(8), 'base32');  -- 13 chars
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING errcode='45401'; END IF;
  INSERT INTO groups (id, name, invite_code, default_chip_count, default_chip_money, default_currency, time_zone)
    VALUES (v_group_id, p_name, v_invite, p_default_chip_count, p_default_chip_money, p_default_currency, p_time_zone);
  INSERT INTO group_members (group_id, user_id, role) VALUES (v_group_id, v_user, 'owner');
  INSERT INTO audit_log (id, group_id, actor_user_id, action, subject_table, subject_ids, after, request_id)
  VALUES (gen_uuid_v7(), v_group_id, v_user, 'group.create', 'groups',
          ARRAY[v_group_id], jsonb_build_object('name',p_name,'time_zone',p_time_zone), gen_uuid_v7());
  RETURN v_group_id;
END $$;
GRANT EXECUTE ON FUNCTION public.create_group(text,text,numeric,numeric,text) TO authenticated;
```

`p_time_zone` is mandatory (top-level §4.5 invariant) — the client defaults it from `Intl.DateTimeFormat().resolvedOptions().timeZone`. The user can override on create.

---

## 15. Risk-driven UX summaries

For each of top-level risks #4, #8, #10, #11, #12, #13, what this doc commits to:

| Risk | Commitment |
|---|---|
| **#4 Approval-time merge is highest-stakes** | Confirmation modal naming every ticked guest before approve; default-off checkboxes; 7-day undo window in `admin_unmerge_player`; audit retention 55 days for dev-side runbook beyond user undo (§9). |
| **#8 Admin search-and-pick UI quality** | Behavior contract §7.1–7.2: typeahead, recency-weighted ordering, last-played + session-count per row, default no-merge, opt-in checkboxes, modal confirmation on any merge. Risk fully addressed by the UX rules, *not* by post-hoc audit. |
| **#10 Discoverability is a privacy escalator** | Post-v1; v1 ships schema only. The admin UI hides `listed` / `request_to_join` until directory launches. When activated, a confirmation modal at the moment of flip names every consequence (§11.2). |
| **#11 Claim-decision notification channel** | V1 = in-app indicator polled on cold-start/foreground (§12). Accepted for v1 per friends-of-friends audience. Phase 5 adds push without schema change. |
| **#12 Host-role assignment friction** | "Promote to host?" toggle on join-approval card visible to owner (off by default; admin sees no toggle since they can't promote). Owner-only role changes; risk #12's friction is real but mitigated by the in-flow toggle and by a "Pending host promotions?" hint on the group page if 7+ days pass with new sessions and no promotions (§4). |
| **#13 Invite redemption no longer auto-admits** | "Waiting for [admin]" screen with requested-at timestamp + typical-response-time hint; user can use other groups while waiting (§6.4). Post-v1: opt-in email nudge to admin on request creation via Edge Function; push on decision. V1 ships with the wait visible but not pushed. |

---

## 16. Execution plan

Bucketed into **code changes**, **platform setup**, and **manual input**. Where a step requires SQL, [db-backend.md](db-backend.md) §14 owns the migration; this section names the identity-permissions-specific work.

### Phase 0 — Foundation (identity)

**Code changes:**

1. **`PR-0.1` Auth provider integration (client side).** Wire `expo-auth-session` + Supabase JS SDK for Google, Apple, magic-link. Deep-link callback handler. Sign-in screen with three buttons.
2. **`PR-0.2` Auth state hook + session refresh.** `useAuth()` returns `{user, session, signIn, signOut}`. Background token refresh.
3. **`PR-0.3` `redeem_invite` flow.** Screen: paste invite code OR open `/invite/<code>` deep link. Calls `redeem_invite` RPC. Routes to "waiting" screen on success.
4. **`PR-0.4` "Waiting for admin" screen + pull-on-foreground status polling.** Reads own `group_join_requests` rows.
5. **`PR-0.5` Admin join-approval queue (minimal).** Lists pending requests. Single "Approve" button (no guest-merge UI yet — Phase 4). Reject with optional note.
6. **`PR-0.6` `create_group` RPC** (§14) + UI to create the first group (auto-becomes owner).
7. **`PR-0.7` Auth fixture behavior contract** documented in test seed (§13.1). pgTAP scenarios from §13.2 wired.

**Platform setup:**

- **Supabase Dashboard** → Authentication → Providers: enable Google, Apple, email magic-link in each of three projects (`local-dev`, `staging`, `prod`).
- **Google Cloud Console** → create three OAuth 2.0 client IDs (one per env). Register redirect URIs per §2.2 table. Store client ID + secret in Supabase per-project secrets.
- **Apple Developer** → create Service ID + Key for "staging" and "prod" (`local-dev` skips Apple — it can't satisfy the production-domain requirement). Configure return URLs.
- **Expo `app.json`** → register `pokernight://` deep-link scheme for native; configure web origin in Supabase Auth allowed-redirects.

**Manual input required:**

- **OAuth client creation** (Google × 3 envs, Apple × 2 envs). Each requires interactive console + paying $99 Apple Developer fee for prod. **One-time cost.**
- **`/invite/<code>` URL scheme:** confirm `https://pokernight.app/invite/<code>` redirects appropriately for both signed-in and signed-out users. Configure via Vercel rewrites + Expo Web routing.
- **First-user bootstrap:** confirm the trigger `tg_on_auth_user_created` (§2.4) fires on every provider and populates `public.users` correctly. Smoke-test once per provider per env at launch.

### Phase 1 — Session parity (identity)

No identity-permissions-specific code changes. RLS policies from Phase 0 exercise against real client writes as the host logs sessions. The matrix tests in db-backend.md §12 catch any RLS regressions.

**Manual input required:**

- None.

### Phase 2 — History + groups (identity)

**Code changes:**

8. **`PR-2.1` Group settings screen.** Edit name, defaults (`chip_count`, `chip_money`, `currency`), `time_zone`. Owner/admin policy enforced server-side; UI gates accordingly. The owner-only fields (`discoverability`, `join_policy`, `invite_code` rotation) appear in a "Privacy" sub-page that v1 keeps gated to *private/invite_only* only.
9. **`PR-2.2` Invite-code display + rotation UI.** Owner-only "Rotate code" button calls `rotate_invite_code`. Display the current code with copy-to-clipboard.

**Manual input required:**

- None.

### Phase 3 — Stats + sharing + direct admin merge (identity)

**Code changes:**

10. **`PR-3.1` `admin_merge_players` direct-merge UI.** On a player's detail page (member roster), owner/admin sees a "Merge guest into account" action. Dropdown of live `group_members` as target, guest list as candidates. Uses the same confirmation-modal pattern as approval-time merge (§7.2).
11. **`PR-3.2` `admin_unmerge_player` undo UI.** "Undo merge (within 7 days)" button on merged guests, visible only to owner/admin. Hide when window expired.
12. **`PR-3.3` D7 group-member P/L view + D8 personal roll-up view.** Read `v_group_member_pnl` + `v_my_pnl_personal`. D8 displays raw per-group P/L with currency; renders the "stakes vary" caveat only when not all groups have identical `chip_count × chip_money` rates (top-level §14 risk #6).

**Manual input required:**

- None.

### Phase 4 — Identity reconciliation polish (identity)

**Code changes:**

13. **`PR-4.1` Full join-approval queue UI.** Implements §7.1–7.4 behavior contract: requester block, group context block, recency-weighted candidates list with typeahead and last-played metadata, default-off checkboxes, confirmation modal on merge, in-flow "Promote to host?" toggle visible to owner.
14. **`PR-4.2` Role-management screen.** Owner-only. List of `group_members`, role dropdown per row, calls `UPDATE group_members SET role=?` (direct UPDATE allowed by §6.2 owner-only policy; no RPC needed). pgTAP `t_role_change_owner_only` already covers.
15. **`PR-4.3` Leave-group flow + transfer-ownership flow.**
    - "Leave group" button on group settings; sole-owner case shows blocker copy and pre-empts the RPC error.
    - Owner-only "Transfer ownership" action; dropdown of live members; confirmation modal with consequences (§10.2); calls `transfer_ownership` RPC.
16. **`PR-4.4` Audit-log surfacing in admin tooling.** Group-scoped `audit_log` view (owner/admin only): filter by action, actor, date; row detail shows `before`/`after` JSONB. Read-only.
17. **`PR-4.5` "Sessions edited since last refresh" indicator** (top-level risk #5 mitigation) — surfaces a B11 nudge on the group page. Counts via a SQL view `v_sessions_edited_since_refresh(group_id)` reading `sessions.updated_at` vs `stats_snapshots.computed_at`.

**Platform setup:**

- None new.

**Manual input required:**

- None.

### Cross-phase manual input

- **OAuth client maintenance:** rotate Google/Apple secrets per provider policy (annual cadence). Document in operations.md.
- **Apple Developer membership:** renew $99 annually before expiry (auto-renew recommended).

---

## References

- [docs/architecture/top-level-design.md](top-level-design.md) — top-level architecture
- [docs/spec/features.md](../spec/features.md) — feature catalog (D1–D8, decisions 1, 2, 7; C2, C3, C9; B5/B6 host-vs-admin edit)
- [docs/spec/overview.md](../spec/overview.md) — product principles (2 "account management is light", 5 "sharing is read-mostly")
- [db-backend.md](db-backend.md) — sibling: schema and policy realization (the SQL behind §5 and §6)
- [frontend.md](frontend.md) — sibling: the screens for join-approval queue, "waiting" surface, role-management, leave flow
- [operations.md](operations.md) — sibling: undo windows beyond 7d, audit retention boundary, auth-outage runbook
- [productionization.md](productionization.md) — sibling: per-env OAuth config in CI/CD

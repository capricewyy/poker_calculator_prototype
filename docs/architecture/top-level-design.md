# Poker Night — Top-Level Architecture Design

**Status:** Draft for review · **Date:** 2026-05-17 · **Scope:** v2 product architecture

This document establishes the components, their boundaries, and the technology choices for the v2 Poker Night product. It is a *top-level* architecture brief — it names every component the system needs and the relationships between them, but it deliberately does not specify the internals of each component. Per-component design docs (RLS policies, screen-by-screen UI, EAS pipeline config, etc.) follow as separate documents.

It supersedes the speculative §7 and §8 of [TECHNICAL_DESIGN.md](../../TECHNICAL_DESIGN.md). The prototype-snapshot portions of that doc (§1–§6, §9–§10) remain valid as a record of what exists today. Read this doc alongside [docs/spec/overview.md](../spec/overview.md) (product principles) and [docs/spec/features.md](../spec/features.md) (feature catalog) — architectural decisions below cite feature IDs (`B11`, `D4`, `D7`, decision 2, etc.) when they're grounded in the product spec.

The doc captures only the selected path. Alternatives evaluated during design are recorded in [Appendix A](#appendix-a-alternatives-considered). Points where the architecture diverges from `features.md` are flagged in [Appendix C](#appendix-c-spec-contradictions-flagged).

---

## 1. Background

The prototype under [app/](../../app/) is a single-page, single-session, single-device web app that runs entirely in the browser with `localStorage` persistence. Friends have used it during home games to log buy-ins, dinner bills, cash-outs, and end-of-night settlements. It already solves the night-of bookkeeping problem well: chip-rate model, pot rebalancing under chip miscounts, family-aware settlement, greedy debt minimization, and a tested six-tab UX. These are validated mechanics; the v2 product must carry them forward without regression.

What it does not solve is everything *between* sessions: there is no concept of history, no notion of groups or seasons, no identity that survives a browser-clear, no way for a non-host participant to see results without the host's screen. [overview.md](../spec/overview.md) defines the product's job as taking the working session-night experience and extending it to persistent history, multiple groups and seasons, and sharing across devices, without sacrificing simplicity at the table.

Three anchor decisions, confirmed before drafting:

- **Audience: invite-only, friends-of-friends across multiple groups.** No public signup page in v1. New users arrive via a group invite code. The architecture is forward-compatible with opening public signup, group discovery, and join-by-request later — the constraint is enforced at the onboarding UI and per-group flags, not in the auth or data model. See §6.
- **Mobile delivery: Expo + React Native + Expo Web.** A single codebase yields iOS and Android apps plus a web target. **Native is the canonical client for the entire product** — including admin work (group/season management, approval queues, stats). Admin activities are per-group and bundle into the native app; there is no separate web admin UI. Expo Web ships from the same codebase as a desktop convenience surface with no functional partition. See §3.1.
- **Maintenance: solo developer.** Boring, well-supported tech wins. Managed services beat custom infrastructure wherever the tradeoff is reasonable.

---

## 2. Architectural pressures

The product spec produces a distinctive set of architectural pressures that shape every later choice:

- **Two clocks coexist.** Live-session writes are bursty and latency-sensitive (a host tapping buy-ins at a basement table on flaky LTE); cross-session reads are infrequent and tolerate seconds of latency. The architecture privileges write availability for the session screen and read correctness for stats — they are not the same problem.
- **Immutability with a side door.** Settled sessions are stat-authoritative (principle 4, B11 manual recompute) but explicitly soft-editable by the host (B5) and soft-deletable (B6). Stats are therefore a *derivation* of session records that can be recomputed at will — never a running tally that drifts as edits arrive.
- **Identity is dual-shaped from day one.** Social-account users (D1) and name-only guests (D2) coexist permanently in the same group. A `Player` is the durable record; a `User` account is an optional, late-binding identity attached to it. Identity binding from guest to account is a first-class operation, not a corner case (see §6.1).
- **Family aggregation is a settlement-output transform, not a P/L semantic.** Per-player P/L (B7, B8) is always computed from that player's own `buyins` and `cashouts` and never aggregated with their family. Family grouping (A4, A14) only changes the suggested transfer list produced by the greedy debt-minimization step. The same data, viewed "by player" vs. "by family", produces the same totals but different transfer lists.
- **The group is the security boundary.** D7 makes every group member a stats-peer inside the group; nothing crosses group walls except a user's own D8 personal roll-up. There is no global player table, no public profile, no discovery of individuals (decision 7). Group-level opt-in discoverability (§6) reconciles forward-compat for public signup without violating the no-personal-profiles rule.
- **Session-scoped subgraphs.** Families (A4), attendance, dinners, buy-ins, cash-outs are all scoped to a single session. Group membership is independent of session attendance (decision 2). Conflating the two is the most common modelling mistake to avoid.
- **Two layers of admin.** Group owner/admin (C3) is super-editor on every session in the group; the host is editor of the night they ran (decision 2). This is two roles whose intersection must be expressible as policy.
- **The buy-ins-in-chips invariant is load-bearing.** Storing buy-ins and cash-outs in chips (not money) is what makes rate edits non-destructive. The v2 schema preserves this.
- **Native is the canonical surface; web is a same-codebase mirror.** The host is on a phone during a game; native must work without fail. Admin activities (history review, edits, approvals, settings) are per-group and live in the same native app — there is no separate web admin UI. Expo Web ships as a desktop convenience target with no functional partition.
- **Host eligibility is a per-group role, not a per-session attribute.** Not every group member can start a game (C3 + new `host` tier). Only `owner`, `admin`, or `host` roles can create sessions; `member` is play-only. The session's editor-of-record (decision 2) is still the person who ran that night, but they must be host-eligible to become one.

---

## 3. Architecture overview

The selected path is a **Supabase-centric BaaS**: Postgres + GoTrue auth + PostgREST + Realtime + Edge Functions + Storage, all managed by one vendor, with Postgres RLS as the policy engine. Alternatives considered are in [Appendix A.1](#a1-overall-architecture).

### Components

```
                    ┌─────────────────────────────────────┐
                    │     Client (Expo: iOS / Android /   │
                    │     Web)                            │
                    │  ┌──────────────────────────────┐   │
                    │  │ UI (six-tab session +        │   │
                    │  │ groups, history, stats,      │   │
                    │  │ approvals — all native)      │   │
                    │  ├──────────────────────────────┤   │
                    │  │ Calc (chip-math, settlement) │◄──┼── ported from app/src/calc/
                    │  ├──────────────────────────────┤   │
                    │  │ Server cache (TanStack Query)│   │
                    │  ├──────────────────────────────┤   │
                    │  │ Offline mutation queue       │   │
                    │  │ (expo-sqlite / MMKV)         │   │
                    │  └──────────────────────────────┘   │
                    └────────────┬────────────────────────┘
                                 │ HTTPS + WebSocket
                ┌────────────────┴────────────────┐
                │                                 │
                ▼                                 ▼
        ┌──────────────┐                ┌─────────────────────┐
        │ Sentry       │                │      Supabase       │
        │ (errors)     │                │ ┌─────────────────┐ │
        └──────────────┘                │ │ Auth (GoTrue)   │ │
                                        │ ├─────────────────┤ │
                                        │ │ PostgREST + RLS │ │
                                        │ ├─────────────────┤ │
                                        │ │ Realtime        │ │
                                        │ ├─────────────────┤ │
                                        │ │ Postgres 15+    │ │
                                        │ ├─────────────────┤ │
                                        │ │ Edge Functions  │ │
                                        │ └─────────────────┘ │
                                        └─────────────────────┘

      Build / distribution pipeline (out-of-band):
      EAS Build → App Store / Play Store binaries
      EAS Update → OTA JS bundle updates
      Vercel    → Expo Web static export
      GitHub Actions → CI tests + migration apply
```

The client is one codebase compiled to three targets. Every business-relevant action (create group, log buy-in, refresh stats, approve a claim) is a server call mediated by RLS. Realtime is used selectively — spectator views of an in-progress session subscribe to changes — but the canonical write model is request/response, not collaborative editing.

### 3.1 Native is the canonical surface

The native client (iOS and Android) is the canonical surface for the entire product. Live session logging at the table, history browsing, group and season management, the B11 refresh button, join-request approvals (§6.1), and stats/leaderboards all live in the native app. Admin activities are per-group and bundle into the same screens the rest of the group uses — there is no separate admin UI on any platform.

Web (Expo Web) ships from the same Expo codebase as a desktop convenience surface. It renders the same screens with the same navigation; nothing is web-only or web-emphasized, and nothing is native-only except where the underlying platform API genuinely differs (e.g. native push-notification settings, native camera receipt capture — both post-v1). Platform-specific code via `.native.tsx` / `.web.tsx` suffixes is reserved for those narrow cases.

The rule of thumb: there are no per-platform UX decisions to make. If a screen exists, it renders on both targets.

---

## 4. Data model

Building on [TECHNICAL_DESIGN.md §7](../../TECHNICAL_DESIGN.md). All IDs are UUIDv7 (time-sortable, client-generated, safe for offline + multi-device). All tables carry `created_at` and `updated_at`; soft-deletable tables also carry `deleted_at`.

### Entities

| Entity | Purpose | Notes |
|---|---|---|
| `users` | Real signed-in accounts | One row per `auth.users`. Created by GoTrue on first sign-in. |
| `groups` | Recurring playing crews (C1) | Owns `invite_code`, default chip rate/currency (C4), `time_zone` (IANA, e.g. `Europe/London`), `discoverability` (private/link_only/listed), `join_policy` (invite_only/request_to_join). Soft-deletable. |
| `group_members` | Membership + role | Roles: `owner` \| `admin` \| `host` \| `member` (extends C3 — see [Appendix C](#appendix-c-spec-contradictions-flagged)). `left_at` preserves history (C9). |
| `seasons` | Time bucket within a group (C5–C7) | Stats partition only — not the default-rate layer (decision 3). |
| `session_seasons` | Many-to-many session ↔ season | Composite PK `(session_id, season_id)`. See §4.3. |
| `players` | Person who appears in this group's sessions | May or may not have `linked_user_id`. See §4.1 for binding. |
| `sessions` | A discrete game night (B1) | Belongs to one group; **may belong to zero or more seasons** via `session_seasons`. Group-level defaults populate chip/currency on create; host may override per session (decision 3). |
| `session_players` | Attendance | Independent of `group_members` (decision 2). |
| `buyins` | Buy-in / rebuy log (A5) | Canonical storage in chips. `original_amount` + `unit` preserve UX. |
| `dinners` | Shared expenses (A6) | Stored in money, not chips. **Settlement-only — not in P/L.** See §4.4. |
| `dinner_shares` | Per-player share (A7, A8) | Denormalized — equal splits write explicit rows. Settlement-only. |
| `cashouts` | Per-player end-of-night chips (A10) | Composite PK on (session_id, player_id). |
| `families` | Session-scoped family grouping (A4) | Per-session. Aggregates settlement output only; **never** factors into P/L. |
| `family_members` | Family → player association | |
| `group_join_requests` | Pending group admissions awaiting admin approval | Created for both invite-code redemption (v1) and post-v1 discovery. Admin's approval optionally merges previously-used guest players into the new user atomically. See §4.2 / §6.1. |
| `stats_snapshots` | Cached B7–B10 leaderboards | JSONB payload. Refreshed by trigger on session settle + manual B11 (see §7.1). |
| `pending_stat_refresh` | Coalescing queue for auto-refresh | One open row per (group, season). Drained by a cron Edge Function. |
| `audit_log` | Append-only history of B5 edits, B6 deletes, D4 merges, role changes, claim/join decisions | Source of truth for §12 runbooks. |

### 4.1 Guest → account binding (mechanism)

Every name-only player (D2) is a `players` row with `linked_user_id IS NULL`. Buy-ins, dinner shares, cash-outs, family membership all point at the player_id and are identity-agnostic. Binding is **non-destructive**:

- `players` carries a self-FK `merged_into_player_id` and is itself soft-deletable.
- A view `effective_players` resolves any merged player_id to its canonical row. All stats reads go through `effective_players`; session-detail reads read raw `players` so the original guest name ("Jack") still appears on the night it was logged but credit accrues to the canonical player for aggregation.

Two trigger paths share this one mechanism in v1; a third arrives post-v1:

- **Admin-driven merge during group-join approval (v1 primary, §6.1).** User redeems an invite code (or post-v1, requests to join). Admin reviews the join request, recognizes the new account as someone they know, optionally selects unlinked guest players to merge in via a search UI, and approves. The merge happens atomically inside the approval RPC. This is the path features.md decision 1 anticipated, now integrated with the admission flow rather than separated from it.
- **Admin-direct merge (v1 cleanup, §6.1 closing note).** Admin proactively merges later — for guests that surface after the user is already in the group (an old session restored, a guest record missed at approval time). Same RPC body, different trigger.
- **Auto-claim by user (D3, post-v1).** Same RPC, automatically triggered when a user signs in and an unambiguous email match exists.

Unmerge is supported via an `admin_unmerge_player(player_id)` RPC that consults `audit_log` to restore prior state. A 7-day undo window is the recommended default.

### 4.2 Group join requests

One request table sits in front of group admission. It is used for both invite-code redemption (v1) and post-v1 discovery. Full column list lives in the per-component data-model doc (TBD).

**`group_join_requests`** (created by user action, decided by group admin):

- States: `pending → approved | rejected | withdrawn`.
- One open `pending` request per (group, user) — partial unique index.
- `created_via`: `invite_code` (v1) or `discovery` (post-v1) — captures provenance for audit + later analytics.
- RPC-level guard rejects creation if the user already has a live `group_members` row in the target group.
- **Approval is the merge point.** `admin_approve_join_request(request_id, guest_player_ids_to_merge[])` runs atomically: creates the `group_members` row AND merges any selected guest players into the new user's canonical `players` row, in one transaction. The merge writes to `audit_log` per merged guest for unmerge support. Selecting zero guests is the common case (most new joiners have no prior history in the group).
- **Rejection** with optional `decided_note` for the requester to read.

A standalone admin merge (`admin_merge_players`) remains available for cleanup after the user is already in the group — see §4.1.

### 4.3 Multi-season membership

A session belongs to one group and to **zero or more** seasons within that group via `session_seasons`. A common case is one annual season plus a special (e.g. "2026" and "high roller christmas"); these may overlap in time.

Season membership is **explicit per-session**, not derived from date-range overlap. Date-range derivation would silently shift stats every time a season's dates were edited or a session was back-dated; explicit rows survive those edits cleanly. The create-session form pre-checks every season whose `[starts_on, ends_on]` interval contains `played_on` — the host can uncheck or add. A retroactive admin action `season_backfill_by_date_range(season_id)` covers the "new season created mid-quarter, attach all earlier sessions" case.

Cross-group integrity is enforced at the DB: `session_seasons` denormalizes `group_id` and composite FKs guarantee that a session and its attached seasons share the same group. Trigger-only enforcement was rejected as race-prone on bulk inserts.

**Aggregation rules (critical to avoid double-counting):**

- **Season P/L (B7) and season leaderboards** aggregate over `session_seasons` joined to `sessions` — a session in two seasons contributes to both season totals (this is desired).
- **Lifetime P/L (B8), group-wide leaderboards (B9), and per-session summaries (B10)** aggregate over `sessions` directly within `group_id` — a session is counted **once** regardless of how many seasons it belongs to. A pgTAP test pins this invariant.

> *Note: this generalizes features.md C7, which currently constrains a session to exactly one season. The relaxation is forward-compatible — a one-season-per-session group still works by inserting a single `session_seasons` row.* See [Appendix C](#appendix-c-spec-contradictions-flagged).

### 4.4 P/L vs. settlement-net

The prototype's `calcNets` returns one combined cash-flow figure that drives the A12/A13 end-of-night settlement output. The prototype has no stats surface, so the formula has never been wrong *in context*. v2 introduces stats, and stats require a different formula. The two are split explicitly:

- **`pnl_per_player_per_session = cashout_chips × rate − sum(buyin_chips) × rate`.** Used by every leaderboard, every season roll-up, every personal P/L view (B7–B10, D8). **Both `dinner_share` and `dinner_paid` are excluded from P/L** — dinner is real-world bookkeeping, not poker performance.
- **`settlement_amount = pnl − dinner_share + dinner_paid`.** Used only by the end-of-night transfer list (A12, A13). After family aggregation (A4 → `aggregateForSettlement`) and greedy minimization, this produces the suggested transfers the host announces at the table.

Both derivations are pure functions over the same raw rows; no schema change is needed. The split happens at the read/derivation layer. Every v2 consumer of the existing `calcNets` must be re-pointed deliberately to one of the two new functions — a grep-and-rename would silently keep dinner contamination in stats.

> *features.md A12 currently writes the settlement formula as if it were the P/L formula. See [Appendix C](#appendix-c-spec-contradictions-flagged).*
 
### 4.5 Invariants

- `buyins.chips` and `cashouts.chips` are chips, never money. Money is always derived from `sessions.chip_count` / `sessions.chip_money` at read time.
- A `players.linked_user_id` is unique within a group — enforced by a partial unique index where `linked_user_id IS NOT NULL`.
- `merged_into_player_id` chains terminate in one hop: the merge target must itself be canonical (`merged_into_player_id IS NULL`). Enforced by check or by the merge RPC.
- `seasons.group_id = sessions.group_id` for every `session_seasons` row, enforced by composite FK on the denormalized `group_id` column (see §4.3).
- `family_members.player_id` must reference a player who has a `session_players` row in the same session. Enforced by composite FK via a denormalized `session_id` on `family_members`.
- `families` and `family_members` are inputs to `aggregateForSettlement` only. No view that reports per-player P/L joins through them. A family-level P/L view is intentionally not provided in v1.
- **Lifetime P/L (B8) and group-wide stats (B9, B10) aggregate `sessions` directly within `group_id` — never via `session_seasons`.** Only season-bucketed stats (B7) aggregate through `session_seasons`. This prevents double-counting multi-season sessions.
- `sessions.status ∈ {draft, settled}`. Legal transitions: `draft → settled` (host settles the night), `settled → draft` (host re-opens to edit), and back. The auto-refresh trigger fires on `OLD.status != 'settled' AND NEW.status = 'settled'`, so re-settling after an edit fires once and idempotent no-op writes do not.
- `sessions.status = settled` does not freeze the row at the DB level. The freeze is *semantic*: stats reads ignore raw changes until a refresh runs (§7.1). This preserves B5/B6 edit capability while keeping stats stable.
- Soft delete: rows with `deleted_at IS NOT NULL` are invisible to default queries. Every soft-delete-supporting table has a `live_*` view; every RLS policy reads through the view (or carries a `deleted_at IS NULL` predicate). Enforced by a per-table pgTAP test that asserts soft-deleted rows are unreadable under every role.
- **Group ownership is non-orphanable.** A live group always has at least one `group_members` row with `role = 'owner'` and `left_at IS NULL`. The sole owner cannot leave; the leave-group RPC rejects with "transfer ownership or invite a co-owner first." Enforced at the RPC layer + a pgTAP test that attempts the orphan path under every role.
- **Session creation requires host eligibility.** A new `sessions` row may only be inserted when the acting user's `group_members.role IN ('owner', 'admin', 'host')` for that group. `member` is play-only — they may be added to a session by an eligible creator but cannot start one. New joiners default to `member`; only the `owner` promotes to `host` or `admin`. Enforced by an RLS predicate on `sessions` INSERT plus a pgTAP test per role.
- **Single timezone per group.** `groups.time_zone` (IANA) is the canonical interpretation surface for `sessions.played_on` (a date) and `seasons.starts_on`/`ends_on` (dates). The product assumes one physical game at a time per group at a single location; cross-zone "remote play" is out of scope. The column defaults to the group creator's timezone on create; editable by `owner`. Stats date-bucketing reads through this column, not the viewer's local time.

---

## 5. Sync, offline, and write semantics

The host is on a phone in a basement on flaky LTE. The architecture must not lose the night's data — principle 1 ("night-of usability is sacred") makes write availability for the live session non-negotiable. Concurrent multi-editor is a non-goal — principle 5 ("sharing is read-mostly") means one host owns the log for that night.

**Selected: server-authoritative + optimistic UI + on-device mutation queue.** Alternatives considered are in [Appendix A.2](#a2-sync-semantics).

Each mutation applies to a local in-memory store immediately and lands in a persistent queue (expo-sqlite-backed). A background worker flushes the queue on reconnect. Each mutation carries a client-generated `mutation_id`; the server dedupes on it. Reads fall back to a cached snapshot when offline.

Mutation envelope: `{mutation_id, entity, op, payload, created_at}`. ~200 lines of TypeScript. Idempotent by `mutation_id`. If collaborative editing ever becomes a real need, the queue can be replaced with PowerSync or Electric without a schema change.

Realtime (Supabase websockets) is used selectively for the *spectator* view — a non-host group member opening tonight's session sees updates pushed as the host writes — but is not the mechanism for write reliability. Writes go through the queue; realtime is a presentation enhancement.

---

## 6. Auth & permissions

### Provider

**Selected: Supabase Auth (GoTrue) with Google + Apple + email magic-link.** Apple Sign-In is mandatory for App Store apps that ship third-party social login (a store policy, not a preference). The spec's mention of "Instagram" in principle 2 is illustrative; Instagram OAuth is business-account-oriented and unsuitable here. Alternatives considered are in [Appendix A.3](#a3-auth-provider).

### Permission enforcement

**Selected: Postgres RLS.** The D6 matrix is naturally a set of predicates over `group_members.role`, the linked player record of `sessions.host_player_id`, and `auth.uid()`. RLS expresses these declaratively; tests against the policies live alongside the schema (see §9). Sketched matrix:

| Action | Authorized roles |
|---|---|
| Read a group's sessions, players, stats | Any live `group_members` row in the group |
| Create a session | Group `owner`, `admin`, or `host` (not `member` — see §4.5 invariant) |
| Edit / soft-delete a session (B5/B6) | Group `owner`/`admin` OR the host who ran the night (linked user of `host_player_id`) (decision 2) |
| Promote/demote between `admin`, `host`, `member` | `owner` only |
| Hard-edit other group settings | `owner` only |
| Flip `groups.discoverability` or `groups.join_policy` | `owner` only |
| Redeem an invite code | Any authenticated user; RPC creates a `group_join_requests` row (status `pending`), not a `group_members` row |
| Create `group_join_requests` via discovery (post-v1) | Any authenticated user, on a `discoverability != private` group |
| Approve a join request (with optional guest-merge) | `owner`/`admin` via `admin_approve_join_request` SECURITY DEFINER RPC; merge happens atomically with admission |
| Reject a join request | `owner`/`admin` |
| Withdraw a join request | Requester, while `status = pending` |
| Read own `group_join_requests` (including `decided_note`) | Requester |
| Read pending join requests for the group | `owner`/`admin` |
| Run admin-direct `admin_merge_players` (post-admission cleanup) | `owner`/`admin` |
| Run `admin_unmerge_player`, `season_backfill_by_date_range` | `owner`/`admin` |
| Run B11 refresh | Any group member |
| Read `audit_log` for own actions | Self |
| Read `audit_log` for the group | `owner`/`admin` |
| Leave a group (C9) | Self, **provided the user is not the sole live `owner`**. The leave RPC rejects with "transfer ownership or invite a co-owner first" otherwise (see §4.5 invariant). |

Additional rows for `seasons`, `families`, `buyins`, `dinners`, `dinner_shares`, `cashouts`, `session_players`, transferring ownership, and rotating `groups.invite_code` follow the same shape (host + admin write; member read; owner-only for ownership transfer and invite rotation) and are exhaustively enumerated in the RLS component design doc.

D7 (group-wide visibility) and D8 (personal roll-up) are expressed as views:

- `v_group_member_pnl` exposes every group member's P/L to every group member.
- `v_my_pnl_personal` filters to `players.linked_user_id = auth.uid()` across all groups the caller belongs to.

There is no cross-group leaderboard table or view — by construction, no path returns rows that mix groups except for the authenticated user's own data.

### 6.1 Invite-driven join + admin-merge flow (v1 primary path)

When a new user signs in and redeems an invite code, the `redeem_invite` RPC creates a `group_join_requests` row with `status = 'pending'` and `created_via = 'invite_code'`. **No `group_members` row is created yet, and the user is not asked to pick any guest records.** The user lands on a "waiting for admin review" screen and can continue to use the rest of the app (other groups they're in, their own profile) while they wait.

Group owners/admins see a "Pending join requests" queue in the native app. Each request renders the new user's profile (display name, email, when they redeemed) alongside a **search-and-pick** UI for unlinked guest players in the group: the admin types a name (or browses recent sessions) and ticks zero or more guests they recognize as the new user's prior identity in the group. The admin is the one making the call because the admin knows the group's history; the user typically doesn't.

The admin's decision options:

- **Approve.** `admin_approve_join_request(request_id, guest_player_ids_to_merge[])` runs atomically: creates the `group_members` row (default `role = 'member'`), runs `admin_merge_players` for each selected guest, writes `audit_log` rows for the admission and each merge. The new user transitions from "waiting" to "in the group" on next sign-in (or push, post-v1).
- **Approve with no merge** — the common case for first-time joiners with no prior session history in the group.
- **Reject** with an optional `decided_note`.

A standalone admin-direct merge (`admin_merge_players`) remains available *after* the user is in the group — for guest records that surface later (an old session restored, a guest not noticed at approval time). It runs the same `admin_merge_players` body and writes the same `audit_log` rows.

**Why admin-driven, not user-driven.** The admin knows who the new account is — they're the one who issued the invite (or recognized the user in a discovery request). They also know the group's history of "Jack" / "J.W." / "JackW". Asking the new user "which of these names was you?" puts the cognitive load on the wrong person, and a wrong tick is destructive. The search UI lives on the admin's side so the person with context makes the call, in the same flow as the approval they were already going to make.

**Notification.** The requester sees the decision via an in-app indicator (badge on the group tile + a "Recent activity" entry) on next sign-in. They can read their own `group_join_requests` row including `decided_note` via RLS. Push notifications are post-v1 (Phase 5).

### 6.2 Forward-compatibility with public signup, discovery, and join requests

Invite-only is the v1 surface; the data layer is built so opening discovery and public signup is purely additive.

Three independent dimensions are parameterized from day one:

1. **Public sign-up CTA exposure.** Supabase Auth already accepts any new authenticated user (Google, Apple, email magic-link); v1 simply hides the sign-up CTA outside the invite-redemption flow. Adding a public sign-up screen requires no schema change.
2. **Group discoverability** is per-group (`groups.discoverability`). Values: `private` (invite code only, invisible) / `link_only` (a shareable group URL works, no directory) / `listed` (appears in a directory). V1 ships only `private`; the others activate when the directory UI ships.
3. **Group entry policy** is per-group (`groups.join_policy`). Values: `invite_only` / `request_to_join`. V1 ships only `invite_only`; `request_to_join` activates with the directory.

Decision 7 ("no discovery, no public profiles") is preserved by construction: **users are never discoverable**; only *groups* can opt in, and only when their owner explicitly flips `discoverability` away from `private`. The "no public profiles" rule applies to people; a post-v1 directory lists groups (name + optional public note + size).

Both invite-code and discovery paths converge on the same `group_join_requests` mechanism (§4.2, §6.1). Only the trigger differs: `redeem_invite` for v1 invite codes, a discovery-flow RPC for post-v1 directory submissions. The admin's approval UI — including the search-and-pick merge picker — is identical for both.

---

## 7. Stats pipeline

Volume estimate: 12 players × 50 sessions/year × tens of groups ≈ thousands of session-player rows per year. Trivial for Postgres.

**Selected: `stats_snapshots` JSONB cache refreshed by `refresh_stats_snapshots(group_id, season_id default null)`.** Alternatives considered are in [Appendix A.4](#a4-stats-pipeline).

Matches B11 semantics exactly: stats are a derived artifact, explicitly recomputed or auto-rebuilt on a well-defined event, with a visible `computed_at` timestamp. JSONB payload version field lets us change leaderboard shape without a destructive migration. Session-detail screens read P/L *live* from raw rows (B5 edits surface immediately on the session page); only group-/season-level leaderboards are snapshot-driven.

### 7.1 Refresh triggers

`stats_snapshots` is refreshed by the single RPC `refresh_stats_snapshots(group_id, season_id default null)` under four conditions:

1. **Auto, on session settlement.** A trigger on `sessions` fires when `status` transitions to `settled` (`OLD.status != 'settled' AND NEW.status = 'settled'`). The trigger inserts a row into the `pending_stat_refresh` coalescing queue for the group and for every season attached via `session_seasons`. A cron Edge Function drains the queue every minute; a partial unique index on the queue (where `processed_at IS NULL`) provides the coalescing.
2. **Auto, on session resurrection / edit-then-resettle.** Same trigger fires when a previously-settled session is un-deleted or has `status` cycle through `settled → draft → settled` after an edit. The host's "re-settle" tap is the explicit republish signal.
3. **Auto, on season-membership change.** A trigger on `session_seasons` INSERT/DELETE enqueues a refresh for the affected `(group_id, season_id)` so `season_backfill_by_date_range` and manual season-attach UIs do not silently leave a season's leaderboard stale.
4. **Manual, on edit-without-resettle.** Per B11 and product decision 6, edits or soft-deletes of an already-settled session that leave `status = settled` do **not** auto-refresh. A user-visible "Sessions edited since last refresh: N" indicator on the group page nudges the user to either re-settle (#2) or invoke B11. This preserves "settled is fixed for stats" semantics while letting the host signal "and this edit changes stats too" by tapping re-settle.

Summary: settlement (and re-settlement) publishes stats automatically; pure post-settlement edits require an explicit republish.

---

## 8. Technology choices

Concrete stack:

| Layer | Choice | Why |
|---|---|---|
| Client framework | **Expo (managed) + React Native + Expo Router + TypeScript** | One codebase → iOS, Android, web. File-based routing. Solo-dev friendly. |
| Web target | **Expo Web** (static export → Vercel) | Same codebase, same screens; desktop convenience surface (§3.1). |
| Per-platform routing | **Expo Router — shared routes by default**; `.native.tsx` / `.web.tsx` suffixes reserved for narrow API divergences (push, camera) | No per-platform UX split; one nav, one screen set, both targets render the same UI. |
| Server cache + mutations | **TanStack Query + Zustand** | TanStack handles optimistic updates + retries; Zustand for transient UI state. |
| Offline storage | **expo-sqlite** (queue + cache) + **MMKV** (small KV) | Real local DB for the mutation queue + cached snapshots. |
| Styling | **NativeWind (Tailwind for RN)** + RN primitives | Utility-first ports cleanly across native and web. |
| Auth integration | **Supabase JS SDK + Expo AuthSession** | OAuth handoff works the same way on iOS, Android, web. |
| Build & distribution | **EAS Build + EAS Submit + EAS Update** | Code signing, store submission, OTA updates managed. |
| Backend | **Supabase** (Postgres + GoTrue + PostgREST + Realtime + Edge Functions) | See §3. |
| Database | **Postgres 15+** | Owned via Supabase. |
| Web hosting | **Vercel** | Best Expo Web + Sentry integration polish. |
| DNS | **Cloudflare** | Free, fast. |
| IDs | **UUIDv7 client-side** | Sortable + offline-safe. |

Alternatives per row are in [Appendix A.5](#a5-tech-choice-alternatives).

---

## 9. Testing strategy

The current Playwright suite at [app/tests/integration/](../../app/tests/integration/) is the regression contract. Every scenario it covers — master journey, pot rebalance, families, equal/custom dinner splits, persistence — continues to pass on the v2 web target.

Layers:

- **Unit (vitest).** Calc modules port from JS to TypeScript with minimal annotation. Pure functions cover `pnl_per_player_per_session`, `settlement_amount`, family aggregation, greedy minimization, chip-math, dinner-share computation. Property tests (`fast-check`) for two invariants: settle-to-zero (settlement transfers net to zero or to the pot rebalance total) and dinner-out-of-pnl (P/L equals cashout × rate − buyin × rate regardless of dinner data).
- **RLS policy tests (pgTAP or `supabase test db`).** Highest-leverage layer. Every D6/D7 policy + the `group_join_requests` policies gets a test: "a `member` cannot soft-delete a session"; "a `member` cannot create a session (host-eligibility gate)"; "an `admin` can edit any session in the group"; "a user in group A cannot read group B's sessions"; "a guest player is invisible to a non-member of its group"; "an outsider cannot read another user's pending join request"; "approving a join request with a guest already merged into someone else fails atomically (no partial admission)."
- **Component / store tests.** React Native Testing Library + MSW for mocked Supabase responses. Verifies optimistic mutations, queue flush, retry behavior.
- **Web E2E (Playwright).** Port existing scenarios against Expo Web. New scenarios: group create, invite redeem (creates pending join request) + admin approval with optional guest-merge, session list, B11 refresh, B5 edit + stale-stats indicator, season backfill.
- **Native E2E (Maestro).** Recommended over Detox — YAML flows, no native build coupling, cleaner CI. Same scenario library on iOS/Android. Cover the live-session six-tab flow, offline-then-online queue flush, and the admin approval queue (all admin work is native — §3.1).
- **Migration smoke tests.** Every PR: `supabase db reset` against the staging schema, run a seed script, verify a small read against each table.

---

## 10. Monitoring & observability

V1 must-haves (each is free or near-free):

- **Sentry** — frontend + backend errors and performance traces. Tag every event with the `mutation_id` and `session_id` so a failed sync surfaces with the offending mutation attached.
- **Supabase dashboard** — built-in DB metrics, slow-query log, auth events.
- **Better Stack** (or **Cronitor**) — uptime ping against the web target and a `/health` Edge Function.
- **Billing alerts** — Supabase, Vercel, Sentry, EAS each configured to email at 50% of free-tier consumption.

Four alert classes wake the dev:

1. Web target down >2 min.
2. Supabase prod DB CPU >80% sustained.
3. Sentry error rate >3× baseline.
4. Auth provider error rate >5%.

Everything else is a morning-coffee email.

Post-v1 (not v1): Sentry session replay (privacy-masked — money is sensitive), structured log aggregation (Logflare or Axiom for Edge Function logs), synthetic Playwright runs hourly against prod, EAS Update rollout health.

---

## 11. Production setup

- **Environments.** Three separate Supabase projects: `local` (Supabase CLI + Expo Dev Client), `staging` (Supabase project + Vercel preview branch tied to `main`), `prod` (separate Supabase project + Vercel production). Three projects rather than branch-based DB switching — an RLS bug in staging must not be one env-var away from prod.
- **EAS profiles.** `development`, `preview`, `production`, each pointing at its matching Supabase project and Sentry project. **EAS Update channels** per profile so an OTA update never crosses environments.
- **Secrets.** Vercel env vars (web), Supabase service-role keys (server-only, never on client), EAS Secret (native build-time). One `.env.example` at the repo root enumerates required vars. No secret is committed.
- **Migrations.** Supabase migration files (`supabase/migrations/*.sql`) in git. CI applies to staging on merge to `main`; tags promote to prod. Every migration is backward-compatible for one release (add nullable, backfill, then enforce) — true forward-only migrations enable safe rollback of *code* while *data* stays valid.
- **Preview deploys.** Vercel preview per PR for web; EAS Update preview channel per PR for native. Playwright runs against the web preview.
- **Rollback.**
  - Web: one-click Vercel revert.
  - Native binary: previous TestFlight build (iOS) / Play Store rollback (Android).
  - OTA JS: roll the EAS Update channel pointer to the last good update.
  - DB: forward-fix migrations. True reversal is not attempted on prod data; PITR (§12) covers catastrophe.
- **Domain & SSL.** Cloudflare DNS → Vercel-managed cert. Apex + `app.` subdomain.

---

## 12. Operations

- **Backups.** Supabase Pro PITR (7-day window) for prod. Weekly logical dump to Backblaze B2 (S3-compatible) via a cron Edge Function. Quarterly restore drill.
- **Retention.** `audit_log` is append-only and dominates storage at scale, so it runs on a tiered policy:
  - **Raw rows: 55-day retention.** A daily cron Edge Function deletes `audit_log` rows older than 55 days. PITR's 7-day window stays inside this, so a recent-incident restore always has raw audit available.
  - **Monthly aggregates: up to 12 months.** A monthly cron Edge Function rolls older raw rows into a separate `audit_log_monthly` table — one row per (group, entity, action, month) with counts and actor sets. Aggregates older than 12 months are dropped.
  - **What this preserves:** the destructive-flow runbooks (lost session edit, mis-merged guest, invite-code leak — §12) all act within the 55-day raw window. The 12-month aggregate is for usage/audit reporting, not for replay.
  - **What this drops:** detailed unmerge / un-edit replays beyond 55 days. Document this constraint in the admin-tooling component doc so a user with a 6-month-old complaint gets the right expectation.
- **Runbooks.**
  - *Lost session edit.* Query `audit_log` for the affected `session_id`; replay the `before` payload via an admin RPC. Admin tool only, not a UI feature.
  - *Mis-merged guest.* `audit_log` retains pre-merge state; `admin_unmerge_player(player_id)` clears `merged_into_player_id` and `deleted_at` on the guest row. Re-trigger refresh after.
  - *Stale leaderboard.* User re-triggers B11; if still wrong, inspect `stats_snapshots.payload` vs. live view output.
  - *Invite-code leak.* Rotate `groups.invite_code` — old code stops working immediately. Notify the group owner.
  - *Stuck stat refresh.* Inspect `pending_stat_refresh` for unprocessed rows; the drain function logs failures to Sentry.
- **Cost ceiling (v1, conservative).**
  - Supabase: free → $25/mo when the free tier is outgrown (~500MB DB, ~50k MAU).
  - Vercel: hobby/free.
  - Sentry: free tier.
  - Cloudflare: free.
  - EAS: free tier (30 builds/mo).
  - Maestro Cloud: free tier.
  - **Apple Developer: $99/year** (mandatory for App Store distribution).
  - **Google Play: $25 one-time** registration.
  - Domain: ~$15/year.
  - **Realistic v1 monthly: $0–25.** **Fixed first-year: ~$124.**
- **Scaling triggers.** Move off Supabase free tier at 80% of the limit. Add a read replica if leaderboard refresh ever exceeds 2s (it won't at this scale). Revisit local-first sync if user complaints about offline writes ever materialize.

---

## 13. What we preserve from the prototype

- **Calc logic.** [app/src/calc/chip-math.js](../../app/src/calc/chip-math.js) and [app/src/calc/settlement.js](../../app/src/calc/settlement.js) port to TypeScript with no logic change. They run on React Native because they are pure functions. **Note:** the existing `calcNets` returns a combined cash-flow figure used to drive A12/A13 settlement output; v2 separates this into `pnl_per_player` (stats; no dinner) and `settlement_amount` (transfer list; includes dinner) per §4.4. No business-logic change beyond splitting the return shape.
- **Pot rebalance rule.** `scaleFactor = totalBuyinChips / totalCashoutChips` when all players have cashed out and totals diverge.
- **Buy-ins in chips, dinner in money.** The canonical-units split moves verbatim into the schema.
- **Family-aware settlement.** Family aggregation is applied inside `aggregateForSettlement` immediately before greedy two-pointer minimization. P/L calculation remains per-player; family aggregation is the last transform on settlement output.
- **Six-tab UX.** Setup, Players, Buy-ins, Dinner, Cash Out, Settle — the session-detail screen in v2 *is* this six-tab view. Tab badges (A15) carry over. This is the native-emphasized screen per §3.1.
- **Existing Playwright scenarios.** The regression contract for the web target.

---

## 14. Risks and open questions

1. **EAS Update governance.** OTA JS updates bypass store review for non-native changes but must respect store policies. A short release checklist is mandatory.
2. **App Store review lead time.** First submission is 1–3 days; plan v1 launch around this.
3. **Expo Web compatibility shims.** Some RN libraries don't render on web. Commit to a web-compatible shortlist (NativeWind, expo-router, react-native-svg, react-native-gesture-handler) early; reject anything that can't render on web.
4. **Approval-time merge is the highest-stakes destructive flow.** During join approval the admin ticks guest records to merge into the new user; a mistaken tick collapses two different people's history into one account. `audit_log` retention + `admin_unmerge_player` RPC + a 7-day undo window are mandatory. Confirm undo window before ship.
5. **B5 edits-without-resettle invalidate snapshots silently.** §7.1 auto-refreshes on settle and on re-settle, but a pure post-settlement edit (B5 without a status cycle) does not auto-publish. The "Sessions edited since last refresh: N" indicator on the group page nudges the host to either re-settle the affected session or invoke B11 manually. Without the indicator, users will trust stale leaderboards — treat as a launch blocker for Phase 3.
6. **D8 (personal cross-group roll-up) ships in raw money; "stakes vary" caveat renders conditionally.** V1 ships D8 as raw per-group P/L (each group displayed in its own currency, plus a simple total in the user's home currency if set). The "stakes vary across groups; raw P/L may not reflect true performance" caveat renders **only when the user's groups have non-identical `chip_count × chip_money` rates** — for groups at identical stakes the warning is noise. The features.md D8 stake-normalization formula remains "Open" and stays in Backlog; the schema requires no change to add it later.
7. **Soft-delete + RLS interaction.** Every policy needs a `deleted_at IS NULL` predicate or must read from a `live_*` view. Easy to forget; mitigate with a code convention and pgTAP coverage on every policy.
8. **Admin search-and-pick UI quality.** The admin's "which old guests are this new user?" decision is only as good as the search/scan affordances on the approval card. Show: guest name + last-played date + session count, with recency-weighted ordering and a typeahead. Default to no-merge (approve cleanly is one tap; merging is opt-in). Without good affordances, the admin will skip merges and leave duplicates in leaderboards — the very thing this flow exists to prevent.
9. **Season-membership backfill.** Explicit season membership (§4.3) means a new "2026" season created mid-March looks empty for January–February sessions until the host runs `season_backfill_by_date_range`. The UI must surface this; otherwise the season appears mis-configured.
10. **Discoverability is a privacy escalator.** Flipping a group from `private` to `listed` (post-v1) should require an admin confirmation modal naming every consequence (the group's name + member count appear in a directory; join requests start arriving). V1 cannot ship the directory; v1 *can* ship the schema, but the admin UI hides the `listed` option until the directory launches.
11. **Claim-decision notification channel.** Without push (post-v1, Phase 5), a requester learns the admin's decision only on next sign-in. The in-app indicator (§6.1) is the v1 mechanism; the requester does not receive an email and does not get a real-time notification. **Accepted for v1** — the broken handshake is tolerable for a friends-of-friends audience. Adding push (Phase 5) closes the loop; no architectural change is needed beyond enabling expo-notifications + a Supabase Edge Function fan-out.
12. **Host-role assignment friction.** New joiners default to `member` (play-only). If an owner forgets to promote a returning regular to `host` before the next night, that user cannot start the session. Mitigations: surface a "Promote to host?" affordance on the join-approval card so the owner makes both decisions at once; on the session-create screen, render a clear "you are not host-eligible — ask the owner" message rather than a hidden disabled button; allow group invites to carry a default role hint (post-v1 enhancement). Track usage to confirm `member` vs `host` distribution matches PM intent.
13. **Invite-code redemption no longer auto-admits.** Under the new PM-confirmed flow, a valid invite code creates a `pending` `group_join_requests` row rather than a `group_members` row — the user waits for admin approval. For fast-responding admins (typical friends-of-friends) this is seconds to minutes; for slow admins it can be hours. Mitigations: a "Waiting for [admin name] to approve you" screen that explains the wait clearly; allow the user to keep using other groups they're already in; consider an opt-in email nudge to the admin via a Supabase Edge Function on request creation. Push notifications (Phase 5) close the loop; until then, the wait is visible but not pushed.

---

## 15. Phased rollout (architectural sequencing only)

Each phase is a few weeks of solo-dev work; an implementation plan partitions it further.

- **Phase 0 — Foundation.** Repo skeleton (Expo + TS), Supabase projects, auth flow, group create / `redeem_invite` RPC (creates pending `group_join_requests` row) / minimal admin approval action (single-button approve, no guest-merge UI — the full search-and-pick lands in Phase 4). Empty session shell, calc modules ported to TS (with the P/L vs settlement split, §4.4), CI green. Goal: a signed-in user can create a group, invite a friend, the friend redeems the invite, and the owner approves them into the group end-to-end.
- **Phase 1 — Session parity.** Full session screen (six tabs) writing to real DB. Buy-ins, dinners, cash-outs, families, settle. Offline write queue. The host's night-of experience matches the prototype, persistent. Goal: replace the prototype HTML for one friend group. **The Supabase API surface stabilizes here.**
- **Phase 2 — History + groups.** Session list, session detail read-only view (B3, B4), group settings with default rate/currency (C4), seasons (C5–C7) including `session_seasons` UI and `season_backfill_by_date_range`. Goal: "browse past nights" works.
- **Phase 3 — Stats + sharing + direct admin merge.** B7–B11 leaderboards via `stats_snapshots`, auto-refresh on settlement and on `session_seasons` change (§7.1), D5 participant read-only view, D7 group-wide visibility, D8 personal roll-up (raw money, conditional "stakes vary" message), "stats stale" indicator. Ships the **direct admin merge UI (D4)** so admins can clean up guest duplicates the moment leaderboards launch — otherwise Phase 3 leaderboards would show "Jack" / "J.W." / "JackW" as three rows for weeks. Goal: the success criteria in [overview.md](../spec/overview.md) ("who's up the most this season") works in one tap, and leaderboards are accurate at launch.
- **Phase 4 — Identity reconciliation polish.** Full join-approval queue (native) with the **search-and-pick guest-merge UI** described in §6.1: typeahead, recency-weighted ordering, session-count badges, side-by-side requester profile + candidate guests. Audit-log surfacing, B5 edit + B6 soft-delete UX with the "edited since refresh" indicator wired up, `admin_unmerge_player` UX. Role-management UI for promote/demote between `admin`, `host`, `member` (§6 matrix). Goal: a guest from session 1 can become a real account in session 20 and see their full history; admins have ergonomic tools for destructive flows; owners can designate who's host-eligible.
- **Phase 5 — Post-v1.** D3 auto-claim by email match (independent of the items below); `groups.discoverability = listed` + directory UI + `group_join_requests` flow (independent); F1–F4 settlement tracking + generic expenses (independent); D8 stake normalization (independent); opening up public signup if warranted (independent); native push notifications (independent). These ship as separate increments — any one can land without the others.

The architectural payoff for the Supabase-centric choice lands at Phase 1: the data layer and API surface are stable from that point on. Every phase after that layers features onto the same backend.

---

## Appendix A: Alternatives considered

The main doc shows only the selected path. This appendix preserves the alternatives evaluated during architecture design.

### A.1 Overall architecture

- **Alt A — Supabase-centric BaaS (selected).** Postgres + GoTrue auth + PostgREST + Realtime + Edge Functions + Storage, one vendor. RLS as policy engine. Vendor lock-in is real but the data layer is plain Postgres, so exit cost is low (logical dump → any Postgres provider).
- **Alt B — Firebase / Firestore.** Excellent offline SDK, mature auth, generous free tier. Schemaless aggregation is painful (leaderboards over joins are awkward); Firestore security rules are weaker than RLS for the multi-role D6 matrix; lock-in is harder to escape.
- **Alt C — Thin custom API + managed Postgres (Hono/Fastify on Fly/Render, Neon DB).** Maximum control, no policy DSL to learn. Solo-dev pays for every endpoint, every auth flow, every migration runner. Hostile to "minimal ops overhead."
- **Alt D — Local-first sync engine (PowerSync / ElectricSQL / Replicache).** Beautiful offline UX. Third moving part with its own failure modes, schema constraints, and bill. The data shape (single host writes a session, others read) does not need CRDT semantics.

### A.2 Sync semantics

- **Server-authoritative + optimistic UI + on-device mutation queue (selected).** Single-writer-per-session does not need CRDT machinery; ~200 lines of TS; idempotent envelopes; replaceable by Electric/PowerSync later without a schema change.
- **Full local-first (Replicache / PowerSync / ElectricSQL).** Strong UX, but pays a CRDT/sync-service tax for a problem that doesn't exist here.
- **Online-only autosave.** Simplest. Violates "night-of usability is sacred" the first time wifi drops.

### A.3 Auth provider

- **Supabase Auth (GoTrue) (selected).** Bundled with the DB, no extra vendor. Google + Apple + email magic-link cover D1.
- **Auth0.** More expensive, separate vendor, no integration win.
- **Clerk.** Polished but pricier; another bill and another dashboard.
- **Roll-your-own.** Rejected on principle 2 ("we never run our own password store").

### A.4 Stats pipeline

- **`stats_snapshots` JSONB cache (selected).** Matches B11 semantics; JSONB payload version field lets us evolve leaderboard shape without destructive migration; auto-rebuild on settle + manual on edit (§7.1).
- **Materialized views refreshed by B11.** Standard Postgres pattern, fast at this scale. Less ergonomic to evolve — schema changes require careful migration.
- **On-demand SQL on every page load.** Cheapest to build, but B11's "Refresh stats" becomes meaningless.

### A.5 Tech choice alternatives

| Layer | Selected | Alternatives |
|---|---|---|
| Client framework | Expo + React Native + Expo Router | Bare RN + Metro (more native control, more setup); Flutter (different language, different ecosystem); native Swift+Kotlin (two codebases, three with web). |
| Web target | Expo Web | Separate React+Vite codebase (defeats single-codebase win); Next.js with shared component library (more dependencies, more friction). |
| State + cache | TanStack Query + Zustand | Redux Toolkit (heavier); Jotai (atom-based, fine but TanStack covers more out of the box). |
| Offline storage | expo-sqlite + MMKV | AsyncStorage (slower, no SQL); Realm (powerful, overkill); WatermelonDB (sync-aware, ties us to a particular sync model). |
| Styling | NativeWind | StyleSheet (verbose); Tamagui (capable, larger surface to learn); react-native-paper (Material-themed, less aesthetic flexibility). |
| Build + distribution | EAS | Bare CI + Xcode/Gradle (solo-dev pays the signing/store-submit costs); Fastlane (works but more YAML to maintain). |
| Backend | Supabase | See [A.1](#a1-overall-architecture). |
| Web hosting | Vercel | Cloudflare Pages (cheaper at scale, weaker Expo integration); Netlify (fine but no integration win). |

---

## Appendix B: Doc relationships

- [TECHNICAL_DESIGN.md](../../TECHNICAL_DESIGN.md) — prototype snapshot. §7 (target data model sketch) and §8 (architecture options) are superseded by this doc; §1–§6, §9–§10 remain valid as a record of what exists today.
- [docs/spec/overview.md](../spec/overview.md) — product principles, scope, success criteria. This architecture serves those.
- [docs/spec/features.md](../spec/features.md) — feature catalog, V1 cut, product decisions. Every architectural choice cites a feature ID or decision number from this doc. Divergences are flagged in Appendix C.
- [docs/refactor-2026-05-11.md](../refactor-2026-05-11.md), [docs/productionization-2026-05-11.md](../productionization-2026-05-11.md) — historical: how the current prototype was modularized and deployed to GitHub Pages. The v2 architecture replaces the static-site deploy described there; the prototype-side claims ("no backend, no auth") apply to v1 only.

---

## Appendix C: Spec contradictions flagged

During architecture design, four points emerged where the user-confirmed v2 architecture diverges from text in [docs/spec/features.md](../spec/features.md). These are noted here so the chief architect can decide whether to update `features.md` in a separate pass. The architecture doc itself follows the v2 direction; none of these are blockers.

1. **C7 — "A session belongs to exactly one season."** The v2 architecture supports many-to-many session ↔ season via `session_seasons` (§4.3). C7 should generalize.
2. **A12 — "net = cash out − buyins − share + paid."** A12 as written describes the *settlement* formula. v2 separates `pnl` (no dinner) and `settlement_amount` (includes dinner) per §4.4. A12 should be re-worded as the settlement formula, with a new entry for P/L.
3. **Decision 7 — "no discovery, no public profiles."** v2 preserves "no public user profiles" exactly but supports per-group opt-in discoverability for the post-v1 directory (§6.2). Decision 7 should be tightened to apply specifically to people, not groups.
4. **C2 — "Invite people to a group via link or code (invite-only, no discovery)."** Same shape as decision 7 above and resolved by the same wording fix: invite + link are the v1 entry points; opt-in per-group discovery (`discoverability = listed` + `join_policy = request_to_join`) activates post-v1 without altering decision 7's spirit.
5. **C3 — "Group has owner, admins, and members. Member is a play-only role."** v2 introduces a fourth role tier `host` between `admin` and `member`. Hosts can create and edit their own sessions; members cannot create sessions (play-only). Motivation: product manager feedback that not every group member should be able to start a game. The hierarchy becomes `owner > admin > host > member`; new joiners default to `member` and the `owner` promotes. C3 should be reworded to enumerate the four roles.

**Resolved divergences** (previously listed; now aligned with the spec after the PM's admin-driven merge flow update — kept for traceability):

- *Decision 1 — "no user-initiated path in v1."* Earlier drafts of this doc allowed a user-side claim picker (hybrid of D3 + D4). The current architecture (§6.1) is fully admin-driven: the user redeems an invite and waits; the admin alone selects guest records during approval. This matches decision 1's intent exactly. No spec change required.

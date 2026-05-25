# Poker Night — Identity & Permissions Design

**Status:** Skeleton (to be filled in) · **Date:** 2026-05-17 · **Scope:** Auth provider integration, RLS matrix detail, guest-account binding mechanics, the group-join request flow with admin-driven merge at approval time, merge and unmerge RPCs, and forward-compat for public signup.

## Context

Identity in this product is dual-shaped from day one: every name-only player (D2) is a `players` row with `linked_user_id IS NULL`, and any of those rows may late-bind to a real account (D1) without losing history. The destructive write that performs that bind — `admin_merge_players` — is the highest-stakes operation in the system (risk #4) and reaches one mechanism through two v1 trigger paths plus one post-v1 path (top-level §4.1): **admin-driven merge during group-join approval** (v1 primary; admin recognizes the new account and selects unlinked guest records to merge as part of approving the join), admin-direct cleanup merge (v1 secondary; for guests that surface after admission), and auto-claim by email match (D3, post-v1). The non-trivial work: the D6 permission matrix expressed as predicates over `group_members.role` (now a four-tier hierarchy — `owner > admin > host > member`, see top-level Appendix C divergence 5), the linked user of `sessions.host_player_id`, and `auth.uid()`; the `group_join_requests` state machine where admission and merge happen atomically in one transaction; the session-creation host-eligibility gate; forward-compat for public signup and group discoverability (top-level §6.2) without violating decision 7's "no public profiles" rule.

## Goals

When complete, this doc will cover:

- Supabase Auth (GoTrue) configuration: Google, Apple (mandatory for App Store), email magic-link; redirect URLs per environment; session/refresh-token lifetime.
- The full D6 RLS matrix expanded row-by-row across the four-tier role hierarchy (`owner > admin > host > member`), including the rows top-level §6 sketches but does not enumerate (seasons, families, buyins, dinners, dinner_shares, cashouts, session_players, ownership transfer, invite-code rotation). Each row distinguishes what `host` can do that `member` cannot (create sessions; edit their own sessions) and what `admin` can do that `host` cannot (approve claims, run merges, rotate invites).
- The **host role** semantics: default for new joiners is `member` (play-only); only `owner` promotes between `admin`/`host`/`member` (demotion symmetric). The session-create RLS predicate (top-level §4.5 invariant) requires `role IN ('owner', 'admin', 'host')`. Promotion surface lives in the role-management screen (Phase 4, [frontend.md](frontend.md)).
- The `effective_players` view contract and the rule that all stats reads go through it while session-detail reads read raw `players`.
- The merge mechanism: how admin-driven approval-time merge, admin-direct cleanup merge, and (post-v1) auto-claim by email match all funnel into one `admin_merge_players(target_user_id, guest_player_ids[])` body. The approval-time variant wraps it in `admin_approve_join_request(request_id, guest_player_ids_to_merge[])` so admission and merge are one transaction.
- `group_join_requests` state machine: `pending → approved | rejected | withdrawn`, partial unique index `(group_id, requesting_user_id) WHERE status = 'pending'`, the `created_via` provenance column (`invite_code` vs `discovery`), decision-note surfacing back to requester. Approval is the atomic point where `group_members` is created AND selected merges run AND `audit_log` rows are written.
- `group_join_requests` state machine (post-v1 surface but v1 schema): `pending → approved | rejected | withdrawn`, RPC-level live-membership guard, the approval-routes-into-§6.1-onboarding rule.
- `admin_unmerge_player` semantics: audit-log-driven restore, 7-day undo window, what is and isn't recoverable beyond the 55-day raw-audit window (operations.md retention boundary).
- Admin search-and-pick UX rules during join approval (top-level §6.1, risk #8): typeahead on unlinked-guest names, recency-weighted ordering, session-count + last-played metadata per candidate row, default to no-merge so one-tap clean approval is the cheap path; the search-and-pick affordance is opt-in additional work. New users see no guest list at all — the picker is admin-only.
- Decision-feedback channel for claim outcomes: in-app indicator (badge + recent-activity entry) as the v1 mechanism, the explicit decision that push is post-v1 (risk #12).
- Forward-compat parameterization for public signup: `groups.discoverability` (`private` / `link_only` / `listed`), `groups.join_policy` (`invite_only` / `request_to_join`), the rule that v1 ships only `private` + `invite_only` and the directory UI hides the other values.
- The "users are never discoverable; only groups can opt in" guarantee and how it's enforced.
- Group-ownership invariants: non-orphanable owner, the leave-group RPC's owner-blocked behavior, ownership transfer flow.
- Auth test fixture *behavior contract* (one test user per role: owner, admin, host, member, guest-attached-to-member, signed-out): which scenarios each fixture is used in, and how OAuth provider shims represent each. The seed script that creates these fixtures lives in [db-backend.md](db-backend.md); the pgTAP RLS matrix that consumes them lives there too. This doc tells the seed *what to create* and the test layers *what to verify*.

## Scope

**In scope:**

- Auth provider configuration and the client-side OAuth handoff contract.
- The D6 permission matrix in full, including the rows the top-level only sketches.
- Every state machine and UX flow that touches identity: claim, join, merge, unmerge, leave, transfer, invite-redeem, invite-rotate.
- Forward-compat dimensions for opening discovery and public signup.

**Out of scope:**

- The DDL of the request tables and the actual RLS policy SQL — covered by [db-backend.md](db-backend.md); this doc specifies the *behavior* and the matrix, that doc realizes it in schema.
- The screens that render the "waiting for admin review" surface, the admin's join-approval queue with search-and-pick, leave-group confirmation, role-management — covered by [frontend.md](frontend.md); this doc owns the *flow*, that doc owns the *layout*.
- CI test fixture *implementation* (seed SQL, OAuth shim wiring) — covered by [db-backend.md](db-backend.md) (seed) and [frontend.md](frontend.md) (shim). This doc owns the *behavior contract* the fixtures must satisfy.
- Auth-provider outage response — covered by [operations.md](operations.md).
- Environment-specific OAuth client IDs and redirect URLs — covered by [productionization.md](productionization.md).

## Anchors in the top-level architecture

This doc operationalizes the following sections of [top-level-design.md](top-level-design.md):

- §4.1 — Guest → account binding mechanism.
- §4.2 — Claim-request and join-request state machines.
- §6 — Permission enforcement, the D6 matrix sketch.
- §6.1 — Invite-driven join + admin-merge flow.
- §6.2 — Forward-compatibility with public signup, discovery, and join requests.
- Risks #4, #8, #10, #11, #12, #13 — Approval-time merge as highest-stakes flow, admin search-and-pick UI quality, discoverability privacy escalator, decision-notification channel, host-role friction, invite-code wait time.
- Appendix C divergences 3, 4, 5 — Decision 7 tightening, C2 wording, C3 four-role hierarchy. The previously-flagged Decision-1 divergence is resolved by the PM-confirmed admin-driven merge flow and listed in the appendix's "Resolved divergences" note.

## Open questions to resolve

- Whether the 7-day undo window for `admin_unmerge_player` is enforced in SQL, in the RPC layer, or in the UI only (cross-ref operations.md).
- Whether ownership transfer requires the new owner's acceptance (two-step) or is a unilateral admin action.
- Whether group invites can carry a default role (e.g. invite-as-host) or whether everyone joins as `member` and is promoted later (risk #12 mitigation).
- Whether `admin` can promote other members to `host`, or whether only `owner` can change any role (current default is owner-only — confirm vs. operational friction).
- Exact `decided_note` length limit and whether rejection notes are mandatory or optional.
- Whether the auto-claim path (D3, post-v1) requires admin re-confirmation on first match, or executes silently on unambiguous email.
- Concrete fields shown on the admin's approval card (requester profile + which historical sessions display + which dates).
- Whether the directory UI (post-v1) requires owner re-affirmation each time `discoverability = listed` is selected (the privacy-escalator modal from risk #10).
- Whether email magic-link counts as a "social identity" for D1 framing or is treated as a third option in UX copy.

## References

- [docs/architecture/top-level-design.md](top-level-design.md) — top-level architecture
- [docs/spec/features.md](../spec/features.md) — feature catalog (D1–D8, decisions 1, 2, 7; C2, C3, C9; B5/B6 host-vs-admin edit)
- [docs/spec/overview.md](../spec/overview.md) — product principles (2 "account management is light", 5 "sharing is read-mostly")
- [db-backend.md](db-backend.md) — sibling: schema and policy realization
- [frontend.md](frontend.md) — sibling: the screens for the join-approval queue, "waiting" surface, role-management, leave flow
- [operations.md](operations.md) — sibling: undo windows, audit retention boundary, auth-outage runbook
- [productionization.md](productionization.md) — sibling: per-env OAuth config

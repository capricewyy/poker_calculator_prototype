# Poker Night — DB / Backend Design

**Status:** Skeleton (to be filled in) · **Date:** 2026-05-17 · **Scope:** Postgres schema, RLS policies, SECURITY DEFINER RPCs, triggers, and the Supabase backend surface.

## Context

The Supabase-centric BaaS is the single shared substrate for every client surface; this doc owns everything that lives inside that substrate. The non-trivial pressures are: a dual-shaped identity model where `players` (durable) and `users` (optional, late-binding) coexist permanently; immutability with a side door (settled sessions are stat-authoritative yet host-editable); a stats derivation that must never double-count multi-season sessions; soft-delete that must be enforced through every read path; and two layers of admin (group owner/admin plus session host) whose intersection must be expressible as policy. RLS is the policy engine — most authorization lives in declarative predicates, with SECURITY DEFINER RPCs reserved for the destructive flows (merge, unmerge, role transfer, invite redemption, claim/join approval). See [top-level-design.md](top-level-design.md) §4–§7.

## Goals

When complete, this doc will cover:

- Full DDL per entity in top-level §4 (`users`, `groups`, `group_members`, `seasons`, `session_seasons`, `players`, `sessions`, `session_players`, `buyins`, `dinners`, `dinner_shares`, `cashouts`, `families`, `family_members`, `group_join_requests`, `stats_snapshots`, `pending_stat_refresh`, `audit_log`). `group_members.role` is the four-tier enum `owner | admin | host | member` (Appendix C divergence 5).
- Exhaustive RLS policy per table (read, insert, update, soft-delete) derived from the D6 matrix in top-level §6, including the `live_*` view + `deleted_at IS NULL` convention. Includes the **session-create host-eligibility predicate** (`role IN ('owner', 'admin', 'host')` on `sessions` INSERT) per top-level §4.5 invariant.
- Composite-FK and denormalization mechanics enforcing cross-group integrity (`session_seasons.group_id`, `family_members.session_id`) and the invariants enumerated in top-level §4.5.
- All SECURITY DEFINER RPCs: `redeem_invite` (creates pending `group_join_requests` row), `admin_approve_join_request(request_id, guest_player_ids_to_merge[])` (atomic admission + optional merge), `admin_reject_join_request`, `admin_merge_players` (admin-direct post-admission cleanup), `admin_unmerge_player`, `season_backfill_by_date_range`, `refresh_stats_snapshots`, `leave_group`, `rotate_invite_code`, `transfer_ownership` — signatures, audit-log writes, error contract.
- Trigger surface: settle-transition trigger on `sessions`, `session_seasons` INSERT/DELETE trigger.
- The `pending_stat_refresh` coalescing queue: partial unique index, the drain Edge Function contract, and failure handling (B11, decision 6).
- View layer: `effective_players`, `live_*` per soft-deletable table, `v_group_member_pnl` (D7), `v_my_pnl_personal` (D8); the explicit non-existence of a cross-group leaderboard view.
- Migration conventions: backward-compat-for-one-release rule, file naming, applied-by-CI flow into staging/prod.
- pgTAP coverage matrix: every RLS row from the D6 matrix gets positive + negative tests across all four roles (`owner`, `admin`, `host`, `member`); every soft-delete-supporting table gets a visibility test; every `group_join_requests` state transition gets a race test, plus an **approval atomicity** test (admission + every selected merge succeed together or the whole transaction rolls back); the ownership-non-orphanable, host-required-for-session-create, multi-season-no-double-count, and dinner-out-of-pnl invariants each pin one test.
- Migration smoke procedure: `supabase db reset` against staging schema per PR, the shared seed script, a small read per table to confirm RLS policies don't blank-screen the app.
- Test-data conventions: factories, fixtures, the seed script that supports both migration smoke and local dev. Auth fixtures are produced by the seed but their *behavior contract* is defined in [identity-permissions.md](identity-permissions.md).
- The chips-vs-money invariant: where chips flow, where money is derived, and the rule that nothing joins through `families` to compute P/L.

## Scope

**In scope:**

- Schema, RLS policies, RPCs, triggers, views, indexes, pgTAP tests for the DB.
- Edge Functions whose only job is data-layer plumbing (cron-driven `pending_stat_refresh` drain, weekly logical backup dump, audit-log retention rollup).
- The data-layer half of the `group_join_requests` state machine, including the atomic approval-with-merge transaction.

**Out of scope:**

- Client-side query patterns, optimistic updates, offline queue — covered by [frontend.md](frontend.md).
- CI/CD wiring that applies migrations and EAS pipeline — covered by [productionization.md](productionization.md).
- Backup retention drills, runbooks, alerting on DB metrics — covered by [operations.md](operations.md).
- Client-side test layers (vitest, RNTL, Playwright, Maestro) — covered by [frontend.md](frontend.md); this doc owns the pgTAP layer and migration smoke.
- CI test orchestration and merge gates — covered by [productionization.md](productionization.md).
- Auth provider configuration, OAuth handoff, the user-facing claim/join flows — covered by [identity-permissions.md](identity-permissions.md); this doc owns the underlying tables, RPCs, and policies they invoke.

## Anchors in the top-level architecture

This doc operationalizes the following sections of [top-level-design.md](top-level-design.md):

- §4 — Data model (entities, 4.1 binding, 4.2 request tables, 4.3 multi-season, 4.4 P/L vs settlement, 4.5 invariants).
- §6 — Permission enforcement matrix (the RLS surface).
- §7.1 — Refresh triggers and the `pending_stat_refresh` queue.
- §13 — Calc port: where pure derivations live in DB views vs. in the client calc module.
- Appendix A.1 / A.4 — Supabase-centric BaaS and `stats_snapshots` JSONB-cache choices.
- Appendix C divergences 1 (C7 multi-season relaxation), 2 (A12 P/L vs settlement formula split), and 5 (C3 four-role hierarchy with `host` tier) — all operationalized in this doc's eventual schema and RLS content.

## Open questions to resolve

- Exact JSONB shape and `version` field for `stats_snapshots.payload` — how does a shape change avoid a destructive migration?
- Concrete `audit_log` row shape (per-action payload schema): one row per logical action vs. before/after pair per affected row.
- Whether `admin_unmerge_player` enforces the recommended 7-day undo window in SQL or expects the client to gate it (risk #4).
- Whether RPC error contracts use Postgres error codes, structured JSON, or both — affects client error UX.
- Whether `refresh_stats_snapshots` runs idempotently per `(group, season)` or also accepts a session-id batch hint from the queue.
- Final naming + signature for the `effective_players` view and whether stats reads enforce it via search_path or explicit join.

## References

- [docs/architecture/top-level-design.md](top-level-design.md) — top-level architecture
- [docs/spec/features.md](../spec/features.md) — feature catalog (B1–B11, C-series, D4, D6–D8, decisions 1, 2, 6, 7)
- [docs/spec/overview.md](../spec/overview.md) — product principles (4 "history is permanent", 5 "sharing is read-mostly")
- [frontend.md](frontend.md) — client-side data access patterns
- [identity-permissions.md](identity-permissions.md) — claim / join / merge flows from the user side
- [TECHNICAL_DESIGN.md](../../TECHNICAL_DESIGN.md) §7 — prototype's data-model sketch (superseded by §4)

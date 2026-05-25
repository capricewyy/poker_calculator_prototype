# Poker Night — Merged Execution Tasks

Merged from [docs/architecture/db-backend.md](docs/architecture/db-backend.md) §14 and [docs/architecture/identity-permissions.md](docs/architecture/identity-permissions.md) §16. Phases align with [docs/architecture/top-level-design.md](docs/architecture/top-level-design.md) §15.

**Legend**
- 🟦 **Code** — repo change (migration, RPC, view, test, Edge Function, client code)
- 🟪 **Platform** — config in an external service dashboard or CLI against a hosted resource
- 🟧 **Manual** — one-off human decision, paid signup, or in-app smoke test
- → **deps:** task IDs that must complete first

---

## 0. Pre-requisites (do once, before Phase 0)

### 0.1 Local CLI tools

| ID | Type | Task | Notes |
|---|---|---|---|
| P0.1.1 | 🟧 | Install Homebrew (macOS) | `https://brew.sh/`. Skip if already installed. |
| P0.1.2 | 🟧 | Install Node ≥ 20 + npm | `brew install node` or volta/nvm. Required by Supabase CLI + Expo. |
| P0.1.3 | 🟧 | Install Supabase CLI | `brew install supabase/tap/supabase`. Verify: `supabase --version`. |
| P0.1.4 | 🟧 | Install Docker Desktop | Needed by `supabase start` (local Postgres + GoTrue). |
| P0.1.5 | 🟧 | Install GitHub CLI | `brew install gh`. Login: `gh auth login`. |
| P0.1.6 | 🟧 | Install Expo CLI / EAS CLI | `npm i -g expo eas-cli`. Required from Phase 0 PR-0.1 onward. |
| P0.1.7 | 🟧 | Install Deno (for Edge Functions local dev) | `brew install deno`. Used by `supabase functions serve`. |

### 0.2 Platform accounts / signups

| ID | Type | Task | Cost | Notes |
|---|---|---|---|---|
| P0.2.1 | 🟧 | Supabase account | Free for dev, **$25/mo per prod project** at Phase 4 (PITR) | One org, three projects later (see P0.3). |
| P0.2.2 | 🟧 | GitHub repo + Actions enabled | Free | Already exists; confirm Actions enabled. |
| P0.2.3 | 🟧 | Google Cloud Console project | Free | For Google OAuth client IDs (3, one per env). |
| P0.2.4 | 🟧 | Apple Developer Program enrollment | **$99/yr** | Required for Apple Sign-In on iOS. Skip until before staging launch. |
| P0.2.5 | 🟧 | Sentry org + project | Free tier | Used from Phase 1 (PR-1.1) onward. |
| P0.2.6 | 🟧 | Better Stack account (uptime monitor) | Free tier | Used from Phase 1. |
| P0.2.7 | 🟧 | Backblaze B2 account + bucket | Pennies/mo | Used in Phase 4 for weekly logical dumps. |
| P0.2.8 | 🟧 | Vercel account (for web `pokernight.app` host + invite-link routing) | Free | Used at Phase 0 for `/invite/<code>` URL handling. |
| P0.2.9 | 🟧 | EAS / Expo account | Free for dev builds | Phase 0 client builds. |

### 0.3 One-time decisions (resolve before Phase 0 SQL is written)

| ID | Type | Decision | Default |
|---|---|---|---|
| P0.3.1 | 🟧 | Invite-code format | 12-char base32 (db-backend §14 Phase 0 manual). |
| P0.3.2 | 🟧 | First-owner bootstrap | First signed-in caller of `create_group` becomes owner of the new group (identity-permissions §14). |
| P0.3.3 | 🟧 | Project names in Supabase | `poker-night-local-dev`, `poker-night-staging`, `poker-night-prod`. |
| P0.3.4 | 🟧 | Production domain | `pokernight.app` (staging: `staging.pokernight.app`). |

---

## Phase 0 — Foundation

Goal: schema, RLS, RPCs, fixtures, auth handoff, the `create_group` + `redeem_invite` + approval loop end-to-end.

### 0.A — Supabase platform setup

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.A.1 | 🟪 | Create three Supabase projects (`local-dev` is CLI-only via `supabase start`; create `staging` and `prod` in dashboard) | P0.1.3, P0.2.1, P0.3.3 |
| 0.A.2 | 🟪 | Enable `pgcrypto`, `pg_cron`, `citext` extensions in each project (Dashboard → Database → Extensions) | 0.A.1 |
| 0.A.3 | 🟪 | Generate per-project `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ACCESS_TOKEN`; store in GitHub Actions secrets | 0.A.1 |
| 0.A.4 | 🟪 | Configure auth providers in each Supabase project: enable Google, Apple, email magic-link (Dashboard → Authentication → Providers) | 0.A.1, 0.B.1, 0.B.2 |

### 0.B — OAuth provider setup (manual + platform)

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.B.1 | 🟪 | Google Cloud Console: create 3 OAuth 2.0 client IDs (dev/staging/prod). Register redirect URIs per identity-permissions §2.2 | P0.2.3 |
| 0.B.2 | 🟪 | Apple Developer: create Service ID + Key for staging + prod (skip local-dev) | P0.2.4 |
| 0.B.3 | 🟪 | Store Google + Apple client secrets in Supabase project secrets (Dashboard → Project Settings → API) | 0.A.1, 0.B.1, 0.B.2 |
| 0.B.4 | 🟪 | Configure Vercel rewrite so `https://pokernight.app/invite/<code>` (and staging) serves the invite-redemption page | P0.2.8, P0.3.4 |

### 0.C — Repo scaffolding

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.C.1 | 🟦 | **PR `repo-scaffold`**: add `supabase/` dir with `config.toml`, empty `migrations/`, `tests/`, `functions/`. Add `Makefile` targets `db-reset`, `db-test`, `gen-types`. | P0.1.3 |
| 0.C.2 | 🟦 | **PR `expo-init`**: bootstrap Expo app (TS, expo-router) in `app/` (preserve prototype under `legacy/` per existing layout). Register `pokernight://` scheme in `app.json`. Install `@supabase/supabase-js`, `expo-auth-session`. | P0.1.6 |
| 0.C.3 | 🟦 | **PR `env-config`**: add `.env.example` (Supabase URL + anon key for each env), wire `app.config.ts` to read env. **Never** commit secrets. | 0.C.2, 0.A.1 |

### 0.D — Migrations (DB schema + policies + RPCs)

Each migration ships as its own PR so it can land independently. All require `supabase` CLI locally (0.C.1).

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.D.1 | 🟦 | **`0001_extensions_enums_helpers.sql`** — `pgcrypto`, `gen_uuid_v7()` PL/pgSQL, all enums from §3.1 (`role_t`, `session_status_t`, `join_request_status_t`, `join_request_origin_t`, `discoverability_t`, `join_policy_t`, `buyin_unit_t`, `dinner_split_t`). | 0.C.1 |
| 0.D.2 | 🟦 | **`0002_schema_core.sql`** — `users`, `groups`, `group_members`, `players`, `seasons` tables + indexes (db-backend §3.2, §3.3). | 0.D.1 |
| 0.D.3 | 🟦 | **`0003_schema_sessions.sql`** — `sessions`, `session_seasons`, `session_players`, `buyins`, `cashouts`, `dinners`, `dinner_shares`, `families`, `family_members` + their composite FKs and indexes (§3.4–§3.6). | 0.D.2 |
| 0.D.4 | 🟦 | **`0004_schema_identity_admission.sql`** — `group_join_requests`, `audit_log`, `audit_log_monthly` + indexes (§3.7, §3.9). | 0.D.2 |
| 0.D.5 | 🟦 | **`0005_schema_stats.sql`** — `stats_snapshots`, `pending_stat_refresh` + partial unique indexes (§3.8). | 0.D.3 |
| 0.D.6 | 🟦 | **`0006_views.sql`** — `live_*` passthroughs, `effective_players`, `v_session_player_pnl`, `v_group_member_pnl`, `v_my_pnl_personal` (§4). | 0.D.5 |
| 0.D.7 | 🟦 | **`0007_helpers.sql`** — `role_in_group`, `is_member`, `can_edit_session`, `enqueue_stat_refresh` (SECURITY DEFINER helpers, §6.1, §8.2). | 0.D.5 |
| 0.D.8 | 🟦 | **`0008_rls_policies.sql`** — `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + ~50 `CREATE POLICY` statements generated from §6.2 matrix + `tg_groups_protect_owner_columns` (Pattern 4). | 0.D.7 |
| 0.D.9 | 🟦 | **`0009_triggers.sql`** — `tg_set_updated_at` (per table), `tg_session_settled_enqueue`, `tg_session_seasons_enqueue` (§8). | 0.D.6, 0.D.7 |
| 0.D.10 | 🟦 | **`0010_rpc_identity.sql`** — `tg_on_auth_user_created` (auth → public.users), `create_group`, `redeem_invite`, `admin_approve_join_request`, `admin_reject_join_request`, `internal_merge_player`, `admin_merge_players`, `admin_unmerge_player` (§7.2–§7.5, identity-permissions §2.4, §14). | 0.D.8 |
| 0.D.11 | 🟦 | **`0011_rpc_admin.sql`** — `season_backfill_by_date_range`, `refresh_stats_snapshots` (sketch body — full body in Phase 3), `leave_group`, `rotate_invite_code`, `transfer_ownership` (§7.5). | 0.D.10 |
| 0.D.12 | 🟦 | **`0012_cron_helpers.sql`** — `claim_stat_refresh_batch`, `mark_stat_refresh_processed`, idempotent `cron.schedule` calls for `drain-stat-refresh`, `audit-retention-daily`, `audit-retention-monthly-cleanup`. (Cron jobs registered but Edge Functions defined in 0.F.) | 0.D.11, 0.A.2 |

### 0.E — Seed + pgTAP suite + CI

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.E.1 | 🟦 | **`supabase/seed.sql`** — idempotent fixture set per identity-permissions §13.1 + db-backend §12.1 (`owner_user`, `admin_user`, `host_user`, `member_user`, `guest_attached_to_member_user`, `outsider_user`, two groups, two sessions). Deterministic UUIDs. | 0.D.11 |
| 0.E.2 | 🟦 | **pgTAP skeleton** — `supabase/tests/00_fixture.sql` loads seed; helper `impersonate(uuid)` wrapping `SET LOCAL request.jwt.claim.sub`. | 0.E.1 |
| 0.E.3 | 🟦 | **High-value invariant tests (first batch)**: `t_cross_group_isolation`, `t_session_create_requires_host_eligibility`, `t_join_request_approval_atomicity`, `t_ownership_non_orphanable`, `t_users_visibility_shared_group_only`, `t_join_request_no_duplicate_pending`. | 0.E.2 |
| 0.E.4 | 🟦 | **GitHub Actions workflow** `db-ci.yml`: on PR — spin Postgres in container, `supabase db reset`, apply migrations, run `seed.sql`, run pgTAP, run migration smoke (SELECT count per table per fixture role). | 0.E.3 |
| 0.E.5 | 🟦 | **CI gating** — require `db-ci` status on PRs to `main`. | 0.E.4 |

### 0.F — Edge Functions (data-layer plumbing)

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.F.1 | 🟦 | **Edge Function `drain-stat-refresh`** — polls `claim_stat_refresh_batch`, calls `refresh_stats_snapshots`, marks processed, reports failures to Sentry (db-backend §9.2). | 0.D.12 |
| 0.F.2 | 🟦 | **Edge Function `audit-retention-daily`** — rollup-then-delete (db-backend §10.2). | 0.D.4 |
| 0.F.3 | 🟦 | **Edge Function `audit-retention-monthly-cleanup`** — drops `audit_log_monthly` rows > 12 months. | 0.D.4 |
| 0.F.4 | 🟪 | Deploy `0.F.1–0.F.3` to `staging` Supabase project: `supabase functions deploy <name> --project-ref <staging>`. | 0.F.1, 0.F.2, 0.F.3, 0.A.3 |
| 0.F.5 | 🟪 | Verify pg_cron jobs registered (Dashboard → Database → Cron Jobs): `drain-stat-refresh` (`* * * * *`), `audit-retention-daily` (`0 3 * * *`), `audit-retention-monthly-cleanup` (`0 4 1 * *`). | 0.D.12, 0.F.4 |

### 0.G — Auth + identity client wiring (identity-permissions §16 PR-0.1 to PR-0.7)

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.G.1 | 🟦 | **PR-0.1 client auth integration** — wire `expo-auth-session` for Google, Apple, magic-link. Deep-link callback handler. Three-button sign-in screen. | 0.C.2, 0.C.3, 0.A.4, 0.B.3 |
| 0.G.2 | 🟦 | **PR-0.2 `useAuth()` hook** — returns `{user, session, signIn, signOut}`; background token refresh. | 0.G.1 |
| 0.G.3 | 🟦 | **PR-0.3 `redeem_invite` flow** — `/invite/<code>` route + paste-code screen → calls `redeem_invite` RPC → routes to "waiting" screen. | 0.G.2, 0.D.10, 0.B.4 |
| 0.G.4 | 🟦 | **PR-0.4 "Waiting for admin" screen** — pull-on-foreground polling of own `group_join_requests` rows. | 0.G.3 |
| 0.G.5 | 🟦 | **PR-0.5 minimal admin join-approval queue** — lists pending requests, single "Approve" button (no guest-merge UI yet), reject with optional note. | 0.G.2, 0.D.10 |
| 0.G.6 | 🟦 | **PR-0.6 `create_group` UI** — call RPC; caller auto-becomes owner. | 0.G.2, 0.D.10 |
| 0.G.7 | 🟦 | **PR-0.7 auth fixture wiring** — frontend tests get JWTs via local `SUPABASE_JWT_SECRET`-signed tokens; pgTAP scenarios from identity-permissions §13.2 added (continuation of 0.E.3). | 0.E.3, 0.G.6 |

### 0.H — Manual smoke tests (gate to Phase 1)

| ID | Type | Task | → deps |
|---|---|---|---|
| 0.H.1 | 🟧 | Sign in once on each provider (Google × 3 envs, Apple × 2 envs, magic-link × 3) and confirm `tg_on_auth_user_created` populates `public.users` correctly. | 0.G.1, 0.A.4 |
| 0.H.2 | 🟧 | End-to-end: user A creates group, generates invite code, user B redeems → "waiting" screen → user A approves → user B sees group in list. | 0.G.3, 0.G.4, 0.G.5, 0.G.6 |
| 0.H.3 | 🟧 | Confirm `/invite/<code>` deep-link works for signed-in *and* signed-out users (both staging + prod). | 0.B.4, 0.G.3 |

---

## Phase 1 — Session parity (DB exercises against real client writes)

No new schema. The live-session tables ship in Phase 0; client exercises them here.

### 1.A — DB

| ID | Type | Task | → deps |
|---|---|---|---|
| 1.A.1 | 🟦 | **PR-1.1 Edge Function `health`** — `200 OK` + DB ping (for Better Stack monitor). | 0.F.4 |
| 1.A.2 | 🟦 | **PR-1.2 session-write pgTAP**: `t_settle_trigger_enqueues_refresh`, `t_session_edit_host_or_admin`, soft-delete visibility per session-child table. | 0.E.3 |

### 1.B — Platform

| ID | Type | Task | → deps |
|---|---|---|---|
| 1.B.1 | 🟪 | Better Stack: configure HTTPS monitor against staging + prod `health` Edge Function URL. Alert to email/SMS. | P0.2.6, 1.A.1 |
| 1.B.2 | 🟪 | Sentry: enable backend project, install Edge Function SDK, confirm `mutation_id` + `session_id` tags propagate. | P0.2.5, 0.F.1 |

---

## Phase 2 — History + groups

### 2.A — Code

| ID | Type | Task | → deps |
|---|---|---|---|
| 2.A.1 | 🟦 | **PR-2.1 Group settings screen** — edit name, defaults (`chip_count`, `chip_money`, `currency`), `time_zone`. Owner-only sub-page "Privacy" (gated to private/invite_only only in v1). | 0.G.6 |
| 2.A.2 | 🟦 | **PR-2.2 Invite-code rotation UI** — owner-only "Rotate code" button calls `rotate_invite_code`; display current code with copy-to-clipboard. | 2.A.1, 0.D.11 |
| 2.A.3 | 🟦 | **pgTAP stats invariants**: `t_multi_season_no_double_count`, `t_view_inventory_no_multi_group`, `t_settlement_includes_dinner`, `t_dinner_excluded_from_pnl`. | 0.E.3 |
| 2.A.4 | 🟦 | **pgTAP `season_backfill_by_date_range`** fixture-driven test. | 2.A.3, 0.D.11 |

---

## Phase 3 — Stats + sharing + direct admin merge

### 3.A — Code

| ID | Type | Task | → deps |
|---|---|---|---|
| 3.A.1 | 🟦 | **Finalize `refresh_stats_snapshots`** body — JSONB assembly per §9.3 shape. Replaces the sketch from 0.D.11. | 0.D.11 |
| 3.A.2 | 🟦 | **pgTAP `t_stats_snapshot_shape_v1`** — produced JSON validates against fixture-locked schema. | 3.A.1 |
| 3.A.3 | 🟦 | **PR-3.1 `admin_merge_players` direct-merge UI** — on player detail page (member roster); same confirmation-modal pattern as approval-time merge. | 0.G.5, 0.D.10 |
| 3.A.4 | 🟦 | **PR-3.2 `admin_unmerge_player` undo UI** — visible only to owner/admin within 7-day window. | 3.A.3, 0.D.10 |
| 3.A.5 | 🟦 | **PR-3.3 D7 + D8 views (client)** — read `v_group_member_pnl` and `v_my_pnl_personal`; render "stakes vary" caveat on D8 when groups differ. | 3.A.1 |
| 3.A.6 | 🟦 | **pgTAP**: `t_unmerge_within_7_days`, `t_role_change_owner_only`, `t_discoverability_owner_only`, `t_merge_does_not_alter_session_detail`, `t_user_rename_does_not_alter_session_detail`. | 0.E.3 |

---

## Phase 4 — Identity reconciliation polish

### 4.A — Code

| ID | Type | Task | → deps |
|---|---|---|---|
| 4.A.1 | 🟦 | **PR-4.1 full join-approval queue UI** — requester block, recency-weighted candidate list with typeahead + last-played metadata, default-off checkboxes, confirmation modal on merge, "Promote to host?" toggle for owner (identity-permissions §7.1–§7.4). Supersedes 0.G.5. | 0.G.5, 3.A.3 |
| 4.A.2 | 🟦 | **PR-4.2 Role-management screen** — owner-only; list of `group_members`, role dropdown, direct UPDATE on `group_members.role`. | 0.D.8, 2.A.1 |
| 4.A.3 | 🟦 | **PR-4.3 leave-group + transfer-ownership** — `leave_group` button (sole-owner blocker copy); owner-only "Transfer ownership" with confirmation modal (identity-permissions §10.2). | 4.A.2, 0.D.11 |
| 4.A.4 | 🟦 | **PR-4.4 audit-log admin tooling** — group-scoped `audit_log` view (owner/admin only); filters by action/actor/date; row detail shows before/after JSONB. Read-only. | 4.A.2 |
| 4.A.5 | 🟦 | **PR-4.5 "Sessions edited since last refresh" indicator** — `v_sessions_edited_since_refresh(group_id)` view + group-page nudge. | 3.A.1 |
| 4.A.6 | 🟦 | **PR-4.6 audit_log shape pgTAP** — every RPC produces an audit row with the expected `action` and `subject_ids`. | 0.E.3, 3.A.1 |
| 4.A.7 | 🟦 | **PR-4.7 matrix coverage gap fillers** — every (table × role) cell not yet pinned by Phase 0–3 tests. | 4.A.6 |
| 4.A.8 | 🟦 | **Edge Function `b2-logical-dump`** — weekly `pg_dump` → upload to Backblaze B2 (db-backend §14 Phase 4). | 0.F.1 |

### 4.B — Platform

| ID | Type | Task | → deps |
|---|---|---|---|
| 4.B.1 | 🟪 | Upgrade prod Supabase project to Pro plan (enables 7-day PITR). | P0.2.1 |
| 4.B.2 | 🟪 | Configure billing alerts at 50% of free tier on Supabase, Vercel, Sentry, EAS. | P0.2.5, P0.2.8, P0.2.9 |
| 4.B.3 | 🟪 | Create Backblaze B2 bucket + application key; store credentials in Supabase secrets for `b2-logical-dump`. | P0.2.7, 4.A.8 |
| 4.B.4 | 🟪 | Register weekly cron for `b2-logical-dump` via `pg_cron` (or external scheduler if function runtime exceeds cron limit). | 4.A.8, 4.B.3 |

### 4.C — Manual

| ID | Type | Task | → deps |
|---|---|---|---|
| 4.C.1 | 🟧 | Decide PITR plan spend ($25/mo prod) and approve. | — |
| 4.C.2 | 🟧 | Run backup-restore drill once against staging (`operations.md` runbook, not in this doc) before declaring v1 ready. | 4.A.8, 4.B.4 |

---

## Cross-phase recurring tasks

| ID | Type | Cadence | Task |
|---|---|---|---|
| X.1 | 🟧 | Annual | Rotate Google + Apple OAuth secrets; renew Apple Developer membership ($99). |
| X.2 | 🟧 | Per migration to prod | Run `supabase db push --dry-run`, review diff in PR description before tagging `v*`. |
| X.3 | 🟧 | Per release | Confirm `auth.users → public.users` trigger still fires across all providers. |

---

## Dependency summary (critical path)

```
Pre-reqs (P0.*)
   ↓
0.A.1 (Supabase projects)  ──┐
                              ├──→ 0.A.4 (auth providers) ──→ 0.G.1 (client auth)
0.B.1 / 0.B.2 (OAuth clients)─┘
   ↓
0.C.1 (repo scaffold) ──→ 0.D.1..0.D.12 (migrations) ──→ 0.E.* (seed+pgTAP+CI)
                                            ↓
                                         0.F.* (Edge Functions)
                                            ↓
                                         0.G.3..0.G.7 (client identity)
                                            ↓
                                         0.H.* (manual smoke gates)
                                            ↓
                              Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
```

Phase 0 is the only phase with hard parallelism opportunities: **0.D.* migrations** can land sequentially on one branch while **0.A.* / 0.B.* platform setup** happens in parallel by a human operator. Client work (**0.G.***) can start once 0.A.4 + 0.D.10 land, in parallel with 0.E + 0.F.

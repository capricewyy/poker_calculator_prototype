# Poker Night — DB / Backend Design

**Status:** Draft for review · **Date:** 2026-05-25 · **Scope:** Postgres schema, RLS policies, SECURITY DEFINER RPCs, triggers, and the Supabase backend surface for Phases 0–4 of [top-level-design.md](top-level-design.md) §15.

## 1. Context

The Supabase-centric BaaS is the single shared substrate for every client surface; this doc owns everything that lives inside that substrate. The non-trivial pressures: a dual-shaped identity model where `players` (durable) and `users` (optional, late-binding) coexist permanently; immutability with a side door (settled sessions are stat-authoritative yet host-editable); a stats derivation that must never double-count multi-season sessions; soft-delete that must be enforced through every read path; and two layers of admin (group owner/admin plus session host) whose intersection must be expressible as policy. RLS is the policy engine — most authorization lives in declarative predicates, with SECURITY DEFINER RPCs reserved for destructive flows (merge, unmerge, role transfer, invite redemption, join approval). See [top-level-design.md](top-level-design.md) §4–§7.

This doc operationalizes the v1 cut. Phase 5 surfaces (push fan-out, discovery RPC, D8 stake normalization, D3 auto-claim) are out of scope here; the schema carries the *fields* that make them additive (`discoverability`, `join_policy`, `created_via`), but no policies, RPCs, or triggers for them ship in v1.

This doc is the **implementation blueprint** for the DB layer. The reader should be able to: (a) generate migrations from §3–§8, (b) write the pgTAP suite from §12, (c) wire CI from §11 and §14.

### Scope boundaries

**In scope:** Schema, RLS policies, RPCs, triggers, views, indexes, pgTAP tests, Edge Functions whose job is data-layer plumbing (stat refresh drain, audit retention, logical backup).

**Out of scope:** Client query patterns and offline queue ([frontend.md](frontend.md)); CI/CD pipeline wiring beyond DB migrations ([productionization.md](productionization.md)); backup drills, runbooks, alerts ([operations.md](operations.md)); auth provider configuration and user-facing identity flows ([identity-permissions.md](identity-permissions.md) — this doc owns the *tables, RPCs, and policies* those flows invoke).

### Anchors in the top-level architecture

- §4 — Data model (entities, 4.1 binding, 4.2 join requests, 4.3 multi-season, 4.4 P/L vs settlement, 4.5 invariants).
- §6 — Permission enforcement matrix (the RLS surface).
- §7.1 — Refresh triggers and the `pending_stat_refresh` queue.
- §13 — Calc port: what lives in DB views vs. client-side TypeScript.
- Appendix A.1 / A.4 — Supabase-centric BaaS + `stats_snapshots` JSONB-cache choices.
- Appendix C divergences 1, 2, 5 — multi-season relaxation, P/L vs settlement split, four-role hierarchy.

---

## 2. Conventions

| Topic | Choice | Rationale |
|---|---|---|
| **Primary keys** | `uuid` (UUIDv7), client-generated where possible. SQL fallback `gen_uuid_v7()` (single-PL/pgSQL function in initial migration). | Time-sortable, offline-safe, no round-trip for create. |
| **Timestamps** | `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`, `deleted_at timestamptz null` on soft-deletable tables. Maintained by `tg_set_updated_at` trigger (§8). | UTC throughout; conversion is read-side per `groups.time_zone`. |
| **Soft delete** | A row with `deleted_at IS NOT NULL` is invisible. Every soft-deletable table has a `live_<table>` view (`SELECT * WHERE deleted_at IS NULL`). RLS policies are written against the **base table**; SELECT policy carries `deleted_at IS NULL`. Application reads through `live_*` for convenience; pgTAP confirms both paths agree. | Catches the "forgot the predicate" footgun; one place to enforce. |
| **Naming** | snake_case. Plural tables (`groups`, `sessions`). RPCs: verb-first (`admin_approve_join_request`). Triggers: `tg_<event>_<action>`. Indexes: `ix_<table>_<columns>` and `uq_<table>_<columns>` for unique. | Standard Postgres conventions. |
| **`search_path`** | Every SECURITY DEFINER function declares `SET search_path = public, pg_temp`. | Defends against extension-hijack on shared schemas. |
| **Money & chips** | Chips: `numeric(14,4)` (handles odd-denomination chip rates without float drift). Money: `numeric(14,2)`. Currency: `text` (ISO 4217 + the `£`/`$` symbol legacy from prototype). | Prototype uses raw JS numbers; the schema upgrades to fixed precision. The chips-vs-money invariant (§5) is enforced by *which* column type lives where. |
| **JSONB** | Use only for `stats_snapshots.payload`, `audit_log.before`, `audit_log.after`, and (post-v1) `audit_log_monthly.summary`. Everywhere else: real columns. | JSONB is the fallback for *known-shape-evolving* fields; relational schema for *load-bearing* fields. |
| **Enums** | Real `CREATE TYPE … AS ENUM` for fixed sets (`role_t`, `session_status_t`, `join_request_status_t`, `discoverability_t`, `join_policy_t`, `unit_t`). Add values via `ALTER TYPE … ADD VALUE`, never remove (Postgres limitation). | Stronger than `text + check`; trivial to query. |
| **Migrations** | `supabase/migrations/NNNN_<slug>.sql`, monotonically numbered, plain SQL. Every migration is backward-compatible for one release (§11). | Matches `supabase` CLI's expected layout. |
| **Comments on schema** | `COMMENT ON TABLE/COLUMN/FUNCTION` for the load-bearing ones (`pnl_per_player`, `merged_into_player_id`, `session_seasons.group_id` denormalization, etc.). Read in dashboards and by tooling. | Documentation co-located with definition. |

---

## 3. Schema

### 3.1 Enums

```sql
CREATE TYPE role_t              AS ENUM ('owner', 'admin', 'host', 'member');
CREATE TYPE session_status_t    AS ENUM ('draft', 'settled');
CREATE TYPE join_request_status_t AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');
CREATE TYPE join_request_origin_t AS ENUM ('invite_code', 'discovery');  -- discovery activates post-v1
CREATE TYPE discoverability_t   AS ENUM ('private', 'link_only', 'listed');  -- v1 ships only 'private'
CREATE TYPE join_policy_t       AS ENUM ('invite_only', 'request_to_join'); -- v1 ships only 'invite_only'
CREATE TYPE buyin_unit_t        AS ENUM ('chips', 'money', 'buyin');        -- mirrors prototype's `toChips`
CREATE TYPE dinner_split_t      AS ENUM ('equal', 'custom');
```

### 3.2 Identity tables

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text NOT NULL,
  email         citext,                                -- nullable: Apple Sign-In's "Hide My Email"
                                                       -- relay can omit email on subsequent sign-ins;
                                                       -- some magic-link flows also leave it blank.
  avatar_url    text,
  home_currency text,                                  -- optional, for D8 personal roll-up display
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE email IS NOT NULL;

CREATE TABLE players (
  id                       uuid PRIMARY KEY,
  group_id                 uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  display_name             text NOT NULL,                         -- the name written into session history
  linked_user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  merged_into_player_id    uuid REFERENCES players(id) ON DELETE SET NULL,  -- non-canonical row points at canonical; SET NULL on canonical hard-delete restores unmerged state
  created_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CONSTRAINT players_merge_target_canonical_chk
    CHECK (merged_into_player_id IS NULL OR merged_into_player_id <> id)
  -- One-hop merge chain enforced by RPC + pgTAP (§12); cycle prevention by app-level invariant.
);

-- A linked user is unique within a group (one canonical account per group)
CREATE UNIQUE INDEX uq_players_linked_user_per_group
  ON players (group_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL AND merged_into_player_id IS NULL AND deleted_at IS NULL;
```

### 3.3 Group + season tables

```sql
CREATE TABLE groups (
  id               uuid PRIMARY KEY,
  name             text NOT NULL,
  invite_code      text NOT NULL,                         -- rotatable; see rotate_invite_code RPC
  default_chip_count    numeric(14,4) NOT NULL DEFAULT 100,
  default_chip_money    numeric(14,2) NOT NULL DEFAULT 1.00,
  default_currency      text NOT NULL DEFAULT '£',
  time_zone        text NOT NULL,                         -- IANA, e.g. 'Europe/London'
  discoverability  discoverability_t NOT NULL DEFAULT 'private',
  join_policy      join_policy_t NOT NULL DEFAULT 'invite_only',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT groups_invite_code_chk CHECK (length(invite_code) BETWEEN 6 AND 32)
);

CREATE UNIQUE INDEX uq_groups_invite_code_live ON groups (invite_code) WHERE deleted_at IS NULL;

CREATE TABLE group_members (
  group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         role_t NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,                               -- preserves history per C9
  PRIMARY KEY (group_id, user_id)
);

-- Non-orphanable ownership (§4.5 of top-level): at least one live owner per group.
-- Enforced at RPC layer (leave_group, transfer_ownership) and pinned by pgTAP.

CREATE TABLE seasons (
  id          uuid PRIMARY KEY,
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name        text NOT NULL,
  starts_on   date NOT NULL,                              -- interpreted in groups.time_zone
  ends_on     date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT seasons_dates_chk CHECK (ends_on >= starts_on)
);

CREATE INDEX ix_seasons_group ON seasons (group_id);
```

### 3.4 Session tables

```sql
CREATE TABLE sessions (
  id               uuid PRIMARY KEY,
  group_id         uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  played_on        date NOT NULL,                          -- interpreted in groups.time_zone
  status           session_status_t NOT NULL DEFAULT 'draft',
  host_player_id   uuid NOT NULL REFERENCES players(id),   -- the editor-of-record per decision 2
  chip_count       numeric(14,4) NOT NULL,                 -- snapshot of group defaults at creation, overridable
  chip_money       numeric(14,2) NOT NULL,
  currency         text NOT NULL,
  notes            text,
  settled_at       timestamptz,                            -- set on transition to 'settled'
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT sessions_rate_pos_chk CHECK (chip_count > 0 AND chip_money > 0)
);

CREATE INDEX ix_sessions_group_played_on ON sessions (group_id, played_on DESC) WHERE deleted_at IS NULL;

-- Many-to-many session <-> season (top-level §4.3).
-- The composite FKs are the cross-group integrity guarantee; the single-column FKs are dropped
-- to avoid double-defining the parent relationship (and to keep ON DELETE CASCADE behavior
-- consistent across the constraint set).
CREATE TABLE session_seasons (
  session_id  uuid NOT NULL,
  season_id   uuid NOT NULL,
  group_id    uuid NOT NULL,                               -- denormalized for the cross-group FK
  PRIMARY KEY (session_id, season_id),
  CONSTRAINT session_seasons_session_fk
    FOREIGN KEY (session_id, group_id) REFERENCES sessions(id, group_id) ON DELETE CASCADE,
  CONSTRAINT session_seasons_season_fk
    FOREIGN KEY (season_id, group_id) REFERENCES seasons(id, group_id) ON DELETE CASCADE
);

-- The composite FKs above require companion unique indexes on (sessions.id, group_id) and (seasons.id, group_id):
CREATE UNIQUE INDEX uq_sessions_id_group  ON sessions (id, group_id);
CREATE UNIQUE INDEX uq_seasons_id_group   ON seasons (id, group_id);

CREATE INDEX ix_session_seasons_season ON session_seasons (season_id);

CREATE TABLE session_players (
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id   uuid NOT NULL REFERENCES players(id),
  PRIMARY KEY (session_id, player_id)
);

CREATE INDEX ix_session_players_player ON session_players (player_id);
```

### 3.5 Live-game tables

```sql
CREATE TABLE buyins (
  id              uuid PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES players(id),
  chips           numeric(14,4) NOT NULL,            -- canonical storage
  original_amount numeric(14,4) NOT NULL,            -- what the user typed
  original_unit   buyin_unit_t NOT NULL,             -- 'chips' | 'money' | 'buyin'
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT buyins_chips_pos_chk CHECK (chips > 0)
);

CREATE INDEX ix_buyins_session_player ON buyins (session_id, player_id) WHERE deleted_at IS NULL;

CREATE TABLE cashouts (
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id    uuid NOT NULL REFERENCES players(id),
  chips        numeric(14,4) NOT NULL,                -- canonical storage
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, player_id),
  CONSTRAINT cashouts_chips_nonneg_chk CHECK (chips >= 0)
);

CREATE TABLE dinners (
  id            uuid PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  payer_player_id uuid NOT NULL REFERENCES players(id),
  total_amount  numeric(14,2) NOT NULL,               -- money, not chips
  label         text,                                  -- v1: free-text on the "dinner" entry ('Pizza', 'Drinks'); structurally ready for F4 generalization later, but UI ships dinner-only
  split_mode    dinner_split_t NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT dinners_amount_pos_chk CHECK (total_amount > 0)
);

CREATE INDEX ix_dinners_session ON dinners (session_id) WHERE deleted_at IS NULL;

-- One row per (dinner, participant) — always denormalized, even for equal splits (§4 entity table).
CREATE TABLE dinner_shares (
  dinner_id   uuid NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  player_id   uuid NOT NULL REFERENCES players(id),
  amount      numeric(14,2) NOT NULL,                  -- the per-person share
  PRIMARY KEY (dinner_id, player_id),
  CONSTRAINT dinner_shares_amount_nonneg_chk CHECK (amount >= 0)
);
```

### 3.6 Family tables (session-scoped)

```sql
CREATE TABLE families (
  id           uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_families_session ON families (session_id);

-- A family member must be in the same session (top-level §4.5 invariant).
-- Single-column REFERENCES dropped in favor of composite FKs, both with ON DELETE CASCADE.
CREATE TABLE family_members (
  family_id    uuid NOT NULL,
  player_id    uuid NOT NULL,
  session_id   uuid NOT NULL,                           -- denormalized for composite FK
  PRIMARY KEY (family_id, player_id),
  CONSTRAINT family_members_family_fk
    FOREIGN KEY (family_id, session_id) REFERENCES families(id, session_id) ON DELETE CASCADE,
  CONSTRAINT family_members_session_player_fk
    FOREIGN KEY (session_id, player_id) REFERENCES session_players(session_id, player_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_families_id_session ON families (id, session_id);

-- A player belongs to at most one family per session
CREATE UNIQUE INDEX uq_family_members_session_player ON family_members (session_id, player_id);
```

### 3.7 Identity admission tables

```sql
CREATE TABLE group_join_requests (
  id                    uuid PRIMARY KEY,
  group_id              uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  requesting_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                join_request_status_t NOT NULL DEFAULT 'pending',
  created_via           join_request_origin_t NOT NULL DEFAULT 'invite_code',
  decided_by_user_id    uuid REFERENCES users(id),
  decided_at            timestamptz,
  decided_note          text,                                          -- optional, surfaced back to requester
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT join_request_decided_chk
    CHECK (
      (status = 'pending' AND decided_by_user_id IS NULL AND decided_at IS NULL) OR
      (status <> 'pending' AND decided_at IS NOT NULL)
    ),
  CONSTRAINT join_request_decided_note_len_chk CHECK (decided_note IS NULL OR length(decided_note) <= 500)
);

-- At most one pending request per (group, user) — partial unique index per top-level §4.2
CREATE UNIQUE INDEX uq_join_requests_one_pending
  ON group_join_requests (group_id, requesting_user_id)
  WHERE status = 'pending';

CREATE INDEX ix_join_requests_group_pending ON group_join_requests (group_id) WHERE status = 'pending';
```

### 3.8 Stats tables

```sql
-- Surrogate id PK because PRIMARY KEY columns must be NOT NULL and season_id is nullable
-- ("group-wide" snapshot = season_id IS NULL).  Two partial unique indexes pin uniqueness:
CREATE TABLE stats_snapshots (
  id           uuid PRIMARY KEY,
  group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  season_id    uuid REFERENCES seasons(id) ON DELETE CASCADE,         -- NULL = group-wide
  payload      jsonb NOT NULL,                                          -- see §9.3 for shape
  computed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_stats_snapshots_per_season
  ON stats_snapshots (group_id, season_id) WHERE season_id IS NOT NULL;
CREATE UNIQUE INDEX uq_stats_snapshots_group_wide
  ON stats_snapshots (group_id) WHERE season_id IS NULL;

CREATE TABLE pending_stat_refresh (
  group_id      uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  season_id     uuid REFERENCES seasons(id) ON DELETE CASCADE,
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
-- Coalescing: at most one *open* row per (group, season).
CREATE UNIQUE INDEX uq_pending_stat_refresh_open
  ON pending_stat_refresh (group_id, season_id)
  WHERE processed_at IS NULL;
CREATE UNIQUE INDEX uq_pending_stat_refresh_open_group_wide
  ON pending_stat_refresh (group_id)
  WHERE processed_at IS NULL AND season_id IS NULL;
CREATE INDEX ix_pending_stat_refresh_open ON pending_stat_refresh (enqueued_at) WHERE processed_at IS NULL;
```

### 3.9 Audit log

```sql
CREATE TABLE audit_log (
  id              uuid PRIMARY KEY,
  group_id        uuid REFERENCES groups(id) ON DELETE SET NULL,       -- NULL for cross-group actions (rare)
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,                                        -- e.g. 'session.edit', 'players.merge', 'group.role_change'
  subject_table   text NOT NULL,                                        -- 'sessions' | 'players' | 'group_members' | …
  subject_ids     uuid[] NOT NULL,                                      -- one row may name several subjects (multi-merge)
  before          jsonb,                                                -- previous state (per subject_id, keyed by id)
  after           jsonb,                                                -- new state
  request_id      uuid,                                                 -- optional correlation id (RPC supplies)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_log_group_action_time ON audit_log (group_id, action, created_at DESC);
CREATE INDEX ix_audit_log_actor_time        ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX ix_audit_log_subject           ON audit_log USING GIN (subject_ids);

-- Retention (§10): a daily cron deletes rows older than 55 days; a monthly cron rolls them into audit_log_monthly.
CREATE TABLE audit_log_monthly (
  group_id        uuid REFERENCES groups(id) ON DELETE CASCADE,
  bucket_month    date NOT NULL,                                        -- first of month
  action          text NOT NULL,
  subject_table   text NOT NULL,
  event_count     integer NOT NULL,
  actor_user_ids  uuid[] NOT NULL,
  PRIMARY KEY (group_id, bucket_month, action, subject_table)
);
```

---

## 4. Views

Views are the *only* read shape that the client should consume for soft-deletable and merged data. Direct base-table reads are reserved for admin tooling.

```sql
-- 4.1  Soft-delete passthrough (one per soft-deletable table)
CREATE VIEW live_groups     AS SELECT * FROM groups     WHERE deleted_at IS NULL;
CREATE VIEW live_seasons    AS SELECT * FROM seasons    WHERE deleted_at IS NULL;
CREATE VIEW live_sessions   AS SELECT * FROM sessions   WHERE deleted_at IS NULL;
CREATE VIEW live_buyins     AS SELECT * FROM buyins     WHERE deleted_at IS NULL;
CREATE VIEW live_dinners    AS SELECT * FROM dinners    WHERE deleted_at IS NULL;
CREATE VIEW live_players    AS SELECT * FROM players    WHERE deleted_at IS NULL;

-- 4.2  effective_players — one-hop merge resolution
-- Used by every stats read.  Session-detail reads use raw `players` so the
-- original name on the night is preserved.
CREATE VIEW effective_players AS
SELECT
  p.id                                             AS raw_player_id,
  COALESCE(p.merged_into_player_id, p.id)          AS canonical_player_id,
  p.group_id,
  p.display_name                                   AS raw_display_name,
  c.display_name                                   AS canonical_display_name,
  c.linked_user_id                                 AS canonical_linked_user_id
FROM players p
LEFT JOIN players c ON c.id = COALESCE(p.merged_into_player_id, p.id)
WHERE p.deleted_at IS NULL;

-- 4.3  Per-session P/L per canonical player (the dinner-out-of-P/L formula from top-level §4.4).
-- STATS USE ONLY.  Groups by canonical_player_id so a merged guest's PnL rolls into the user.
-- Session-detail screens DO NOT read this view — they compute PnL client-side from raw rows
-- (joined to raw `players` so the original name on the night is preserved). See §4 commentary.
-- B5 edits surface immediately to the session-detail compute path; stats lag until next refresh.
--
-- Buy-ins are aggregated in a sub-CTE BEFORE joining cashouts to avoid the classic SUM × LEFT-JOIN
-- cardinality bug (each cashout row would otherwise multiply by the number of buy-in rows).
CREATE VIEW v_session_player_pnl AS
WITH buyin_sum AS (
  SELECT session_id, player_id, SUM(chips) AS chips_total
    FROM buyins WHERE deleted_at IS NULL
    GROUP BY session_id, player_id
)
SELECT
  sp.session_id,
  ep.canonical_player_id              AS player_id,
  s.group_id,
  (s.chip_money / s.chip_count) AS rate,
  COALESCE(bs.chips_total, 0)         AS buyin_chips,
  COALESCE(c.chips, 0)                AS cashout_chips,
  -- pnl = cashout * rate - sum(buyin) * rate   (dinner intentionally excluded)
  (COALESCE(c.chips, 0) - COALESCE(bs.chips_total, 0)) * (s.chip_money / s.chip_count) AS pnl
FROM session_players sp
JOIN sessions s              ON s.id = sp.session_id AND s.deleted_at IS NULL
JOIN effective_players ep    ON ep.raw_player_id = sp.player_id
LEFT JOIN buyin_sum bs       ON bs.session_id = sp.session_id AND bs.player_id = sp.player_id
LEFT JOIN cashouts c         ON c.session_id = sp.session_id AND c.player_id = sp.player_id;
-- Note: rows are still per raw session_players entry.  Aggregation by canonical_player_id
-- (when two merged guests played the same session — pathological but possible after admin
-- error + unmerge windows) is handled by callers using SUM(pnl) GROUP BY canonical_player_id.
-- A pgTAP test pins the same-session-double-merge edge case.

-- 4.4  Group-member P/L (D7) — every group member can read every other member's row.
-- Per identity-permissions.md §3.5: the *current* canonical display name comes from users
-- when the player is linked; otherwise the player's own display_name (the guest's typed name).
CREATE VIEW v_group_member_pnl AS
SELECT
  p.group_id,
  p.id                AS canonical_player_id,
  COALESCE(u.display_name, p.display_name)  AS display_name,
  p.linked_user_id,
  COUNT(DISTINCT v.session_id)            AS sessions_played,
  COALESCE(SUM(v.pnl), 0)                  AS pnl_lifetime
FROM players p
LEFT JOIN users u                  ON u.id = p.linked_user_id
LEFT JOIN v_session_player_pnl v   ON v.player_id = p.id
WHERE p.merged_into_player_id IS NULL AND p.deleted_at IS NULL
GROUP BY p.group_id, p.id, p.display_name, u.display_name, p.linked_user_id;

-- 4.5  Personal cross-group roll-up (D8) — filtered to auth.uid() across all groups
-- This is the only view that returns rows from multiple groups in one shape.
CREATE VIEW v_my_pnl_personal AS
SELECT
  p.group_id,
  g.name              AS group_name,
  g.default_currency  AS currency,
  (g.default_chip_money / g.default_chip_count) AS rate_estimate, -- for the "stakes vary" indicator
  COUNT(DISTINCT v.session_id)            AS sessions_played,
  COALESCE(SUM(v.pnl), 0)                  AS pnl_lifetime
FROM players p
JOIN groups g ON g.id = p.group_id AND g.deleted_at IS NULL
LEFT JOIN v_session_player_pnl v  ON v.player_id = p.id
WHERE p.linked_user_id = auth.uid()
  AND p.merged_into_player_id IS NULL
  AND p.deleted_at IS NULL
GROUP BY p.group_id, g.name, g.default_currency, g.default_chip_money, g.default_chip_count;
```

**Non-existent by construction.** There is no view, table, or RPC that returns leaderboard rows mixing groups. D7 stays inside a group; D8 returns only the caller's own rows. pgTAP pins this with a "no view selects from multiple group_ids" inventory check.

---

## 5. Indexes & invariants

### Indexes (rationalized)

Beyond the indexes inline in §3, the working set is:

| Index | Why |
|---|---|
| `ix_sessions_group_played_on` (group, played_on DESC) WHERE live | Session list (B3) is the most common query. |
| `ix_buyins_session_player` WHERE live | Per-player P/L derivation. |
| `ix_session_players_player` | Player → sessions reverse lookup for D8. |
| `uq_players_linked_user_per_group` | Enforces "one canonical account per group". |
| `uq_groups_invite_code_live` | Invite code is the primary entry point. |
| `uq_join_requests_one_pending` | The state-machine guard. |
| `uq_pending_stat_refresh_open` (+ group-wide partner) | Coalescing key for the queue. |
| `uq_family_members_session_player` | A player belongs to one family at most per session. |
| `ix_audit_log_group_action_time`, `ix_audit_log_subject` | Runbook queries (§12 of top-level). |

### Invariants (where each is enforced)

| Invariant | Enforcement |
|---|---|
| `buyins.chips`, `cashouts.chips` are chips, never money | Column types + naming convention; pgTAP grep on schema. |
| `players.linked_user_id` unique within group | `uq_players_linked_user_per_group`. |
| Merge chain terminates in one hop (canonical's `merged_into_player_id IS NULL`) | `admin_merge_players` enforces; pgTAP test inserts a 2-hop and asserts rejection. |
| `seasons.group_id = sessions.group_id` for every `session_seasons` row | Composite FKs (§3.4). |
| `family_members.player_id` must be in `session_players` for that session | Composite FK via denormalized `session_id` (§3.6). |
| No view computes per-player P/L through `families` | Schema review + pgTAP "view inventory" check. |
| Lifetime/group stats aggregate sessions directly; only season stats go through `session_seasons` | Encoded in view bodies (§4); pgTAP fixture inserts a 2-season session and asserts B8 count = 1 while both B7 seasons count it. |
| `sessions.status` transitions only `draft ↔ settled` | `session_status_t` enum + RPC guard on edit; pgTAP. |
| Soft-deleted rows invisible | Every soft-deletable table has a `live_*` view + RLS SELECT carries `deleted_at IS NULL`; pgTAP per-table visibility test. |
| Group ownership is non-orphanable | `leave_group` and `transfer_ownership` RPCs check; pgTAP attempts orphan path under every role. |
| Session creation requires `role IN ('owner','admin','host')` | RLS INSERT policy on `sessions` (§6 pattern 4); pgTAP per role. |
| Single timezone per group | `groups.time_zone NOT NULL`; date interpretation rule in `v_*` views. |

---

## 6. RLS policies

### 6.1 The matrix

`auth.uid()` is the calling user's id. Reads/writes go through PostgREST so RLS is enforced. Aside from the SECURITY DEFINER RPCs in §7, every write goes through these policies.

Helper functions (created in initial migration, used throughout):

> **Why `SECURITY DEFINER`.** These helpers are called from every other table's RLS predicates, including the policies on `group_members` itself. Without SECURITY DEFINER, the helper would invoke `group_members`'s own RLS, which depends on the helper, producing infinite recursion. SECURITY DEFINER lets the helper read `group_members` once under the function-owner's privileges, breaking the cycle. The helpers expose nothing the caller couldn't derive: each takes `auth.uid()` implicitly and returns only a role tag for that user. `SET search_path` defends against extension-hijack.

```sql
-- Returns the caller's role in the group, or NULL if not a live member.
CREATE FUNCTION public.role_in_group(g uuid) RETURNS role_t
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT role FROM group_members
  WHERE group_id = g AND user_id = auth.uid() AND left_at IS NULL;
$$;

-- TRUE if caller is a live member of the group (any role).
CREATE FUNCTION public.is_member(g uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM group_members
    WHERE group_id = g AND user_id = auth.uid() AND left_at IS NULL
  );
$$;

-- TRUE if caller can edit a session: owner/admin in the group, OR the host's linked user.
-- Soft-deleted sessions are NOT editable through this gate; un-delete first (admin-only, via
-- direct UPDATE of `deleted_at` allowed by the soft-delete UPDATE policy on sessions).
CREATE FUNCTION public.can_edit_session(s_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM sessions s
    JOIN players hp ON hp.id = s.host_player_id
    WHERE s.id = s_id
      AND s.deleted_at IS NULL
      AND (
        role_in_group(s.group_id) IN ('owner','admin')
        OR hp.linked_user_id = auth.uid()
      )
  );
$$;
```

### 6.2 Per-action authorization

Roles are `owner`, `admin`, `host`, `member`. "host-or-up" = `IN ('owner','admin','host')`. "admin-or-up" = `IN ('owner','admin')`. "any member" = caller is `is_member(group_id)`.

| Action | Authorized | Mechanism |
|---|---|---|
| Read `groups`, `seasons`, `sessions`, `players`, `session_players`, `buyins`, `cashouts`, `dinners`, `dinner_shares`, `families`, `family_members`, `stats_snapshots` (within group) | any member | SELECT policy: `is_member(group_id)` (or join through it). |
| Read `v_group_member_pnl` | any member | Same as above. |
| Read `v_my_pnl_personal` | self | View body filters `linked_user_id = auth.uid()`. |
| Read `group_members` | any member of that group | SELECT policy on `group_members`: `is_member(group_id)`. |
| Read `group_join_requests` (own row) | requester | `requesting_user_id = auth.uid()`. |
| Read `group_join_requests` (group's pending queue) | admin-or-up | `role_in_group(group_id) IN ('owner','admin')`. |
| Create `sessions` | host-or-up | INSERT policy on `sessions`: `role_in_group(group_id) IN ('owner','admin','host')`. |
| Update / soft-delete `sessions` (B5/B6) | `can_edit_session(id)` | UPDATE policy on `sessions`. |
| Insert/update/soft-delete `buyins`, `cashouts`, `dinners`, `dinner_shares`, `session_players`, `families`, `family_members` | `can_edit_session(session_id)` | Per-table INSERT/UPDATE/DELETE policies — every row joins to a session via `session_id`. |
| Create/edit `seasons` | admin-or-up | Per-table policy. |
| Edit `groups` (name, defaults, time_zone) | admin-or-up | UPDATE policy on `groups`. |
| Edit `groups.discoverability`, `groups.join_policy` | owner-only | Conditional UPDATE policy: WITH CHECK on the column subset (see §6.4). |
| Rotate `groups.invite_code` | owner-only | Via `rotate_invite_code` RPC (§7); no direct UPDATE policy on the column. |
| Change `group_members.role` | owner-only | UPDATE policy on `group_members`: `role_in_group(group_id) = 'owner'`. |
| Insert into `group_members` | **no direct INSERT policy** | All admissions go through `admin_approve_join_request` RPC (§7). |
| Withdraw own `group_join_requests` | requester, status=pending | UPDATE policy on `group_join_requests`: USING gates *pre*-update visibility (`requesting_user_id = auth.uid() AND status = 'pending'`); WITH CHECK gates *post*-update shape (`requesting_user_id = auth.uid() AND status = 'withdrawn'`). Together: caller can flip only their own pending row, and only to `withdrawn` (no admin transitions). |
| Insert `group_join_requests` | **via `redeem_invite` RPC** | No direct INSERT policy. |
| Approve / reject join request | **via `admin_approve_join_request` / `admin_reject_join_request`** | No direct UPDATE policy for these transitions. |
| Run B11 stat refresh | any member | RPC `refresh_stats_snapshots` gates on `is_member`. |
| Read own `audit_log` rows | self | `actor_user_id = auth.uid()`. |
| Read group `audit_log` rows | admin-or-up | `role_in_group(group_id) IN ('owner','admin')`. |
| Insert `audit_log` | **only via SECURITY DEFINER RPCs** | No direct INSERT/UPDATE/DELETE policy for ordinary users. |
| Leave group (C9) | self, **unless sole live owner** | Via `leave_group` RPC (§7). |
| Transfer ownership | owner | Via `transfer_ownership` RPC (§7). |

### 6.3 Pattern examples

Most tables fall into four patterns. Examples in full SQL:

**Pattern 1 — "any member can read":**

```sql
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_select_member ON sessions FOR SELECT
  USING (is_member(group_id) AND deleted_at IS NULL);
```

**Pattern 2 — "session-editor can write (host or admin)":**

```sql
CREATE POLICY sessions_insert_host_eligible ON sessions FOR INSERT
  WITH CHECK (role_in_group(group_id) IN ('owner','admin','host'));

CREATE POLICY sessions_update_editor ON sessions FOR UPDATE
  USING (can_edit_session(id))
  WITH CHECK (can_edit_session(id));

-- Soft-delete is an UPDATE that sets deleted_at.
-- True DELETE is not exposed to clients (hard-delete is admin-only via dashboard).
```

**Pattern 3 — "row tied to a session":** (applies to `buyins`, `cashouts`, `dinners`, `families`, `session_players` — all tables that carry their own `session_id`):

```sql
ALTER TABLE buyins ENABLE ROW LEVEL SECURITY;

CREATE POLICY buyins_select_member ON buyins FOR SELECT
  USING (
    EXISTS(SELECT 1 FROM sessions s
           WHERE s.id = buyins.session_id AND is_member(s.group_id))
    AND deleted_at IS NULL
  );

CREATE POLICY buyins_write_editor ON buyins FOR ALL
  USING (can_edit_session(session_id))
  WITH CHECK (can_edit_session(session_id));
```

**Pattern 3b — "row tied to a session via a parent table":** `dinner_shares` joins to its session through `dinners.session_id`; `family_members` joins through `families.session_id`. Same authorization, one extra hop:

```sql
ALTER TABLE dinner_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY dinner_shares_select_member ON dinner_shares FOR SELECT
  USING (
    EXISTS(SELECT 1
           FROM dinners d JOIN sessions s ON s.id = d.session_id
           WHERE d.id = dinner_shares.dinner_id
             AND d.deleted_at IS NULL
             AND is_member(s.group_id))
  );

CREATE POLICY dinner_shares_write_editor ON dinner_shares FOR ALL
  USING (
    EXISTS(SELECT 1 FROM dinners d WHERE d.id = dinner_shares.dinner_id
           AND can_edit_session(d.session_id))
  )
  WITH CHECK (
    EXISTS(SELECT 1 FROM dinners d WHERE d.id = dinner_shares.dinner_id
           AND can_edit_session(d.session_id))
  );
```

The same shape applies to `family_members` (join through `families.session_id`). pgTAP `t_dinner_shares_rls_member_only` and `t_family_members_rls_member_only` pin both.

**Pattern 4 — "column-scoped owner-only (privacy escalator)":** RLS predicates evaluate against the NEW row only, so column-change checks (NEW vs OLD) cannot be expressed in `WITH CHECK`. The clean pattern is **policy + BEFORE UPDATE trigger**:

```sql
-- Policy: admin-or-up can UPDATE groups at all.
CREATE POLICY groups_update_admin ON groups FOR UPDATE
  USING (role_in_group(id) IN ('owner','admin'))
  WITH CHECK (role_in_group(id) IN ('owner','admin'));

-- Trigger: reject the txn if a non-owner attempts to change owner-only columns.
-- Only discoverability and join_policy are guarded here.  invite_code is mutated only via the
-- rotate_invite_code RPC (SECURITY DEFINER, owner-only); there is no direct-UPDATE policy on
-- it, so the trigger does not need to (and intentionally does not) re-guard it.  This avoids
-- the RPC-vs-trigger interaction where a legitimate owner-led rotation could be blocked if
-- auth.uid()'s role had churned in the same txn.
CREATE FUNCTION public.tg_groups_protect_owner_columns() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF role_in_group(NEW.id) <> 'owner' THEN
    IF NEW.discoverability IS DISTINCT FROM OLD.discoverability
       OR NEW.join_policy IS DISTINCT FROM OLD.join_policy THEN
      RAISE EXCEPTION 'owner-only column' USING errcode='45403',
        detail=jsonb_build_object('code','OWNER_ONLY_COLUMN',
          'message','Only the group owner can change discoverability or join policy.');
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tg_groups_protect_owner_columns
  BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION public.tg_groups_protect_owner_columns();
```

pgTAP pins this: an `admin` UPDATE that touches `discoverability` raises `OWNER_ONLY_COLUMN`; an `owner` UPDATE that touches it succeeds; an `admin` UPDATE that touches only `name`/`time_zone`/defaults succeeds. `invite_code` is exercised separately via `rotate_invite_code` (owner-only RPC).

The full set of `CREATE POLICY` statements (one per (table, action) pair) is generated mechanically from the §6.2 matrix — about 50 statements total — and lives in `supabase/migrations/0002_rls_policies.sql`.

### 6.4 RLS exclusions: SECURITY DEFINER RPCs

A small set of actions cannot be expressed as a single-row policy: they need transactional atomicity, write to `audit_log`, or modify rows in tables the caller doesn't otherwise have write access to (e.g. inserting into `group_members` based on a `group_join_requests` decision). These go through SECURITY DEFINER RPCs (§7). For these tables (`group_members` INSERT, `group_join_requests` decisions, `audit_log` all writes, `players.merged_into_player_id` updates), there is **no permissive policy** — all writes funnel through an RPC that does its own role check inside.

---

## 7. SECURITY DEFINER RPCs

Conventions for every RPC:

- `SECURITY DEFINER`, `SET search_path = public, pg_temp`.
- First statement is an authorization check (`PERFORM assert_role(...)`, custom raise).
- All writes are wrapped in a single transaction (default for `plpgsql` functions).
- Every write that mutates user-visible state writes a row to `audit_log` with `request_id := gen_uuid_v7()` and an action string from the table below.
- Errors are raised with `RAISE EXCEPTION USING errcode = '…', message = '…', detail = json_build_object('code', '…', 'message', '…')`. SQLSTATEs are reserved in the `45xxx` "user defined" class; the table in §7.6 lists them.
- The function owner is the migration role (e.g. `postgres`); the `EXECUTE` grant goes to `authenticated`.

### 7.1 The RPC inventory

| RPC | Purpose | Caller authorization |
|---|---|---|
| `redeem_invite(p_invite_code text)` | Create a `pending` `group_join_requests` row. No `group_members` write yet. | `authenticated`, no role check (validity of code IS the check). |
| `admin_approve_join_request(p_request_id uuid, p_merge_player_ids uuid[] DEFAULT '{}')` | Atomic: create `group_members` row + (optionally) merge selected guest players + write audit rows. | Caller is `admin`-or-up in the request's group. |
| `admin_reject_join_request(p_request_id uuid, p_note text DEFAULT NULL)` | Mark request `rejected`. | `admin`-or-up. |
| `admin_merge_players(p_target_user_id uuid, p_guest_player_ids uuid[])` | Post-admission cleanup: merge guests into a user-linked player. | `admin`-or-up in the group of every guest. |
| `admin_unmerge_player(p_player_id uuid)` | Undo merge inside 7-day window using `audit_log`. | `admin`-or-up. Window enforced inside body. |
| `season_backfill_by_date_range(p_season_id uuid)` | Insert `session_seasons` rows for every existing session whose `played_on` falls in the season. | `admin`-or-up. |
| `refresh_stats_snapshots(p_group_id uuid, p_season_id uuid DEFAULT NULL)` | Recompute and overwrite `stats_snapshots` row(s). Idempotent. | Any group member (B11). |
| `leave_group(p_group_id uuid)` | Set `group_members.left_at = now()` for self. Reject if sole live owner. | Self. |
| `rotate_invite_code(p_group_id uuid)` | Generate a new invite code; old one immediately invalid. | `owner`. |
| `transfer_ownership(p_group_id uuid, p_new_owner_user_id uuid)` | Demote current owner to `admin`; promote target to `owner`; require target be a live member. | `owner`. |

### 7.2 `redeem_invite`

```sql
CREATE FUNCTION public.redeem_invite(p_invite_code text)
RETURNS uuid                              -- returns the new request id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_group_id uuid;
  v_user_id  uuid := auth.uid();
  v_request_id uuid := gen_uuid_v7();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING errcode = '45401',
      detail = jsonb_build_object('code','UNAUTHENTICATED','message','Sign in required.');
  END IF;

  SELECT id INTO v_group_id FROM groups
    WHERE invite_code = p_invite_code AND deleted_at IS NULL;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid invite' USING errcode = '45404',
      detail = jsonb_build_object('code','INVITE_INVALID','message','Invite code is invalid or expired.');
  END IF;

  IF EXISTS(SELECT 1 FROM group_members WHERE group_id = v_group_id AND user_id = v_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'already member' USING errcode = '45409',
      detail = jsonb_build_object('code','ALREADY_MEMBER','message','You are already a member of this group.');
  END IF;

  -- Unique partial index uq_join_requests_one_pending handles "already pending" → 23505
  INSERT INTO group_join_requests (id, group_id, requesting_user_id, created_via)
  VALUES (v_request_id, v_group_id, v_user_id, 'invite_code');

  INSERT INTO audit_log (id, group_id, actor_user_id, action, subject_table, subject_ids, after, request_id)
  VALUES (gen_uuid_v7(), v_group_id, v_user_id, 'join_request.create', 'group_join_requests',
          ARRAY[v_request_id], jsonb_build_object('created_via','invite_code'), v_request_id);

  RETURN v_request_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'request already pending' USING errcode = '45409',
      detail = jsonb_build_object('code','JOIN_REQUEST_PENDING','message','A request for this group is already pending.');
END $$;

GRANT EXECUTE ON FUNCTION public.redeem_invite(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.redeem_invite(text) FROM PUBLIC;
```

### 7.3 `admin_approve_join_request` — the atomic approval-with-merge

This is the highest-stakes RPC in the system. Admission and every merge succeed together, or none do.

```sql
CREATE FUNCTION public.admin_approve_join_request(
  p_request_id        uuid,
  p_merge_player_ids  uuid[] DEFAULT '{}'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_request    group_join_requests%ROWTYPE;
  v_actor      uuid := auth.uid();
  v_request_id uuid := gen_uuid_v7();
  v_new_player_id uuid := gen_uuid_v7();
  v_user_display text;
  v_guest_id   uuid;
BEGIN
  SELECT * INTO v_request FROM group_join_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING errcode = '45404',
      detail = jsonb_build_object('code','REQUEST_NOT_FOUND','message','Join request not found.');
  END IF;

  IF role_in_group(v_request.group_id) NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '45403',
      detail = jsonb_build_object('code','FORBIDDEN','message','Only owners and admins can approve join requests.');
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'request not pending' USING errcode = '45409',
      detail = jsonb_build_object('code','REQUEST_NOT_PENDING','message','This request has already been decided.');
  END IF;

  -- Create the canonical player row for the new user in this group.
  SELECT display_name INTO v_user_display FROM users WHERE id = v_request.requesting_user_id;
  INSERT INTO players (id, group_id, display_name, linked_user_id, created_by_user_id)
  VALUES (v_new_player_id, v_request.group_id, v_user_display, v_request.requesting_user_id, v_actor);

  -- Merge every selected guest into the new canonical player.
  -- Validation: guest is in the same group, is currently unlinked, is canonical.
  FOREACH v_guest_id IN ARRAY p_merge_player_ids LOOP
    PERFORM internal_merge_player(v_guest_id, v_new_player_id, v_actor, v_request_id);
  END LOOP;

  -- Admit the user.
  INSERT INTO group_members (group_id, user_id, role)
  VALUES (v_request.group_id, v_request.requesting_user_id, 'member');

  -- Resolve the request.
  UPDATE group_join_requests
     SET status='approved', decided_by_user_id=v_actor, decided_at=now()
   WHERE id = p_request_id;

  -- Audit.
  INSERT INTO audit_log (id, group_id, actor_user_id, action, subject_table, subject_ids, after, request_id)
  VALUES (gen_uuid_v7(), v_request.group_id, v_actor, 'join_request.approve', 'group_join_requests',
          ARRAY[p_request_id],
          jsonb_build_object('admitted_user_id', v_request.requesting_user_id,
                             'new_player_id', v_new_player_id,
                             'merged_guest_ids', to_jsonb(p_merge_player_ids)),
          v_request_id);

  -- Enqueue stat refresh for the group (and every season the user's merged-in sessions touched).
  PERFORM enqueue_stat_refresh(v_request.group_id, NULL);
END $$;
```

The helper `internal_merge_player` is the shared merge body (used by `admin_approve_join_request` and `admin_merge_players`):

```sql
CREATE FUNCTION public.internal_merge_player(
  p_guest_id uuid, p_target_id uuid, p_actor uuid, p_request_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_guest_before jsonb;
  v_target_group uuid;
BEGIN
  -- FOR UPDATE so two concurrent admin-approvals or admin-direct-merges can't double-merge
  -- the same guest.  The lock is released at txn commit.
  SELECT row_to_json(p)::jsonb INTO v_guest_before FROM players p WHERE id = p_guest_id FOR UPDATE;
  IF v_guest_before IS NULL THEN
    RAISE EXCEPTION 'guest not found' USING errcode='45404', detail=jsonb_build_object('code','PLAYER_NOT_FOUND');
  END IF;
  IF (v_guest_before->>'linked_user_id') IS NOT NULL THEN
    RAISE EXCEPTION 'guest already linked' USING errcode='45409', detail=jsonb_build_object('code','PLAYER_LINKED');
  END IF;
  IF (v_guest_before->>'merged_into_player_id') IS NOT NULL THEN
    RAISE EXCEPTION 'guest already merged' USING errcode='45409', detail=jsonb_build_object('code','PLAYER_MERGED');
  END IF;
  SELECT group_id INTO v_target_group FROM players WHERE id = p_target_id;
  IF v_target_group IS DISTINCT FROM (v_guest_before->>'group_id')::uuid THEN
    RAISE EXCEPTION 'cross-group merge' USING errcode='45403', detail=jsonb_build_object('code','MERGE_CROSS_GROUP');
  END IF;

  UPDATE players SET merged_into_player_id = p_target_id, updated_at = now() WHERE id = p_guest_id;

  -- Per §10.1: before/after are keyed by subject id so multi-subject audit rows survive replay.
  INSERT INTO audit_log (id, group_id, actor_user_id, action, subject_table, subject_ids, before, after, request_id)
  VALUES (gen_uuid_v7(), v_target_group, p_actor, 'players.merge', 'players',
          ARRAY[p_guest_id, p_target_id],
          jsonb_build_object(p_guest_id::text, v_guest_before),
          jsonb_build_object(p_guest_id::text, jsonb_build_object('merged_into_player_id', p_target_id)),
          p_request_id);
END $$;
```

### 7.4 `admin_unmerge_player` (7-day window enforced in RPC body)

```sql
CREATE FUNCTION public.admin_unmerge_player(p_player_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_merge_row audit_log%ROWTYPE;
  v_group uuid;
BEGIN
  SELECT group_id INTO v_group FROM players WHERE id = p_player_id;
  IF role_in_group(v_group) NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'forbidden' USING errcode='45403', detail=jsonb_build_object('code','FORBIDDEN');
  END IF;

  -- Find the most-recent merge audit row for this player; reject if older than 7 days.
  SELECT * INTO v_merge_row
    FROM audit_log
   WHERE action = 'players.merge' AND p_player_id = ANY(subject_ids)
   ORDER BY created_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no merge to undo' USING errcode='45404', detail=jsonb_build_object('code','UNMERGE_NO_HISTORY');
  END IF;
  IF v_merge_row.created_at < now() - interval '7 days' THEN
    RAISE EXCEPTION 'undo window expired' USING errcode='45403',
      detail=jsonb_build_object('code','UNMERGE_WINDOW_EXPIRED','message','The 7-day undo window has expired. Contact the admin runbook.');
  END IF;

  UPDATE players SET merged_into_player_id = NULL, updated_at = now() WHERE id = p_player_id;

  INSERT INTO audit_log (id, group_id, actor_user_id, action, subject_table, subject_ids, before, after, request_id)
  VALUES (gen_uuid_v7(), v_group, v_actor, 'players.unmerge', 'players',
          ARRAY[p_player_id], v_merge_row.after, jsonb_build_object('restored', true), gen_uuid_v7());

  PERFORM enqueue_stat_refresh(v_group, NULL);
END $$;
```

### 7.5 The rest, by sketch

The remaining RPCs follow the same shape (auth check → mutate → audit_log → stat refresh enqueue). Sketches:

- **`admin_reject_join_request(p_request_id, p_note)`** — sets `status='rejected'`, `decided_by_user_id`, `decided_at`, `decided_note`. Writes `join_request.reject` audit.
- **`admin_merge_players(p_target_user_id, p_guest_player_ids[])`** — resolves `p_target_user_id` to the linked canonical `players` row in each guest's group; loops `internal_merge_player`. Enqueues stat refresh per group touched.
- **`season_backfill_by_date_range(p_season_id)`** — `INSERT INTO session_seasons (session_id, season_id, group_id) SELECT s.id, ssn.id, s.group_id FROM sessions s JOIN seasons ssn ON ssn.id = p_season_id AND ssn.group_id = s.group_id WHERE s.played_on BETWEEN ssn.starts_on AND ssn.ends_on AND s.deleted_at IS NULL ON CONFLICT DO NOTHING`. Writes one `season.backfill` audit row with the count. Trigger §8.2 enqueues the refresh.
- **`refresh_stats_snapshots(p_group_id, p_season_id DEFAULT NULL)`** — §9.
- **`leave_group(p_group_id)`** — `IF role_in_group(p_group_id) = 'owner' AND (SELECT COUNT(*) FROM group_members WHERE group_id = p_group_id AND role='owner' AND left_at IS NULL) = 1 THEN RAISE 'sole owner' …`. Otherwise `UPDATE group_members SET left_at = now() WHERE group_id = p_group_id AND user_id = auth.uid()`. Audit `group_members.leave`.
- **`rotate_invite_code(p_group_id)`** — generates a 12-char base32 code, updates `groups`, audit `group.invite_rotate`.
- **`transfer_ownership(p_group_id, p_new_owner_user_id)`** — owner-only; target must be live member; in one txn demote current owner to `admin` and promote target to `owner`. Audit `group.ownership_transfer`. Notify target via the in-app indicator (§13 of identity-permissions.md). No two-step accept flow — per [identity-permissions.md](identity-permissions.md) §10.

### 7.6 Error-code catalog

| SQLSTATE | Code | Used by |
|---|---|---|
| `45401` | `UNAUTHENTICATED` | every RPC, when `auth.uid()` is NULL |
| `45403` | `FORBIDDEN` | role check failures |
| `45403` | `MERGE_CROSS_GROUP` | guest and target in different groups |
| `45403` | `UNMERGE_WINDOW_EXPIRED` | unmerge past 7 days |
| `45404` | `INVITE_INVALID` | `redeem_invite` |
| `45404` | `REQUEST_NOT_FOUND` | approve/reject |
| `45404` | `PLAYER_NOT_FOUND` | merge |
| `45404` | `UNMERGE_NO_HISTORY` | unmerge with no audit row |
| `45409` | `ALREADY_MEMBER` | `redeem_invite` for existing member |
| `45409` | `JOIN_REQUEST_PENDING` | duplicate pending |
| `45409` | `REQUEST_NOT_PENDING` | approve/reject a decided request |
| `45409` | `PLAYER_LINKED` | merging an already-linked player |
| `45409` | `PLAYER_MERGED` | merging an already-merged player |
| `45409` | `SOLE_OWNER` | sole owner trying to leave |

Client switch logic uses `code`; user-facing copy reads `detail.message`.

---

## 8. Triggers

### 8.1 `tg_set_updated_at`

Boilerplate: `BEFORE UPDATE`, sets `NEW.updated_at = now()`. Applied to every table with `updated_at`. Function defined once; created per-table by migration.

### 8.2 `tg_session_settled_enqueue`

Fires on `sessions` UPDATE when status transitions to `settled`. Enqueues a stat-refresh row for the group and for every season attached via `session_seasons`.

```sql
CREATE FUNCTION public.tg_session_settled_enqueue() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'settled' THEN
    NEW.settled_at := now();
    PERFORM enqueue_stat_refresh(NEW.group_id, NULL);
    -- Loop through attached seasons via the helper so partial-unique conflicts are absorbed.
    -- (A bare INSERT … SELECT … ON CONFLICT DO NOTHING would need to name the partial index.)
    PERFORM enqueue_stat_refresh(NEW.group_id, ss.season_id)
      FROM session_seasons ss WHERE ss.session_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tg_session_settled_enqueue
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION tg_session_settled_enqueue();
```

`enqueue_stat_refresh` is a tiny helper that inserts into `pending_stat_refresh` honoring the partial unique index:

```sql
CREATE FUNCTION public.enqueue_stat_refresh(p_group_id uuid, p_season_id uuid) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO pending_stat_refresh (group_id, season_id) VALUES (p_group_id, p_season_id)
  ON CONFLICT DO NOTHING;
$$;
```

### 8.3 `tg_session_seasons_enqueue`

Fires on INSERT or DELETE; enqueues a refresh for the affected `(group_id, season_id)`. Covers `season_backfill_by_date_range` and manual season-attach UIs.

```sql
CREATE FUNCTION public.tg_session_seasons_enqueue() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM enqueue_stat_refresh(NEW.group_id, NEW.season_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM enqueue_stat_refresh(OLD.group_id, OLD.season_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER tg_session_seasons_enqueue
  AFTER INSERT OR DELETE ON session_seasons
  FOR EACH ROW EXECUTE FUNCTION tg_session_seasons_enqueue();
```

---

## 9. Stats pipeline

### 9.1 `pending_stat_refresh` mechanics

- Triggers (§8) and RPCs (§7) call `enqueue_stat_refresh(group, season|null)`.
- Partial unique index `uq_pending_stat_refresh_open` collapses repeated enqueues into one open row per `(group, season)`. Season-NULL gets its own partial-unique for the group-wide row.
- A cron Edge Function `drain-stat-refresh` runs **every 60 seconds**, claims open rows in batches, calls `refresh_stats_snapshots(group, season)`, marks the row `processed_at = now()` on success. On failure, the row stays open and the Edge Function reports the error to Sentry.

### 9.2 `drain-stat-refresh` (Edge Function contract)

```ts
// supabase/functions/drain-stat-refresh/index.ts (sketch)
serve(async () => {
  const claimed = await sb.rpc('claim_stat_refresh_batch', { p_limit: 50 });
  for (const row of claimed) {
    try {
      await sb.rpc('refresh_stats_snapshots',
        { p_group_id: row.group_id, p_season_id: row.season_id });
      await sb.rpc('mark_stat_refresh_processed',
        { p_group_id: row.group_id, p_season_id: row.season_id, p_enqueued_at: row.enqueued_at });
    } catch (err) {
      Sentry.captureException(err, { tags: { group_id: row.group_id, season_id: row.season_id } });
    }
  }
});
```

Three helper SQL functions back this: `claim_stat_refresh_batch(p_limit)` (returns + locks rows via `SELECT … FOR UPDATE SKIP LOCKED LIMIT`), `mark_stat_refresh_processed(...)`, and the main `refresh_stats_snapshots(...)`. Concurrency is safe because `SKIP LOCKED` ensures one drainer claims a given row.

Cron is configured via Supabase Dashboard (`pg_cron` extension): `SELECT cron.schedule('drain-stat-refresh','* * * * *', $$ … $$);` — see §14 for the manual setup step.

### 9.3 `stats_snapshots.payload` shape (v1)

```jsonc
{
  "version": 1,
  "leaderboards": {
    "pnl_lifetime": [        // for group-wide rows (season_id IS NULL); per-canonical-player
      { "player_id": "<uuid>", "display_name": "…", "linked_user_id": "<uuid|null>",
        "pnl": "+128.50", "sessions_played": 17, "biggest_single_night": "+95.00" }
    ],
    "pnl_season":   [        // present only for season-specific rows
      { /* same shape as pnl_lifetime, scoped to season */ }
    ],
    "most_played":  [        // top 10 by sessions_played
      { "player_id": "…", "display_name": "…", "sessions_played": 17 }
    ],
    "biggest_single_night": [ // top 10 single-session pnl
      { "player_id": "…", "display_name": "…", "session_id": "…", "played_on": "2026-04-12", "pnl": "+95.00" }
    ]
  },
  "summary": {
    "sessions_count": 23,
    "attendance_avg": 6.4,
    "avg_pot": "324.50",        // sum of buyins * rate / sessions_count
    "currency": "£"
  }
}
```

`version` is read by the client; a shape change bumps the version and the client keeps a small `v1 → v2` adapter. Old snapshots stay readable until the next refresh overwrites them.

### 9.4 `refresh_stats_snapshots` body

Sketch (full SQL in `supabase/migrations/0006_stats_pipeline.sql`):

```sql
CREATE FUNCTION public.refresh_stats_snapshots(p_group_id uuid, p_season_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_payload jsonb;
BEGIN
  IF NOT is_member(p_group_id) THEN
    RAISE EXCEPTION 'forbidden' USING errcode='45403', detail=jsonb_build_object('code','FORBIDDEN');
  END IF;

  -- Build the JSONB payload from v_session_player_pnl + sessions + (optionally) session_seasons.
  -- Two CTEs: one for the session set (group-wide vs season-filtered), one for the per-player aggregate.
  -- Top-level rules:
  --   * lifetime / group-wide stats aggregate sessions directly
  --   * season stats join through session_seasons
  -- See top-level §4.5 invariant.
  WITH session_set AS (
    SELECT s.id, s.played_on, s.group_id
      FROM sessions s
      LEFT JOIN session_seasons ss ON ss.session_id = s.id
     WHERE s.group_id = p_group_id
       AND s.deleted_at IS NULL
       AND s.status = 'settled'
       AND (p_season_id IS NULL OR ss.season_id = p_season_id)
  ),
  per_player AS (
    SELECT v.player_id,
           SUM(v.pnl) AS pnl,
           COUNT(DISTINCT v.session_id) AS sessions_played,
           MAX(v.pnl) AS biggest_single_night
      FROM v_session_player_pnl v
      JOIN session_set ss ON ss.id = v.session_id
     GROUP BY v.player_id
  )
  -- … assemble JSONB via jsonb_build_object + jsonb_agg, populate v_payload …

  -- Two upsert branches because ON CONFLICT can name only one partial unique index per statement.
  IF p_season_id IS NULL THEN
    INSERT INTO stats_snapshots (id, group_id, season_id, payload, computed_at)
    VALUES (gen_uuid_v7(), p_group_id, NULL, v_payload, now())
    ON CONFLICT (group_id) WHERE season_id IS NULL
      DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
  ELSE
    INSERT INTO stats_snapshots (id, group_id, season_id, payload, computed_at)
    VALUES (gen_uuid_v7(), p_group_id, p_season_id, v_payload, now())
    ON CONFLICT (group_id, season_id) WHERE season_id IS NOT NULL
      DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
  END IF;
END $$;
```

### 9.5 What does *not* live in this pipeline

Session-detail screens (B4) read P/L *live* from `v_session_player_pnl`. The snapshot powers only group- and season-level leaderboards (B7–B10). Edits to a settled session show on the session page immediately; only the leaderboards lag until the next refresh.

---

## 10. audit_log shape, retention, and rollup

### 10.1 Shape

One row per logical action. `subject_ids` is a uuid array because a single action (e.g. approve with three guests merged) names multiple subjects. `before` / `after` are JSONB; for multi-subject actions, the payloads are keyed by subject id (e.g. `{"guest_a_uuid": {...}, "guest_b_uuid": {...}}`).

`request_id` correlates the audit row with the originating RPC call, used by Sentry tags (§13 of top-level-design.md).

### 10.2 Retention

The rollup runs **daily, before** the delete, in the same Edge Function. This avoids the "row falls in the gap between monthly rollup and daily delete" loss path: every raw row gets at least one rollup pass before it is eligible for deletion.

- **`audit-retention-daily`** (cron `0 3 * * *`): two statements, in order, in one txn.

  Step 1 — roll up the *aging* slice (older than 40 days) into the monthly aggregate, idempotent on the conflict key. `event_count` is the **MAX**, not the sum, so repeated daily runs don't double-count.
  ```sql
  INSERT INTO audit_log_monthly (group_id, bucket_month, action, subject_table, event_count, actor_user_ids)
  SELECT group_id, date_trunc('month', created_at)::date, action, subject_table,
         COUNT(*), array_agg(DISTINCT actor_user_id)
    FROM audit_log
   WHERE created_at < now() - interval '40 days'
     AND created_at >= now() - interval '55 days'
   GROUP BY 1,2,3,4
  ON CONFLICT (group_id, bucket_month, action, subject_table)
    DO UPDATE SET event_count   = GREATEST(audit_log_monthly.event_count, EXCLUDED.event_count),
                  actor_user_ids = (
                    SELECT array_agg(DISTINCT u) FROM unnest(audit_log_monthly.actor_user_ids || EXCLUDED.actor_user_ids) u
                  );
  ```

  Step 2 — delete raw rows older than 55 days. Every row deleted here was rolled up by the same Edge Function on an earlier day (because the rollup window `[40d, 55d)` overlaps with the delete window `[55d, ∞)` daily).

  ```sql
  DELETE FROM audit_log WHERE created_at < now() - interval '55 days';
  ```

  The function also logs deleted-row count to Sentry breadcrumb.

- **`audit-retention-monthly-cleanup`** (cron `0 4 1 * *`): drops `audit_log_monthly` rows older than 12 months. Pure cleanup; no rollup work.

> **The boundary the user sees.** Within 55 days, raw rows are intact and the dev's runbook (operations.md) can replay anything. Beyond 55 days, only counts + actor sets remain; specific `before`/`after` payloads are gone. Identity-permissions.md §3.6 calls this out for users asking to undo old merges; the 7-day `admin_unmerge_player` RPC window sits comfortably inside.

**What is preserved:** The destructive-flow runbooks (lost session edit, mis-merged guest, invite-code leak — top-level §12) all act within the 55-day raw window. The 12-month aggregate is for usage/audit reporting, not for replay.

**What is dropped:** Detailed unmerge / un-edit replays beyond 55 days. The `admin_unmerge_player` RPC's 7-day window comfortably fits.

---

## 11. Migrations

### 11.1 Files

```
supabase/migrations/
  0001_extensions_enums_helpers.sql     -- uuid-ossp/pgcrypto, gen_uuid_v7, enums
  0002_schema_core.sql                  -- users, groups, group_members, players, seasons
  0003_schema_sessions.sql              -- sessions, session_seasons, session_players, buyins, cashouts, dinners, dinner_shares, families, family_members
  0004_schema_identity_admission.sql    -- group_join_requests, audit_log, audit_log_monthly
  0005_schema_stats.sql                 -- stats_snapshots, pending_stat_refresh
  0006_views.sql                        -- live_*, effective_players, v_session_player_pnl, v_group_member_pnl, v_my_pnl_personal
  0007_helpers.sql                      -- role_in_group, is_member, can_edit_session
  0008_rls_policies.sql                 -- the ~50 CREATE POLICY statements (§6)
  0009_triggers.sql                     -- tg_set_updated_at (per table), tg_session_settled_enqueue, tg_session_seasons_enqueue
  0010_rpc_identity.sql                 -- tg_on_auth_user_created (auth.users → public.users), create_group, redeem_invite, admin_approve_join_request, admin_reject_join_request, internal_merge_player, admin_merge_players, admin_unmerge_player
  0011_rpc_admin.sql                    -- season_backfill_by_date_range, refresh_stats_snapshots, leave_group, rotate_invite_code, transfer_ownership
  0012_cron_helpers.sql                 -- claim_stat_refresh_batch, mark_stat_refresh_processed; cron.schedule calls (manual confirmation in §14)
```

### 11.2 Backward-compat rule

Every migration must be safely runnable while the previous code release is still serving traffic. The pattern: **add nullable → backfill → enforce non-null in next release**. Concretely:

- New column: add as nullable (or with default), deploy code, then backfill via Edge Function or SQL, then enforce `NOT NULL` in next migration.
- Dropping a column: stop writing it (code release), then drop (next migration).
- Type change on a column with data: add new column, dual-write, backfill, swap, drop old.

This rule enables one-click rollback of code without invalidating data.

### 11.3 CI flow

- On PR: `supabase db reset` against the `staging` Supabase project clone (a dedicated `ci` project), run all migrations, run pgTAP, run a seed script + smoke read per table.
- On merge to `main`: CI applies new migrations to `staging`, runs pgTAP again.
- On tag `v*`: CI applies migrations to `prod`. A `--dry-run` step (`supabase db push --dry-run`) is mandatory before the apply.

A rejected migration on CI fails the PR. There is no "fix forward in production" exception — wrong migrations are rewritten as new migrations.

### 11.4 Rollback policy

True data rollback is not attempted on prod. PITR (top-level §12) covers catastrophe. For schema issues, forward-fix: a new migration that reverses the bad change while preserving data.

---

## 12. pgTAP coverage matrix

The pgTAP suite is the policy-engine regression contract. Every D6 row × 4 roles, every invariant, every state machine transition gets a test. Suite lives in `supabase/tests/`. Runs in CI via `supabase test db`.

### 12.1 Test fixture (`fixtures.sql`)

Created by seed script (§13), consumed by every test file:

- One `groups` row "Tuesday Crew".
- Four user fixtures: `owner_user`, `admin_user`, `host_user`, `member_user`.
- One `guest_player_attached_to_member_user` to test merge.
- One signed-out scenario (using `SET LOCAL request.jwt.claim.sub = NULL` to simulate `auth.uid() = NULL`).
- One second group "Weekend Crew" with `owner_user` as owner — used for cross-group tests (member of A cannot read B).
- Two sessions in "Tuesday Crew" (one `draft`, one `settled`), three players each, buyins, one dinner, cashouts.

### 12.2 Test matrix

For each table T and each role R ∈ {owner, admin, host, member, signed-out, member-of-other-group}:

1. **SELECT visibility** — does role R see rows it should and not see rows it shouldn't?
2. **INSERT permission** — can R insert? Should R be able to?
3. **UPDATE permission** — can R update? Allowed columns only?
4. **Soft-delete** — can R set `deleted_at`? Should R be able to?
5. **Hard-delete** — confirm no role can hard-delete (only happens via Supabase dashboard / migration).

Plus the explicit invariant tests:

| Test name | What it pins |
|---|---|
| `t_session_create_requires_host_eligibility` | `member` INSERT into `sessions` fails; `host`/`admin`/`owner` succeeds. |
| `t_session_edit_host_or_admin` | host of the night can UPDATE; member cannot; admin can. |
| `t_soft_deleted_session_invisible_under_every_role` | After `UPDATE sessions SET deleted_at = now()`, every role's SELECT returns 0 rows for that id. |
| `t_cross_group_isolation` | Member of group A cannot SELECT / INSERT / UPDATE / DELETE any row scoped to group B. |
| `t_join_request_approval_atomicity` | Calling `admin_approve_join_request` with a merge that fails (e.g. already-linked guest) rolls back the admission too. |
| `t_join_request_no_duplicate_pending` | Calling `redeem_invite` twice for the same group raises `JOIN_REQUEST_PENDING`. |
| `t_multi_season_no_double_count` | A session in two seasons contributes to both B7 totals but only once to B8. |
| `t_dinner_excluded_from_pnl` | `v_session_player_pnl.pnl` for a player who paid for dinner equals `cashout - buyin` (no `paid` term). |
| `t_settlement_includes_dinner` | The client-side formula `pnl - dinner_share + dinner_paid` matches a known fixture (cross-checked against the ported TS calc). |
| `t_ownership_non_orphanable` | Sole `owner` calling `leave_group` raises `SOLE_OWNER`. |
| `t_leave_group_non_owner` | `member_user`, `host_user`, `admin_user` each call `leave_group` and succeed; `group_members.left_at` is set; subsequent reads of group-scoped tables return 0 rows. |
| `t_merge_does_not_alter_session_detail` | After merging a guest into a user-linked player, raw `players` reads (the session-detail path) still return the guest's original `display_name` on rows from before the merge. |
| `t_user_rename_does_not_alter_session_detail` | After `UPDATE users SET display_name = '…'`, session-detail reads still show the player's frozen `players.display_name` from when they were added; stats views (joined through `users`) show the new name. Pins the dual display-name contract (identity-permissions.md §3.5). |
| `t_role_change_owner_only` | `admin` UPDATE on `group_members.role` is rejected; `owner` succeeds. |
| `t_discoverability_owner_only` | `admin` UPDATE that touches `groups.discoverability` is rejected; `owner` succeeds. |
| `t_unmerge_within_7_days` | Merge → unmerge within 7d succeeds; merge backdated 8d → unmerge raises `UNMERGE_WINDOW_EXPIRED`. |
| `t_settle_trigger_enqueues_refresh` | `UPDATE sessions SET status='settled'` produces 1 group-wide + 1 per-season row in `pending_stat_refresh`. |
| `t_view_inventory_no_multi_group` | A *runtime* check, not a catalog inspection: fixture seeds two groups, then for every view in the `v_*` and `live_*` namespace, asserts that calling the view under a member of group A returns zero rows that reference group B. Implementation: a loop over `information_schema.views` filtered by schema/name pattern; for each view, `EXECUTE format('SELECT count(*) FROM %I WHERE group_id = $1', view_name) USING group_b_id` impersonated as member_user. Any non-zero count fails the test. This catches policy holes and view definitions that join across groups; it does NOT catch views that don't expose `group_id` explicitly (those are reviewed manually when added). |

The matrix totals ~80–100 test functions. Each is short (<20 lines). CI failure on any single test blocks the PR.

### 12.3 Migration smoke

In addition to pgTAP, the PR CI runs a "fresh build" smoke:

1. `supabase db reset` against the CI Postgres.
2. Apply all migrations.
3. Run `seed.sql`.
4. `SELECT count(*) FROM <every table>` to ensure RLS doesn't blank-screen a fresh app under each fixture role.
5. Call each RPC once with valid args; assert SQLSTATEs on invalid args.

Failure fails the PR.

---

## 13. Test data / seed

`supabase/seed.sql` populates the fixture set (§12.1) and is shared by:

- `supabase db reset` for local dev — runs automatically.
- pgTAP suite — included as the first step.
- Migration smoke in CI — same script.

The seed is idempotent (uses `ON CONFLICT DO NOTHING`) and uses deterministic UUIDs derived from a fixed namespace so tests can hard-code ids.

The *behavior contract* the fixtures must satisfy (which user does which scenario) is owned by [identity-permissions.md](identity-permissions.md) §13. This doc owns the SQL.

---

## 14. Execution plan

Bucketed into **code changes**, **platform setup**, and **manual input**. Sequenced against top-level §15 phases.

### Phase 0 — Foundation (DB)

**Code changes (PRs in this order):**

1. **`PR-0.1` Repo scaffolding.** Add `supabase/` directory; commit `config.toml`, empty `migrations/`, `tests/`, `functions/` folders. Add `Makefile` targets `db-reset`, `db-test`, `gen-types`.
2. **`PR-0.2` Migrations 0001–0011** (everything in §11.1 except the cron schedules). Each table, view, helper, policy, RPC, trigger.
3. **`PR-0.3` pgTAP suite skeleton** + the highest-value invariant tests (`t_cross_group_isolation`, `t_session_create_requires_host_eligibility`, `t_join_request_approval_atomicity`, `t_ownership_non_orphanable`).
4. **`PR-0.4` Seed + migration smoke** wired into CI (GitHub Actions: spin up Postgres in container, apply migrations, run pgTAP).
5. **`PR-0.5` Edge Function `drain-stat-refresh`** + `claim_stat_refresh_batch` / `mark_stat_refresh_processed` helpers. Cron schedule registered in migration `0012_cron_helpers.sql` (idempotent via `cron.schedule` returning the job id if it exists).
6. **`PR-0.6` Edge Functions `audit-retention-daily` (rollup-then-delete) and `audit-retention-monthly-cleanup` (drops aggregates > 12 months).**

**Platform setup:**

- Create three Supabase projects: `poker-night-local-dev` (used by `supabase start` locally), `poker-night-staging`, `poker-night-prod`. Note: Supabase free tier permits two paid-feature projects max; provision `local-dev` as a CLI-only project (no dashboard project needed).
- Enable extensions in each: `pgcrypto`, `pg_cron`, `citext`. (Dashboard → Database → Extensions.)
- Configure project secrets: `SUPABASE_SERVICE_ROLE_KEY` for each Edge Function via `supabase secrets set`.
- Create staging + prod databases' initial migration runner credential and store in GitHub Actions secret `SUPABASE_ACCESS_TOKEN`.

**Manual input required:**

- **Decide initial group invite-code format**: confirm 12 char base32 (recommended) vs 6-digit numeric. Defaults to base32.
- **First-owner bootstrap.** Decide whether the first signed-in user auto-becomes owner of a newly-created group (proposed default: yes, via the `create_group` RPC — sketched in identity-permissions.md but reaches into `groups` and `group_members` here).

### Phase 1 — Session parity (DB)

No new schema; the live-session tables (`sessions`, `buyins`, `cashouts`, `dinners`, `dinner_shares`, `families`, `family_members`, `session_players`) ship in Phase 0 but their RPCs and policies *exercise* against real clients here.

**Code changes:**

7. **`PR-1.1` Edge Function `health`** (200 OK + DB ping) for the Better Stack monitor (top-level §10).
8. **`PR-1.2`** Extra pgTAP for session-write paths now that the client exercises them: `t_settle_trigger_enqueues_refresh`, `t_session_edit_host_or_admin`, soft-delete visibility per session-child table.

**Platform setup:**

- pg_cron schedules are defined in `0012_cron_helpers.sql` as `cron.schedule(...)` calls (idempotent: re-applying the migration is a no-op via `WHERE NOT EXISTS` on `cron.job`). Per-env verification: open Supabase Dashboard → Database → Cron Jobs and confirm `drain-stat-refresh` (every minute), `audit-retention-daily` (03:00 UTC), `audit-retention-monthly-cleanup` (04:00 UTC, day 1).
- Sentry: enable backend project, integrate the Edge Function SDK, confirm `mutation_id` + `session_id` tags propagate.

**Manual input required:**

- None.

### Phase 2 — History + groups (DB)

**Code changes:**

9. **`PR-2.1` Add `t_multi_season_no_double_count`, `t_view_inventory_no_multi_group`, `t_settlement_includes_dinner`, `t_dinner_excluded_from_pnl`** pgTAP tests now that stats are about to ship.
10. **`PR-2.2` Validate `season_backfill_by_date_range`** with a fixture-driven pgTAP test.

**Platform setup:**

- None.

**Manual input required:**

- None.

### Phase 3 — Stats + sharing + direct admin merge (DB)

**Code changes:**

11. **`PR-3.1` Finalize `refresh_stats_snapshots`** body (§9.4) including JSONB assembly. Add `t_stats_snapshot_shape_v1` pgTAP that asserts the produced JSON validates against a fixture-locked schema.
12. **`PR-3.2`** Add `t_unmerge_within_7_days`, `t_role_change_owner_only`, `t_discoverability_owner_only` pgTAP tests.

**Platform setup:**

- Enable Sentry session-replay project (privacy-masked) — *deferred to post-v1 per top-level §10*; no DB work.

**Manual input required:**

- None.

### Phase 4 — Identity reconciliation polish (DB)

No new schema; behavior tests intensify.

**Code changes:**

13. **`PR-4.1`** Add comprehensive `audit_log` shape tests: every RPC produces an audit row of the expected `action` with expected `subject_ids`.
14. **`PR-4.2`** Add the matrix coverage gap fillers: every (table × role) cell that wasn't pinned in Phases 0–3.

**Platform setup:**

- Confirm 7-day PITR window is active on the prod project (Supabase Pro plan setting).
- Configure billing alerts at 50% of free tier on Supabase, Vercel, Sentry, EAS — see top-level §10. (DB-side: Supabase only; rest covered in [operations.md](operations.md).)
- Configure weekly logical-dump cron (Edge Function or external) to Backblaze B2.

**Manual input required:**

- **B2 bucket creation + credentials** stored in `SUPABASE_SECRETS` for the dump Edge Function.
- **PITR plan upgrade**: confirm Supabase Pro for prod project ($25/month) — single human decision.

### Cross-phase manual checks

- After every migration apply to prod, run the `--dry-run` step and review the diff in the PR description before tagging.
- Confirm `auth.users` row is created on every sign-in (manual smoke per provider once at launch).

---

## References

- [docs/architecture/top-level-design.md](top-level-design.md) — top-level architecture
- [docs/spec/features.md](../spec/features.md) — feature catalog (B1–B11, C-series, D4, D6–D8, decisions 1, 2, 6, 7)
- [docs/spec/overview.md](../spec/overview.md) — product principles
- [identity-permissions.md](identity-permissions.md) — sibling: auth, identity flows, the behavioral contract this doc realizes
- [frontend.md](frontend.md) — sibling: client-side data access patterns
- [productionization.md](productionization.md) — sibling: CI/CD beyond DB migrations
- [operations.md](operations.md) — sibling: backup drills, runbooks, alerting on DB metrics
- [TECHNICAL_DESIGN.md](../../TECHNICAL_DESIGN.md) §7 — prototype's data-model sketch (superseded by §3)

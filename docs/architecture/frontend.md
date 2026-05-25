# Poker Night — Frontend Design

**Status:** Skeleton (to be filled in) · **Date:** 2026-05-17 · **Scope:** Expo client architecture (iOS / Android / Expo Web) including screen graph, the native vs. web role split, offline mutation queue, state management, and the calc module port.

## Context

One Expo + React Native codebase compiles to three targets. Native (iOS / Android) is the canonical surface for the entire product — including admin work (claim approvals, group/season management, leaderboards, role promotion). Web (Expo Web) ships from the same codebase as a desktop convenience surface with no functional partition: same screens, same navigation, same UX (top-level §3.1). The non-trivial work in this layer: keeping the calc port pure and shared verbatim across all three targets; an on-device mutation queue that turns server-authoritative writes into a glance-and-tap experience under bad networks (top-level §5); rendering the new `host` role gate on session-create such that play-only members get a clear "ask the owner" message rather than a disabled button (risk #12); and the regression contract — the prototype's six-tab session UX (A1–A17) carries forward without functional change.

## Goals

When complete, this doc will cover:

- The full screen graph (all screens render on every target by default): live session six tabs, group/season management, history browse, session detail/edit, claim approval queue, role-management screen for owner-only promote/demote, stats/leaderboards. Native-only edge cases (push settings, camera capture) are post-v1 and isolated to platform-specific files.
- Expo Router file-layout convention: shared routes are the default; `.native.tsx` / `.web.tsx` suffixes reserved only for the narrow API-divergence cases above. No per-platform UX decisions to make for routine screens.
- The session-create gate UX: `member` users see a clear "you are not host-eligible — ask the owner to promote you" message on the create-session entry point, not a hidden or disabled control (risk #12). Surfaces same on every target.
- The TS-ported calc module structure: `pnl_per_player_per_session`, `settlement_amount`, `aggregateForSettlement`, chip-math, pot rebalance — what is shared verbatim from `app/src/calc/` and what is split per top-level §4.4.
- TanStack Query usage: cache keys per entity, invalidation graph on mutations, the bridge between optimistic updates and the queue.
- Zustand stores for transient UI state (active session tab, draft form state) and how that state survives a process kill.
- Offline mutation queue design: envelope (`{mutation_id, entity, op, payload, created_at}`), expo-sqlite persistence, background flush worker, retry policy, dedupe by `mutation_id`, surfacing of permanently-failed mutations.
- Realtime usage: the *spectator view* subscription model (top-level §5) — which channels, which screens, fallback when offline.
- Auth integration on the client: Supabase JS SDK + Expo AuthSession, the `redeem_invite` entry that creates a pending `group_join_requests` row, post-redemption routing to a "waiting for admin review" screen (top-level §6.1), and the in-app indicator that surfaces the admin's decision on next sign-in. **The user never sees a guest-record picker** — that UI lives on the admin's join-approval screen, not the new user's flow.
- NativeWind styling conventions, the web-compat shortlist for RN libraries (risk #3), and how to keep a screen from accidentally diverging across targets.
- Tab-badge UX (A15) and the new "Sessions edited since last refresh: N" indicator (risk #5).
- D8 personal-roll-up rendering rules including the conditional "stakes vary" caveat (risk #6).
- The "empty season" warning UI and the entry point to `season_backfill_by_date_range` from a season detail screen (risk #9).
- **Client testing layers** owned here: vitest unit tests for the calc port (`pnl_per_player_per_session`, `settlement_amount`, family aggregation, greedy minimization, chip-math); `fast-check` property tests for settle-to-zero and dinner-out-of-pnl invariants; RNTL + MSW component/store tests (optimistic mutation success, rollback on server reject, queue flush, retry/backoff, permanent-failure surfacing); the Playwright regression contract carried forward from [app/tests/integration/](../../app/tests/integration/); Maestro YAML for native E2E **including at least one approval-queue scenario** (risk #11). The platform-spread rule: a feature touched on more than one target gets a scenario per target.

## Scope

**In scope:**

- All client code under one Expo project: screens, components, stores, hooks, calc port, offline queue, Sentry hookup.
- Per-platform navigation decisions and the rules that govern them.
- Optimistic UI behavior and how it surfaces failures.

**Out of scope:**

- RLS policy detail, RPC signatures, schema — covered by [db-backend.md](db-backend.md).
- The Vercel + EAS pipeline and OTA update governance — covered by [productionization.md](productionization.md).
- Auth provider configuration and the policy side of claim/join — covered by [identity-permissions.md](identity-permissions.md); this doc owns only the screens and client routing.
- pgTAP coverage matrix and migration smoke — covered by [db-backend.md](db-backend.md). This doc owns the client-facing test layers (vitest, RNTL, Playwright, Maestro).
- CI test orchestration and merge gates — covered by [productionization.md](productionization.md).
- On-call surfaces and Sentry alerting rules — covered by [operations.md](operations.md); this doc owns the client-side Sentry tagging contract (mutation_id, session_id).

## Anchors in the top-level architecture

This doc operationalizes the following sections of [top-level-design.md](top-level-design.md):

- §3 — Architecture overview, the components block diagram.
- §3.1 — Native is the canonical surface; web is a same-codebase mirror.
- §4.5 — Session-creation host-eligibility invariant.
- §5 — Sync, offline, and write semantics (the mutation queue).
- §6.1 — Invite-driven join + admin-merge flow (UX defaults for both the new-user "waiting" screen and the admin search-and-pick approval card).
- §8 — Tech choices (Expo, TanStack Query, Zustand, NativeWind, expo-sqlite).
- §13 — What we preserve from the prototype (six-tab UX, calc, badges).
- Risks #3, #5, #6, #12 — Web-compat shims, stale-stats indicator, D8 caveat, host-role friction.

## Open questions to resolve

- Exact division of state between TanStack Query cache and Zustand: where do mid-edit form drafts live?
- Whether the mutation queue surfaces a per-mutation toast/banner on permanent failure or batches into a single "sync paused" affordance.
- Whether the calc port lives in a top-level `packages/calc/` workspace or under `src/calc/` of the Expo app.
- Whether spectator-view realtime uses Supabase channels per-session or per-group with client-side filtering.
- Whether the desktop web experience picks up any optional polish (keyboard shortcuts, hover affordances) or strictly mirrors the touch UX.
- How the session-create gate is surfaced for `member` users: a banner on the home screen vs. a dialog on tap vs. inline empty-state text.
- Whether the admin's join-approval card defaults to a quick-approve-no-merge button (one tap) and surfaces the search-and-pick picker as a secondary expand, or always shows the picker.
- What the new user sees on the "waiting for admin review" screen: read-only group preview, a list of other groups they're already in, or just a status card.

## References

- [docs/architecture/top-level-design.md](top-level-design.md) — top-level architecture
- [docs/spec/features.md](../spec/features.md) — feature catalog (A1–A17, B3–B11, D5, D7, D8)
- [docs/spec/overview.md](../spec/overview.md) — product principles (1 "night-of usability is sacred", 6 "don't lose what works")
- [db-backend.md](db-backend.md) — backend data contracts the client consumes
- [identity-permissions.md](identity-permissions.md) — auth flows and the admin approval/merge policy side
- [app/src/calc/chip-math.js](../../app/src/calc/chip-math.js), [app/src/calc/settlement.js](../../app/src/calc/settlement.js) — prototype calc source
- [app/tests/integration/](../../app/tests/integration/) — Playwright regression contract source

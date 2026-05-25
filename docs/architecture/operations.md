# Poker Night — Operations Design

**Status:** Skeleton (to be filled in) · **Date:** 2026-05-17 · **Scope:** Monitoring, alerting, runbooks, audit-log retention policy, backups, and on-call discipline.

## Context

The product is operated by one developer; the smallest possible response surface that still catches the four classes of incident that genuinely warrant waking someone up is the goal. Top-level §10 picks the four classes (web target down, prod DB CPU saturated, Sentry error rate 3× baseline, auth provider error rate >5%); everything else routes to a morning-coffee email. The non-trivial work: a tiered `audit_log` retention policy (raw 55 days, aggregates 12 months) that keeps the destructive-flow runbooks (mis-merged guest, lost session edit, invite leak) feasible without unbounded storage growth; an in-app indicator (risk #5) that nudges users to refresh stats after silent edits because nothing else will; and runbooks for destructive flows that must be drilled, not just written.

## Goals

When complete, this doc will cover:

- The Sentry setup per surface (web, native, Edge Functions), tag conventions (every event tagged with `mutation_id`, `session_id`), and the alert rules that drive the four critical-alert classes.
- Supabase dashboard usage: which dashboards are checked daily, which weekly, slow-query log review cadence.
- The `/health` Edge Function and the Better Stack / Cronitor uptime ping configuration.
- Billing alert thresholds at 50% of free-tier consumption for Supabase, Vercel, Sentry, EAS; what action each triggers.
- Backup strategy: Supabase Pro PITR (7-day) plus weekly logical dump to Backblaze B2 via cron Edge Function; quarterly restore drill checklist.
- The tiered `audit_log` retention policy: daily cron drops raw rows >55 days; monthly cron rolls into `audit_log_monthly`; aggregates older than 12 months drop. The boundary effects this has on runbook reach.
- Runbooks (each a step-by-step a half-asleep developer can follow): lost session edit, mis-merged guest, stale leaderboard, invite-code leak, stuck stat refresh, Supabase auth outage, OTA rollback during an incident.
- On-call discipline: who responds, what counts as critical, the morning-coffee email vs. wake-the-dev threshold, expected response SLAs.
- Cost ceiling tracking: $0–25/mo realistic, $99/yr Apple, $25 Play, ~$15/yr domain — and the scaling-trigger checklist for when free-tier limits approach.
- The "stale stats" indicator as an operational signal (risk #5) and its enforcement that "Sessions edited since last refresh: N" is wired and tested.
- Sentry session-replay deferral policy and audit-log access meta-logging (money is sensitive PII; replay must remain off until privacy masking is verified).

## Scope

**In scope:**

- Runtime monitoring, alerting rules, the on-call decision tree.
- Backup, restore-drill, and retention-policy enforcement.
- Runbooks for the destructive flows and the runtime symptoms developers will encounter.
- Cost monitoring and the scaling-trigger checklist.

**Out of scope:**

- CI, environments, the rollback *pipeline*, store submission — covered by [productionization.md](productionization.md). The rule: ahead-of-time codified config is there; in-the-moment human response is here.
- The schema content of `audit_log` and the SQL of retention crons — covered by [db-backend.md](db-backend.md); this doc owns the *policy* (how long, what survives) and the cron schedule.
- Test orchestration and the regression contract — covered by [frontend.md](frontend.md), [db-backend.md](db-backend.md), and [productionization.md](productionization.md); this doc owns the *production* signal that things broke, not the pre-merge gate.
- Sign-in policy, role-change flows, security-relevant authorization — covered by [identity-permissions.md](identity-permissions.md); this doc owns auth-provider *outage* response.
- Client architecture — covered by [frontend.md](frontend.md).

## Anchors in the top-level architecture

This doc operationalizes the following sections of [top-level-design.md](top-level-design.md):

- §10 — Monitoring & observability (the four alert classes).
- §12 — Operations (backups, retention, runbooks, cost ceiling, scaling triggers).
- §7.1 — The auto-refresh contract whose silent-edit gap is the trigger for the stale-stats indicator (risk #5).
- Risks #4, #5, #10 — Destructive-flow undo windows, stale-stats indicator, discoverability privacy escalator.

## Open questions to resolve

- Whether the 7-day undo window for `admin_unmerge_player` (risk #4) is policy-enforced (rejected after 7 days) or advisory.
- Concrete alert thresholds (e.g. "3× baseline" needs a baseline definition and a time window).
- Whether the weekly Backblaze dump is encrypted at rest with a customer-managed key and where that key lives.
- Quarterly restore-drill format: full restore to a scratch project, or a partial table-level restore verification.
- Whether audit-log access by the admin is itself audited (meta-logging), and how that table is protected from rapid growth.
- Notification channel for alerts: email-only, or also push to a phone (PagerDuty free tier, ntfy, etc.) for the four critical classes.
- Whether the "stale stats" indicator threshold (1 edited session, N edited sessions, time-since-edit?) is configurable per group.

## References

- [docs/architecture/top-level-design.md](top-level-design.md) — top-level architecture
- [docs/spec/features.md](../spec/features.md) — feature catalog (B5, B6, B11, D4, decision 6)
- [docs/spec/overview.md](../spec/overview.md) — product principles (4 "history is permanent")
- [productionization.md](productionization.md) — sibling: ahead-of-time pipelines and rollback config
- [db-backend.md](db-backend.md) — sibling: `audit_log` schema and retention cron SQL
- [identity-permissions.md](identity-permissions.md) — sibling: auth-outage context

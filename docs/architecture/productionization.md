# Poker Night — Productionization Design

**Status:** Skeleton (to be filled in) · **Date:** 2026-05-17 · **Scope:** CI/CD, environments, EAS pipeline, web hosting, migration management, secrets, preview deploys, and rollback per surface.

## Context

A solo developer is shipping three surfaces from one repo: iOS, Android, and Expo Web — each with its own delivery channel (App Store, Play Store, EAS Update OTA, Vercel) — fronted by one of three separate Supabase projects (local, staging, prod). The non-trivial work is keeping those surfaces coherent without an ops team: an RLS bug in staging must not be one env-var flip away from prod (top-level §11 mandates separate projects, not branched DBs); migrations must be backward-compatible for one release so code rollback is safe even though data rollback is not; OTA updates skip store review but still answer to store policy (risk #1); and preview deploys must exist per PR for both web (Vercel) and native (EAS Update channel) so reviewers can actually click through changes.

## Goals

When complete, this doc will cover:

- The three-environment topology: `local` (Supabase CLI + Expo Dev Client), `staging` (Supabase project + Vercel preview branch tied to `main`), `prod` (separate Supabase + Vercel production) — concrete project IDs, URLs, who has access.
- GitHub Actions pipelines: unit + RLS test job, migration-smoke job, web Playwright job against preview, native build job (gated), and the lint/typecheck gates. CI orchestrates the test layers defined in [frontend.md](frontend.md) (vitest, RNTL, Playwright, Maestro) and [db-backend.md](db-backend.md) (pgTAP, migration smoke) — this doc owns *which jobs run on which trigger* and *which gate merge*; the sibling docs own *what's tested*.
- EAS profile definitions (`development`, `preview`, `production`) and the env-var matrix that points each profile at its matching Supabase + Sentry project.
- EAS Update channel strategy per profile and the rule that an OTA update never crosses environments.
- Vercel project setup for Expo Web static export, preview-per-PR wiring, and Sentry source-map upload at build time.
- Migration management: file-naming and ordering convention, the CI step that applies to staging on merge to `main`, the tag-driven promotion to prod, and the backward-compat-for-one-release rule.
- Secrets matrix: Vercel env vars (web), Supabase service-role keys (server-only), EAS Secret (native build-time); the rule that `.env.example` enumerates every required var and no secret is committed. Includes the per-environment OAuth client IDs and redirect URLs (Google, Apple, Supabase magic-link callbacks) — the auth provider *behavior* lives in [identity-permissions.md](identity-permissions.md).
- Rollback playbook per surface (web → Vercel revert; native binary → previous TestFlight build / Play rollback; OTA JS → channel pointer; DB → forward-fix migration only).
- OTA release checklist that respects store policy (the "non-native change only" rule for EAS Update — risk #1).
- App Store and Play Store submission ergonomics: certs, profiles, screenshots, review-lead-time planning (risk #2).
- Domain & SSL config: Cloudflare DNS → Vercel apex + `app.` subdomain.

## Scope

**In scope:**

- Everything that ships code or schema from a developer's laptop to a user's device.
- CI configuration, preview deploys, environment isolation, the rollback playbook.
- Build-time secrets handling and store-submission ergonomics.

**Out of scope:**

- Runtime monitoring, alerting, on-call, backups, runbooks — covered by [operations.md](operations.md). Some overlap is genuine (rollback during an incident is operational); the rule is: anything decided ahead of time and codified in YAML lives here, anything diagnostic or response-time lives there.
- Schema authoring and RLS policy content — covered by [db-backend.md](db-backend.md); this doc owns *how* migrations move between envs, not what they say.
- Test scenarios and coverage targets — covered by [frontend.md](frontend.md) (client layers) and [db-backend.md](db-backend.md) (pgTAP + migration smoke); this doc owns the CI jobs that *run* the tests and gate merges.
- Client architecture decisions like state management or screen graph — covered by [frontend.md](frontend.md).
- Auth-provider *behavior*, OAuth flow handoff, session/token lifetime — covered by [identity-permissions.md](identity-permissions.md). This doc owns the per-environment OAuth client IDs, redirect URLs, and secrets that wire the providers up.

## Anchors in the top-level architecture

This doc operationalizes the following sections of [top-level-design.md](top-level-design.md):

- §3 — Components diagram, build/distribution row at the bottom.
- §8 — Tech choices (EAS Build, EAS Submit, EAS Update, Vercel, Cloudflare, GitHub Actions).
- §11 — Production setup (the full surface this doc owns).
- §15 — Phased rollout (which surfaces ship in which phase, including when the API surface stabilizes at Phase 1).
- Risks #1, #2 — OTA governance and App Store review lead time.

## Open questions to resolve

- Whether `staging` accepts external testers (TestFlight build per merge to `main`) or is dev-only.
- Tag-format convention for the `staging → prod` promotion (e.g. `prod-2026-05-17.1`) and whether promotion is auto on tag-push or one-click in GitHub.
- Whether `supabase db reset` against staging in CI is gated by branch or runs on every PR.
- How EAS Update preview channels are named per PR (e.g. `pr-123`) and how a reviewer joins one without an internal build.
- Whether migrations apply to prod in CI on tag, or via a manual `supabase db push` from a designated maintainer.
- Cloudflare-vs-Vercel responsibility split: which one owns the cert, which one owns redirects.
- Whether Sentry release names are wired to Git SHA, EAS update ID, or both.
- Concrete free-tier limit ceilings that trigger a paid-plan upgrade (top-level §12 cost ceiling is the source).

## References

- [docs/architecture/top-level-design.md](top-level-design.md) — top-level architecture
- [docs/spec/features.md](../spec/features.md) — feature catalog (informational; this doc rarely cites features directly)
- [docs/spec/overview.md](../spec/overview.md) — product principles
- [operations.md](operations.md) — sibling: runtime ops, monitoring, backups
- [db-backend.md](db-backend.md) — sibling: migration content + pgTAP / migration-smoke layers
- [frontend.md](frontend.md) — sibling: client-side test layers run in CI
- [docs/productionization-2026-05-11.md](../productionization-2026-05-11.md) — historical: prototype's GitHub Pages deploy (superseded)

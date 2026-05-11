# Productionization Plan — 2026-05-11

This document is the deployment companion to [refactor-2026-05-11.md](refactor-2026-05-11.md).
The refactor restructured the prototype into a deployable shape under `app/`.
This plan takes that shape and puts it on the public web with automated
deploys and CI tests, assuming the reader has no prior deployment experience.

## Goals

- Live URL on the public web, served free.
- Auto-deploy on every push or merge to `main`.
- Tests run on every pull request, and a deploy never ships if tests fail.
- No external accounts or paid services required.
- Setup achievable in under 30 minutes by a deployment beginner.

## Non-goals

- No custom domain at this stage (`*.github.io` is fine for v1).
- No staging environment or preview deploys per PR (revisit if/when the
  team grows; see "Future: Cloudflare Pages" below).
- No analytics, error reporting, or monitoring.
- No backend, no database, no auth — the product is intentionally static.

## Recommendation: GitHub Pages + GitHub Actions

For this repo's situation — single contributor today, public repo, no
backend, code already on GitHub — **GitHub Pages** is the cleanest fit:

- Free with no meaningful limits at this scale.
- No second account / dashboard / billing surface.
- Native to GitHub: the workflow runs in the same place as the code.
- Automatic HTTPS via Let's Encrypt.
- Auto-deploy reduces to one YAML file in `.github/workflows/`.

An alternative (Cloudflare Pages) is described at the bottom as an option
for v2 if PR preview deploys become valuable.

## What the audit confirmed (state on 2026-05-11)

A code/CI audit was run before writing this plan. Findings worth pinning:

**Deploy-readiness of `app/`:**

- All JS imports in `app/src/**/*.js` are relative (`./`, `../`). No
  absolute paths that would break under a subpath URL like
  `https://capricewyy.github.io/poker_calculator_prototype/`.
- `app/index.html` references `styles.css` and `src/main.js` as relative
  paths; uses `<script type="module">`.
- All inline `onclick=`/`onchange=` handlers are exposed on `window` in
  [app/src/main.js](../app/src/main.js).
- No files or folders start with `_` — Jekyll filtering is not a concern.
- No external network calls (no `fetch`, no CDN scripts, no Google Fonts).
- `localStorage` key `poker_v5` is used; no cross-origin or URL-dependent
  storage logic.
- [app/.gitignore](../app/.gitignore) correctly excludes `node_modules/`,
  `test-results/`, `playwright-report/`, `.playwright/`.

**CI-readiness of the test suite:**

- 11 spec files exist under `app/tests/integration/` — one per documented
  user journey plus a `master-journey.spec.js` covering the full flow end
  to end. This exceeds what the refactor doc promised.
- [app/playwright.config.js](../app/playwright.config.js) already has the
  right CI knobs: a `webServer` block auto-starts `http-server` on port
  8080; reporter switches to `'github'` when `process.env.CI` is set;
  retries are 2 in CI / 0 locally; workers are pinned to 1 in CI; traces
  capture on first retry.
- `npm test` runs `playwright test` cleanly with no `test.only`, no
  `test.skip`, no time/timezone dependencies, no missing `await`s.
- Conclusion: the suite is ready for `npm ci && npx playwright install
  --with-deps chromium && npm test` on `ubuntu-latest` without changes.

**Implication for this plan:** the test workflow is no longer "optional
v2." It can ship now and gate every deploy.

## Architecture of the pipeline

```
Developer
   │
   │  git push  (or PR merge)
   ▼
GitHub `main` branch
   │
   ├──► test.yml workflow (every push + every PR)
   │       1. checkout
   │       2. npm ci  (in app/)
   │       3. playwright install --with-deps chromium
   │       4. npm test
   │           └─ webServer auto-starts http-server on :8080
   │       5. upload playwright-report/ as artifact on failure
   │
   └──► deploy.yml workflow (push to main only, needs: test)
           1. checkout
           2. upload app/ as Pages artifact
           3. deploy-pages → live at *.github.io/<repo>/
```

Total wall-clock time from push to live URL: about 90–120 seconds when
green.

## Part 1 — Files to add (no other code changes)

### 1.1 `.github/workflows/test.yml`

Runs Playwright on every PR and every push. Required so the deploy
workflow can depend on it.

```yaml
name: Tests

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: app
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: app/package-lock.json
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm test
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: app/playwright-report/
          retention-days: 7
```

Notes:

- `working-directory: app` keeps every step rooted in the deployable
  folder.
- `cache: 'npm'` reuses `node_modules` between runs (faster CI).
- The `if: failure()` step uploads the HTML report so flakes can be
  inspected from the Actions UI.
- The job name `test` is what `deploy.yml` will reference.

### 1.2 `.github/workflows/deploy.yml`

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  test:
    uses: ./.github/workflows/test.yml

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./app
      - id: deployment
        uses: actions/deploy-pages@v4
```

Notes:

- `jobs.test.uses: ./.github/workflows/test.yml` runs the same test
  workflow from inside the deploy pipeline. If tests fail, `deploy`
  never runs.
- `concurrency.cancel-in-progress: true` means rapid successive pushes
  to `main` don't fight each other — only the latest deploys.
- `permissions:` is required by `actions/deploy-pages@v4`; the three
  scopes shown are the minimum.
- `workflow_dispatch:` adds a "Run workflow" button in the Actions tab
  for manual redeploys.

### 1.3 `app/.nojekyll` (defensive, optional)

Create an empty file at this path. The audit confirmed no `_`-prefixed
files exist today, so Jekyll filtering is not currently a risk — but
adding this empty file makes the deploy robust against future files that
might start with `_` (e.g., a vendored library).

Trade-off: one extra empty file in the repo vs. silent file-omission
bugs later. Worth it.

### 1.4 Nothing else

- No changes to [app/index.html](../app/index.html).
- No changes to JS modules under [app/src/](../app/src/).
- No changes to [app/styles.css](../app/styles.css).
- No changes to [app/package.json](../app/package.json) (already has
  `"test": "playwright test"`).
- No changes to [app/playwright.config.js](../app/playwright.config.js)
  (already CI-aware).
- No `.env`, no secrets, no API keys.

## Part 2 — One-time GitHub UI setup

These are clicks in the GitHub web UI. About 90 seconds.

1. **Enable GitHub Pages with Actions source.**
   `https://github.com/capricewyy/poker_calculator_prototype/settings/pages`
   → **Build and deployment** → **Source** → choose **GitHub Actions**.
   Do not pick "Deploy from a branch" — that path can't deploy a
   subdirectory cleanly.

2. **Confirm workflow permissions.**
   `Settings → Actions → General → Workflow permissions` → ensure **Read
   and write permissions** is selected. (Default for most accounts.)

3. **Push the workflow files to `main`.**
   Once `.github/workflows/test.yml` and `.github/workflows/deploy.yml`
   are on `main`, the next push triggers the pipeline automatically.

4. **Watch the first run.**
   `https://github.com/capricewyy/poker_calculator_prototype/actions` —
   the deploy run should turn green in ~2 minutes.

5. **Visit the live URL.**
   `https://capricewyy.github.io/poker_calculator_prototype/`
   The Pages settings page will also display this URL once the first
   deploy succeeds.

## Part 3 — Verifying it actually works

Run these checks after the first green deploy:

1. **Actions tab — both jobs green.** Both `test` and `deploy` should
   show checkmarks.
2. **Pages settings — "Your site is live at …" banner present.**
3. **Open the URL in an incognito window** (cache-bypass smoke test).
   Add a player, refresh the page, confirm the player persists. This
   exercises the `localStorage` flow on the real domain.
4. **Test on mobile.** The UI is mobile-first; open the URL on a phone
   before declaring victory.
5. **Open a throwaway PR** that changes one character in
   [app/index.html](../app/index.html). Confirm the `test` workflow
   runs on the PR. Close the PR without merging.

## Part 4 — Daily workflow after setup

- Open a PR → `test.yml` runs on the PR.
- Merge to `main` → `deploy.yml` runs, which itself runs `test.yml` and
  then deploys.
- ~90 seconds after merge, the live URL reflects the new code.
- If something breaks in prod, revert the merge commit on `main`. The
  previous version redeploys automatically.

Branch pushes that don't open a PR still trigger `test.yml` (via
`push:` event) so feature branches get tested too, but nothing deploys
until merge.

## Part 5 — What can go wrong, and what to do

| Symptom | Likely cause | Fix |
|---|---|---|
| `deploy.yml` fails at `upload-pages-artifact` | `path:` doesn't point at a folder with files | Confirm `path: ./app` and that `app/index.html` exists on the branch |
| Pages serves 404 | "Source" is set to "Deploy from a branch" instead of "GitHub Actions" | Switch to GitHub Actions in `Settings → Pages` |
| 404s for `src/main.js` on the live site | Some path was made absolute (`/src/...`) somewhere | Re-run the audit: `grep -rn 'from "/' app/src/ app/index.html` |
| Playwright fails only in CI | Usually browser binary not installed | Confirm the `npx playwright install --with-deps chromium` step ran |
| Deploy succeeds but page is blank | An `import` path is wrong; check the browser console | Console will name the failing module |
| `test.yml` flakes intermittently | A test has a real-time / animation race | Use the uploaded `playwright-report` artifact to see the trace |

## Part 6 — Future: Cloudflare Pages

If/when **per-PR preview deploys** become valuable (e.g. "open this URL
to see what the change looks like before merging"), switching to
Cloudflare Pages is straightforward and stays free:

1. `dash.cloudflare.com` → Pages → Create a project → Connect to Git.
2. Pick the repo. **Framework preset: None**. **Build command: (blank)**.
   **Build output directory: `app`**.
3. Save. Every push to `main` deploys to the production URL; every PR
   gets its own preview URL automatically.

Cloudflare Pages is strictly more capable than GitHub Pages (preview
deploys, faster CDN, built-in analytics, generous free tier), at the
cost of one external account. Netlify and Vercel are equivalent.

Migration cost from GitHub Pages → Cloudflare Pages is ~10 minutes and
doesn't require code changes — only delete `deploy.yml` (keep
`test.yml`) and point Cloudflare at the repo.

## Checklist

**Code (in repo):**

- [ ] Add `.github/workflows/test.yml` (per §1.1)
- [ ] Add `.github/workflows/deploy.yml` (per §1.2)
- [ ] Add empty `app/.nojekyll` (per §1.3)

**GitHub UI (one time):**

- [ ] `Settings → Pages → Source: GitHub Actions`
- [ ] `Settings → Actions → General: Read and write permissions`
- [ ] Push to `main`
- [ ] Watch first Actions run go green
- [ ] Visit `https://capricewyy.github.io/poker_calculator_prototype/`

That is the entire setup. After this, the only operational task is
merging PRs.

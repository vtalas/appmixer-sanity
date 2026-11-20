# Appmixer Sanity Check

A SvelteKit application for tracking the health of [Appmixer](https://www.appmixer.com) connectors: manual sanity-check test runs, E2E test flows with a throttled runner, merge readiness of connector PRs, and Auth Hub bundle management.

**Stack:** SvelteKit 2, Svelte 5, Turso (libSQL), Tailwind CSS, Bits UI. Deployed on Vercel. Google OAuth login; admin-only features gated by email.

See `CLAUDE.md` for the full architecture documentation (data model, modules, internal API routes).

## Pages

| Page                               | Description                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                | Dashboard — list sanity-check test runs, create new ones from a live connector snapshot                                                                                                                                                                                                                                                                    |
| `/test-runs/[runId]`               | Test run detail — connectors with status badges (pending / ok / fail / blocked)                                                                                                                                                                                                                                                                            |
| `/test-runs/[runId]/[connectorId]` | Connector detail — per-component test results, GitHub issue links                                                                                                                                                                                                                                                                                          |
| `/e2e-flows`                       | E2E test flows — GitHub (dev branch) merged with the Appmixer instance state and latest run results; diff, upload, revert, sync-to-PR, and a throttled test runner                                                                                                                                                                                         |
| `/releases`                        | Release — connector versions on appmixer-components `master` (production) against appmixer-connectors `dev`: what needs releasing (new / major / minor / patch), unbumped changes, and a **Release** button (admins) that commits each selected connector as `<connector> <version> (<type>)` to a release branch and opens a `[RELEASE]` PR into `master` |
| `/authub`                          | Auth Hub — browse and manage OAuth connector configs/bundles in the **production or QA** Auth Hub (switcher), verification status per environment, and upload bundles packed straight from GitHub (`appmixer pack` rules, from appmixer-connectors `dev` or appmixer-components `master`), one or many at once                                             |
| `/automation-hub`                  | Automation Hub — Appmixer's own marketplace widget (`appmixer.ui.AutomationHub`) for the configured instance: activate, start/stop and inspect the `appmixer-sanity-hub` integrations (GitHub responders)                                                                                                                                                  |
| `/settings`                        | Per-user overrides for Appmixer / GitHub credentials (take precedence over env values)                                                                                                                                                                                                                                                                     |

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in your values
pnpm run dev
```

### Environment variables

See `.env.example` for the full annotated list. Summary:

| Variable                                                        | Purpose                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`                        | Turso (libSQL) database — **required**                                                                                                                 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_SECRET`       | Google OAuth login — **required**                                                                                                                      |
| `APPMIXER_BASE_URL`, `APPMIXER_USERNAME`, `APPMIXER_PASSWORD`   | Appmixer instance for E2E flows (users can override per-user in `/settings`)                                                                           |
| `SANITY_GITHUB_TOKEN`                                           | GitHub token for the connectors repo (repo scope for private repos)                                                                                    |
| `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` / `GITHUB_REPO_BRANCH` | Connectors repo, defaults `Appmixer-ai/appmixer-connectors@dev`                                                                                        |
| `AUTH_HUB_URL_PROD`, `AUTH_HUB_API_TOKEN_PROD`                  | Production Auth Hub API (`https://auth-hub.appmixer.com`)                                                                                              |
| `AUTH_HUB_URL_QA`, `AUTH_HUB_API_TOKEN_QA`                      | QA Auth Hub API (`https://auth-hub.dev.appmixer.ai`) — optional; `/authub` offers QA once both are set                                                 |
| `ADMIN_EMAILS`                                                  | Comma-separated admin emails (Auth Hub write features, releasing connectors)                                                                           |
| `RELEASE_SOURCE_REPO` / `RELEASE_SOURCE_BRANCH`                 | Release page source, defaults `Appmixer-ai/appmixer-connectors@dev`                                                                                    |
| `RELEASE_TARGET_REPO` / `RELEASE_TARGET_BRANCH`                 | Release PR base, defaults `Appmixer-ai/appmixer-components@master`                                                                                     |
| `RELEASE_HEAD_REPO` / `RELEASE_HEAD_BRANCH`                     | Release PR head — the branch the release commits are pushed to, defaults `vtalas/appmixer-components@release`; the GitHub token needs push access here |
| `CRON_SECRET`                                                   | Auth for the public cron endpoint (see below)                                                                                                          |
| `E2E_MAX_CONCURRENT`                                            | Max E2E flows running at once (default `1`)                                                                                                            |
| `E2E_RUN_TIMEOUT_SECONDS`                                       | Per-run completion timeout (default `480`)                                                                                                             |

## Scheduled jobs (cron)

All E2E and PR data shown by the app comes from DB caches refreshed by explicit scans. A single public endpoint drives the scheduled refresh and the test runner:

```
GET /api/public/e2e-runner/tick
```

**Auth:** `Authorization: Bearer <CRON_SECRET>` header or `?secret=<CRON_SECRET>` query param. Returns `503` when `CRON_SECRET` is not configured. Runs with env credentials (not a user session).

**Query parameters** (combine freely):

| Param        | Effect                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| `scan=1`     | Refresh the E2E flows cache (GitHub + instance + latest results)          |
| `schedule=1` | Enqueue every deployed flow with no result from the last 20 h             |
| `loop=1`     | Tick the runner until the queue drains or the ~250 s time budget runs out |

`vercel.json` schedules the full combination daily at 03:00 UTC:

```json
{
  "crons": [
    {
      "path": "/api/public/e2e-runner/tick?scan=1&schedule=1&loop=1",
      "schedule": "0 3 * * *"
    }
  ]
}
```

Vercel Cron sends the `Authorization: Bearer <CRON_SECRET>` header automatically when the `CRON_SECRET` env var is set on the project. For more frequent processing, point any external cron (or a manual `curl`) at the same URL:

```bash
# refresh the E2E flows cache on demand
curl "https://<host>/api/public/e2e-runner/tick?scan=1" \
  -H "Authorization: Bearer $CRON_SECRET"
```

The runner never starts more than `E2E_MAX_CONCURRENT` flows at once — the Appmixer instance must not run everything in parallel.

## Public pages

### `/public/authhub`

Customer report: the services of the production Auth Hub that are marked **Verified** on `/authub` — name, service id and icon, with **Print / Save as PDF** and **Download CSV**. No sign-in needed, so the link can be sent to a customer. Names and icons appear once the connector's bundle has been loaded on `/authub` (Refresh).

## Public API

Unauthenticated read-only endpoints. Both serve cached data only (no live GitHub/instance calls), respond with `Cache-Control: public, max-age=60`, and return `{ "error": "..." }` with a `5xx` status on failure.

### `GET /api/public/connectors`

OAuth connectors registered in Auth Hub, with verification status.

| Param    | Required | Description                                                                                                        |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `env`    | no       | Auth Hub environment: `prod` (default) or `qa`. Statuses are tracked per environment.                              |
| `status` | no       | Filter: `verified`, `in_progress`, or `not_verified`. Omit to return all. An unknown value returns an empty array. |

**Response** — `200 OK`, JSON array sorted by connector name:

```json
[
  {
    "connector": "appmixer:airtable",
    "status": "verified",
    "clientId": "7acbffc2-34da-4de5-ac5a-06d881b03e1b"
  }
]
```

| Field       | Description                                                            |
| ----------- | ---------------------------------------------------------------------- |
| `connector` | Connector service ID (e.g. `appmixer:airtable`)                        |
| `status`    | `verified` \| `in_progress` \| `not_verified` (default when never set) |
| `clientId`  | OAuth client ID registered in Auth Hub                                 |

## Developing

```bash
pnpm run dev          # start dev server
pnpm run check        # type checking (svelte-check)
pnpm run lint         # Prettier check
pnpm run format       # Prettier write
```

## Building

```bash
pnpm run build        # production build
pnpm run preview      # preview the production build
```

Deployment: push to `main` deploys via Vercel. Remember to set all required env vars on the project — including `CRON_SECRET`, without which the scheduled cron gets `503`.

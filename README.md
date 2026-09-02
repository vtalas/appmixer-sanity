# Appmixer Sanity Check

A SvelteKit application for tracking the health of [Appmixer](https://www.appmixer.com) connectors: manual sanity-check test runs, E2E test flows with a throttled runner, merge readiness of connector PRs, and Auth Hub bundle management.

**Stack:** SvelteKit 2, Svelte 5, Turso (libSQL), Tailwind CSS, Bits UI. Deployed on Vercel. Google OAuth login; admin-only features gated by email.

See `CLAUDE.md` for the full architecture documentation (data model, modules, internal API routes).

## Pages

| Page                               | Description                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                                | Dashboard — list sanity-check test runs, create new ones from a live connector snapshot                                                                                                                            |
| `/test-runs/[runId]`               | Test run detail — connectors with status badges (pending / ok / fail / blocked)                                                                                                                                    |
| `/test-runs/[runId]/[connectorId]` | Connector detail — per-component test results, GitHub issue links                                                                                                                                                  |
| `/e2e-flows`                       | E2E test flows — GitHub (dev branch) merged with the Appmixer instance state and latest run results; diff, upload, revert, sync-to-PR, and a throttled test runner                                                 |
| `/prs`                             | Connector PRs — open PRs of the connectors repo with the E2E flow state of every touched connector and a per-PR **merge checklist** (account, linked issue, fresh green E2E report, CI, mergeability, flows green) |
| `/authub`                          | Auth Hub — browse and manage OAuth connector configs/bundles registered in Auth Hub, verification status tracking                                                                                                  |
| `/settings`                        | Per-user overrides for Appmixer / GitHub credentials (take precedence over env values)                                                                                                                             |

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in your values
pnpm run dev
```

### Environment variables

See `.env.example` for the full annotated list. Summary:

| Variable                                                        | Purpose                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`                        | Turso (libSQL) database — **required**                                       |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_SECRET`       | Google OAuth login — **required**                                            |
| `APPMIXER_BASE_URL`, `APPMIXER_USERNAME`, `APPMIXER_PASSWORD`   | Appmixer instance for E2E flows (users can override per-user in `/settings`) |
| `SANITY_GITHUB_TOKEN`                                           | GitHub token for the connectors repo (repo scope for private repos)          |
| `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` / `GITHUB_REPO_BRANCH` | Connectors repo, defaults `Appmixer-ai/appmixer-connectors@dev`              |
| `AUTH_HUB_URL_PROD`, `AUTH_HUB_API_TOKEN_PROD`                  | Auth Hub API                                                                 |
| `ADMIN_EMAILS`                                                  | Comma-separated admin emails (Auth Hub write features)                       |
| `CRON_SECRET`                                                   | Auth for the public cron endpoint (see below)                                |
| `E2E_MAX_CONCURRENT`                                            | Max E2E flows running at once (default `1`)                                  |
| `E2E_RUN_TIMEOUT_SECONDS`                                       | Per-run completion timeout (default `480`)                                   |

## Scheduled jobs (cron)

All E2E and PR data shown by the app comes from DB caches refreshed by explicit scans. A single public endpoint drives the scheduled refresh and the test runner:

```
GET /api/public/e2e-runner/tick
```

**Auth:** `Authorization: Bearer <CRON_SECRET>` header or `?secret=<CRON_SECRET>` query param. Returns `503` when `CRON_SECRET` is not configured. Runs with env credentials (not a user session).

**Query parameters** (combine freely):

| Param        | Effect                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `scan=1`     | Refresh the E2E flows cache (GitHub + instance + latest results)                                             |
| `prs=1`      | Refresh the connector PR cache (open PRs, changed files, linked issues, E2E reports, CI state, mergeability) |
| `schedule=1` | Enqueue every deployed flow with no result from the last 20 h                                                |
| `loop=1`     | Tick the runner until the queue drains or the ~250 s time budget runs out                                    |

`vercel.json` schedules the full combination daily at 03:00 UTC:

```json
{
  "crons": [
    {
      "path": "/api/public/e2e-runner/tick?scan=1&prs=1&schedule=1&loop=1",
      "schedule": "0 3 * * *"
    }
  ]
}
```

Vercel Cron sends the `Authorization: Bearer <CRON_SECRET>` header automatically when the `CRON_SECRET` env var is set on the project. For more frequent processing, point any external cron (or a manual `curl`) at the same URL:

```bash
# refresh the PR cache on demand
curl "https://<host>/api/public/e2e-runner/tick?prs=1" \
  -H "Authorization: Bearer $CRON_SECRET"
```

The runner never starts more than `E2E_MAX_CONCURRENT` flows at once — the Appmixer instance must not run everything in parallel.

## Public API

Unauthenticated read-only endpoints. Both serve cached data only (no live GitHub/instance calls), respond with `Cache-Control: public, max-age=60`, and return `{ "error": "..." }` with a `5xx` status on failure.

### `GET /api/public/connectors`

OAuth connectors registered in Auth Hub, with verification status.

| Param    | Required | Description                                                                                                        |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
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

### `GET /api/public/prs`

Open connector PRs with E2E state and the merge checklist. Data comes from the PR and E2E caches in the env-credential scope; refresh via the cron endpoint (`prs=1`).

| Param       | Required | Description                                                            |
| ----------- | -------- | ---------------------------------------------------------------------- |
| `connector` | no       | Only PRs touching this connector (e.g. `airtop`, `microsoft/calendar`) |

**Response** — `200 OK`:

```json
{
  "repo": "Appmixer-ai/appmixer-connectors",
  "lastScanAt": "2026-09-02 08:27:47",
  "prs": [
    {
      "number": 1228,
      "title": "Airtop connector (10 components, API key auth)",
      "url": "https://github.com/Appmixer-ai/appmixer-connectors/pull/1228",
      "author": "petrolivka",
      "draft": false,
      "baseBranch": "dev",
      "updatedAt": "2026-08-31T19:46:55Z",
      "readyToMerge": false,
      "checklist": [
        {
          "key": "account",
          "label": "Account",
          "status": "fail",
          "detail": "No service account on the instance for: airtop"
        }
      ],
      "linkedIssues": [
        {
          "repo": "Appmixer-ai/appmixer-components",
          "number": 2824,
          "state": "open",
          "url": "https://github.com/Appmixer-ai/appmixer-components/issues/2824"
        }
      ],
      "connectors": [
        {
          "name": "airtop",
          "accountAvailable": false,
          "flows": [
            {
              "name": "E2E Airtop - Browser Interaction",
              "syncStatus": "not_deployed",
              "deployed": false,
              "lastResult": null,
              "lastResultAt": null,
              "changedInPR": true,
              "newInPR": true
            }
          ]
        }
      ]
    }
  ]
}
```

The **merge checklist** contains six items, each `pass` | `fail` | `warn` with a human-readable `detail`; `readyToMerge` is true only when all six pass:

| Key         | Rule                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `account`   | A service account for every touched connector exists on the instance                                                 |
| `issue`     | The PR body has a closing issue reference (e.g. `Closes Appmixer-ai/appmixer-components#123`) and the issue exists   |
| `report`    | The linked issue carries a fully green E2E report comment that is **≤ 5 days old and newer than the PR head commit** |
| `ci`        | CI checks on the head commit are green                                                                               |
| `mergeable` | Not a draft, no merge conflict with the base branch                                                                  |
| `flows`     | Flows changed by the PR are deployed and all of the connector's flows are green on the instance                      |

Time-based rules are evaluated at read time, so a stale report flips to `fail` without a rescan.

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

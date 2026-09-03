# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Appmixer Sanity Check - A SvelteKit application for tracking sanity checks of Appmixer connectors. It creates snapshots of connector versions, allows testing and documenting component status, and tracks progress with visual dashboards.

## Commands

```bash
pnpm run dev          # Start development server
pnpm run build        # Create production build
pnpm run preview      # Preview production build
pnpm run check        # Run TypeScript/Svelte type checking
pnpm run check:watch  # Watch mode type checking
pnpm run lint         # Check code formatting with Prettier
pnpm run format       # Format code with Prettier
```

## Environment Variables

Required (see `.env.example`):
- `TURSO_DATABASE_URL` - Turso database URL (e.g., `libsql://your-db.turso.io`)
- `TURSO_AUTH_TOKEN` - Turso authentication token

## Architecture

**Stack:** SvelteKit 2.0, Svelte 5, Turso (libSQL), Tailwind CSS, Bits UI

### Data Flow

1. **Dashboard** (`/`) - Lists test runs, creates new ones
2. **Test Run Creation** - Fetches connectors from AWS API, stores snapshot in SQLite
3. **Test Run Detail** (`/test-runs/[runId]`) - Lists connectors with status badges
4. **Connector Detail** (`/test-runs/[runId]/[connectorId]`) - Shows components, update test results

### Database Schema

```
test_runs → connectors → components (cascade delete)
```

- `test_runs`: id, name, created_at, status (in_progress|completed)
- `connectors`: test_run_id, connector_name, version, label, status (pending|ok|fail|blocked), blocked_reason
- `components`: connector_id, component_name, status (pending|ok|fail), github_issue, tested_at

Database: Turso (serverless SQLite). Schema initialized via `src/hooks.server.js` on startup.

### Key Directories

- `src/lib/db/` - Database queries (test-runs.js, connectors.js, components.js)
- `src/lib/api/modules.js` - External API calls to AWS modules service
- `src/lib/components/ui/` - Shadcn-style UI components (Bits UI based)
- `src/lib/components/{connectors,test-runs,components}/` - Feature components
- `src/routes/api/` - REST API endpoints

### API Pattern

SvelteKit `+server.js` files with GET/POST/PATCH/DELETE handlers returning JSON responses.

### Svelte 5 Patterns

```javascript
let { data } = $props();                    // Props
const filtered = $derived(data.filter(...)); // Computed
let count = $state(0);                       // Mutable state
```

**Important:** When initializing `$state()` from props, don't reference props directly in the initializer—it only captures the initial value. Use `$effect()` to sync:

```javascript
// Wrong - only captures initial value, build will warn
let value = $state(data.field || '');

// Correct - syncs when props change
let value = $state('');
$effect(() => { value = data.field || ''; });
```

Use `invalidateAll()` after mutations to refetch data.

### Status Logic

- Connector status auto-calculates from component results unless manually blocked
- Status hierarchy: Test Run → Connector → Component

## E2E Test Flows (`/e2e-flows`)

Overview of all E2E test flows: the source of truth is the **GitHub repo** (appmixer-connectors, dev branch — `src/appmixer/<connector>/test-flow*.json`), merged with the **Appmixer instance** deployment state and the latest run results, grouped by connector. Includes a throttled test runner that never starts more than `E2E_MAX_CONCURRENT` flows at once.

### Data Model

Everything the page shows comes from a DB cache refreshed by an explicit **Scan** (page button or cron). **All cache/queue rows are scoped by `instance_url`** (normalized Appmixer base URL from the caller's config — per-user DB settings override env), because different users and the env-credential cron may target different instances; every query in `src/lib/db/e2e.js` takes `instanceUrl` first.

- **`e2e_flows`** — one row per test flow per instance, keyed by `(instance_url, flow_name)` (the flow's identity — `name` in the GitHub JSON, matched to `customFields.name` on the instance with legacy fallback to the flow name, same rule as the appmixer CLI). Columns: connector (from the file path), `github_path/sha/hash/url`, `flow_id` + `stage` + `server_mtime` (instance state), `sync_status` (`match` | `modified` | `not_deployed` | `server_only` | `error`), `last_result` (`passed` | `failed`) + `last_result_at` + `last_result_detail` (JSON per-component results), `account_available` (0/1/NULL — a service account matching the connector exists on the instance; computed per connector during scan with the same service-name rule as upload account binding).
- **`e2e_runs`** — run queue + history: `state` (`queued` → `running` → `passed`/`failed`/`timeout`/`error`/`cancelled`), `baseline_result_at` (newest result-store record at start time; completion = a newer record, immune to clock skew).

### Key Modules

- **`src/lib/server/e2e/scan.js`** — `scanE2EFlows(userId)`: GitHub tree + contents (incremental — content refetched only when the blob sha changed), instance flow list, hash comparison (`cleanFlowForComparison` + md5, skipped when neither side changed), latest results from the global stores; replaces the `e2e_flows` cache atomically. `fetchLatestResults(userId)`: reads the two result stores ("E2E Failed Tests" / "E2E Succeeded Tests" — same names as the appmixer CLI), newer record wins per test case.
- **`src/lib/server/e2e/runner.js`** — `tickPass(userId)`: one runner pass — (1) finalize running runs (result record newer than baseline → stop flow + record result; timeout after `E2E_RUN_TIMEOUT_SECONDS` → stop + timeout), (2) atomically claim queued runs (`UPDATE … RETURNING`) up to `E2E_MAX_CONCURRENT` and start them. `tickLoop(userId, budgetMs)`: repeats passes until queue drains or budget runs out (for cron). Ticks are driven by the page (15s interval while active) and/or cron.
- **`src/lib/db/e2e.js`** — DB helpers for both tables.

### API Routes

| Route | Methods | Description |
|---|---|---|
| `api/e2e-flows/scan` | POST | Full cache refresh (GitHub + instance + results) |
| `api/e2e-flows/run` | POST | Enqueue runs (`{flowNames?, connector?, all?}`), kicks one tick |
| `api/e2e-flows/run` | DELETE | Cancel all queued runs |
| `api/e2e-flows/runner/tick` | POST | One runner pass (session, driven by the open page) |
| `api/e2e-flows/toggle` | POST | Manual start/stop of a flow (also updates cache stage) |
| `api/e2e-flows/diff` | POST | Server vs GitHub flow JSON for the diff dialog |
| `api/e2e-flows/revert` | POST | Overwrite instance flow with the GitHub version |
| `api/e2e-flows/delete` | POST | Delete flows from the instance (also updates cache) |
| `api/e2e-flows/sync` | POST | Create a PR pushing modified/server-only flows to GitHub |
| `api/e2e-flows/upload` | POST | Upload (import) GitHub flows to the instance — `appmixer e2e import` semantics via `src/lib/server/e2e/upload.js` (identity customFields, result stores, fail-fast errorHandling, account binding) |
| `api/public/e2e-runner/tick` | GET | **Cron entrypoint** (no session; `CRON_SECRET` auth, env credentials). Params: `scan=1`, `prs=1` (refresh the PR cache), `schedule=1` (enqueue flows without a result in 20h), `loop=1` (tick until budget ~250s runs out) |

`vercel.json` schedules the cron daily (`scan=1&prs=1&schedule=1&loop=1`). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically when the env var is set; for more frequent processing point any external cron at the same URL.

### Environment Variables

- `CRON_SECRET` — auth for the public cron endpoint (required for cron)
- `E2E_MAX_CONCURRENT` — max flows running at once (default 1 — the instance must never run everything at once)
- `E2E_RUN_TIMEOUT_SECONDS` — per-run completion timeout (default 480, same as `appmixer e2e run`)

## Connector PRs (`/prs`)

Open PRs of the connectors repo with the E2E flow state of every connector they touch — the same per-flow view as `/e2e-flows` (sync status, last result, account badge) but grouped by PR.

- **`e2e_prs`** table — PR cache keyed by `(repo, number)` (**repo-scoped, not instance-scoped** — the join with `e2e_flows` happens at read time): title/author/url/branches/draft, `connectors` (JSON — derived per changed file via connector roots, i.e. dirs under `src/appmixer/` containing bundle.json/service.json/package.json, longest match wins for nested connectors), `test_flows` (JSON — test-flow files changed by the PR with the flow identity read from the PR head), `files_count`, plus merge-checklist data: `head_committed_at`, `mergeable`, `ci_status` (`success`|`failure`|`pending`|`none`), `linked_issues` (JSON — issues resolved from closing refs in the PR body, cross-repo aware: issues usually live in appmixer-components), `e2e_report` (JSON — newest E2E report comment found on a linked issue: `createdAt`, `url`, `allPassed`, `source` `marker`|`heuristic`; the marker is `<!-- e2e-report {...} -->`, written by the `/pr-finalize` workflow).
- **`src/lib/server/e2e/prs.js`** — `scanPRs(userId)`: list open PRs + changed files, replace the cache; connector roots are extended per PR with manifests the PR itself adds (a brand-new connector maps to itself, not its parent). Also collects per PR: mergeability, CI state of the head commit (check runs + legacy statuses), head commit date, linked issues (closing refs) and the newest E2E report comment on them. `scanPR(userId, number)`: the same per-PR work for a single PR (a handful of GitHub calls instead of a few hundred — drives the per-card refresh button), upserting just that row and deleting it when the PR is no longer open. `buildPROverview(userId)`: joins the PR cache with the caller-instance `e2e_flows` cache — per PR → per connector → flows with `changedInPR`/`newInPR` flags (flows added by the PR that dev doesn't know yet appear as `not_deployed` + `newInPR`). Account availability comes from the **`e2e_accounts`** snapshot (instance account service names, refreshed during every e2e scan) so it also works for connectors with no cached flows.
- **Merge checklist** — `buildChecklist(pr, connectors)` in `prs.js`, computed at read time (time-based rules stay correct without a rescan). Items (each `pass`|`fail`|`warn`; `readyToMerge` = all pass): **account** (service account on the instance for every touched connector), **issue** (PR body has a closing issue reference and the issue exists), **report** (linked issue carries a fully green E2E report ≤5 days old AND newer than the PR head commit), **ci** (checks green on the head commit), **mergeable** (not draft, no merge conflict), **flows** (flows changed by the PR deployed, all connector flows green on the instance). `readyForTesting` = the `account` and `ci` items pass (the PR can be E2E-tested — everything else is what the testing produces). Shown as pills on each PR card with "Needs Account" / "Ready for Testing" / "Ready to Merge" stat tiles/filters, and exposed in the public `api/public/prs` response (`readyToMerge`, `readyForTesting`, `checklist`, `linkedIssues`).
- **`src/lib/db/prs.js`** — `getPRs(repo)` / `replacePRs(repo, prs)` / `upsertPR(repo, pr)` / `deletePR(repo, number)`. `lastScanAt` in the overview is the **oldest** cached row, so one refreshed card doesn't make the whole list look freshly scanned.

| Route | Methods | Description |
|---|---|---|
| `api/prs/scan` | POST | Refresh the whole PR cache (session auth) |
| `api/prs/[number]/scan` | POST | Refresh a single PR (session auth); returns `{removed: true}` when it is no longer open |
| `api/public/prs` | GET | **Public** (no auth) PR status from the caches only — per PR: connectors with `accountAvailable` + flows (`syncStatus`, `deployed`, `lastResult`, `changedInPR`); optional `?connector=` filter |

## Auth Hub (`/authub`)

Auth Hub is a separate page for browsing and managing OAuth connector configs/bundles registered in an external Auth Hub service.

### Key Features

- **Status tracking** — per-connector verification status (`not_verified` | `in_progress` | `verified`) stored in DB and updated inline
- **Notes** — free-text notes per connector, stored in DB, edited via dialog
- **Whitelist management** — add/remove individual service-config keys to the Auth Hub whitelist (admin only)
- **Bundle download** — proxy-download a connector's ZIP bundle from Auth Hub
- **Bundle upload** — upload a new or replacement ZIP bundle; polls a ticket until processing completes (admin only)
- **Service config edit** — view and edit connector config in field mode or raw JSON mode (admin only)
- **GitHub oauth2 connector cache** — scans the GitHub repo for oauth2 connectors + `bundle.json` versions and caches results in DB; surfaced as a merged connector list
- **Version comparison** — compares the Auth Hub bundle version against the cached GitHub version and highlights outdated/matching/newer connectors

### Architecture

- **`src/routes/authub/+page.svelte`** — Main SPA page. Displays a filterable connector table (search, status filter, "not in Auth Hub" toggle) with version comparison indicators, status dropdowns, notes, and admin dialogs (upload bundle, upload new connector, view/edit service config, delete connector).
- **`src/routes/authub/+page.server.js`** — Server `load` function. Fetches the connector list from Auth Hub, cached bundle info, DB-stored statuses/notes, and cached GitHub oauth2 connector data. Returns a merged connector list tagged by `source` (`authhub` | `github` | `both`). Uses `getGitHubRepoInfo` from `src/lib/api/github.js` to populate the GitHub repo link shown to admins.

### API Routes (`src/routes/api/auth-hub/`)

| Route | Methods | Description |
|---|---|---|
| `+server.js` | GET | List all connectors from Auth Hub (`GET /service-config`) |
| `bundle/+server.js` | GET | Read cached bundle info (version, icon, label) from disk for all connectors in an environment (`?env=prod`) |
| `bundle/+server.js` | POST | Download bundle ZIP from Auth Hub for a single `serviceId`, extract to local cache, return version |
| `bundle-download/+server.js` | GET | Proxy-download a connector bundle ZIP to the browser (auth required) |
| `connector/+server.js` | DELETE | Delete service config + bundle from Auth Hub (admin only) |
| `github-oauth/+server.js` | GET | Return cached GitHub oauth2 connector list from DB |
| `github-oauth/+server.js` | POST | Scan GitHub repo for oauth2 connectors + bundle.json versions, save to DB, return result |
| `notes/+server.js` | POST | Save per-connector notes to DB (auth required) |
| `service-config/+server.js` | GET | Fetch service config for a single connector; `?whitelist=1` fetches the whitelist instead (auth required) |
| `service-config/+server.js` | PUT | Update service config for a connector (admin only) |
| `service-config/whitelist-key/+server.js` | PUT | Add a single whitelist key for a connector (admin only) |
| `service-config/whitelist-key/+server.js` | DELETE | Remove a single whitelist key from a connector (admin only) |
| `status/+server.js` | POST | Save verification status (`verified` / `not_verified` / `in_progress`) to DB |
| `../public/connectors/+server.js` | GET | **Public** (no auth) list of Auth Hub connectors — returns only `connector`, `status`, `clientId`; optional `?status=` filter |
| `upload/+server.js` | POST | Upload a ZIP bundle to Auth Hub; returns `{ ticket }` (admin only) |
| `upload/+server.js` | GET | Poll upload ticket status (`?ticket=…`) (admin only) |

### Database Tables

- **`authhub_status`** — Per-connector verification status and notes: `service_id`, `status`, `notes`, `updated_at`.
- **`github_oauth_connectors`** — Cached GitHub scan results: `service_id`, `path`, `github_version`, `is_oauth2`, `updated_at`. Populated by `github-oauth` POST, read by GET.

### DB Helpers (`src/lib/db/authhub.js`)

- `getAuthHubStatuses()` — Returns `Record<serviceId, status>` for all connectors
- `setAuthHubStatus(serviceId, status)` — Upserts verification status
- `getAuthHubNotes()` — Returns `Record<serviceId, notes>` (non-empty only)
- `setAuthHubNotes(serviceId, notes)` — Upserts notes
- `getGithubOAuthConnectors()` — Returns `{ oauth2: [{serviceId, path}], versions: {serviceId: version} }` from DB
- `setGithubOAuthConnectors(connectors)` — Replaces all cached GitHub connector data

### Admin Gating

Admin features (edit service config, whitelist keys, upload bundle, delete connector) are gated by `isAdmin(email)` from `src/lib/admin.js`. It reads `ADMIN_EMAILS` (comma-separated) from env and checks if the session user's email is in the list.

### Environment Variables

- `AUTH_HUB_URL_PROD` — Base URL of the Auth Hub API
- `AUTH_HUB_API_TOKEN_PROD` — Bearer token for Auth Hub API
- `ADMIN_EMAILS` — Comma-separated list of admin email addresses

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

# Publish a flow JSON as an Automation Hub integration (see "Migrating a flow to an integration")
node --env-file=.env scripts/publish-integration.js <flow.json> [--category <name>] [--dry-run]
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

## Release (`/releases`)

Compares the **release repo** (`Appmixer-ai/appmixer-components` `master` — every push there runs the **Marketplace PRD** workflow, which installs each new bundle version to production) with the **development repo** (`Appmixer-ai/appmixer-connectors` `dev`), and releases connectors from one to the other.

- **Comparison** — `src/lib/server/release/compare.js`, `compareReleases(userId)` / `loadReleaseState(token)`. One recursive git tree per repo (cached in memory by tree sha) plus every connector's `bundle.json` (cached in the **`release_bundle_blobs`** table by blob sha — content-addressed, never invalidated). A connector is a directory under `src/appmixer/` with a `bundle.json`; a file belongs to the **nearest** one (`utils/http`, not its parent `utils`), and files no connector owns belong to their **namespace** (`google/auth.js`, `microsoft/microsoft-commons.js`). Files are compared by blob sha, so nothing is downloaded to find out they differ.
- **Status** per connector: `new` (not on the release branch), `major` / `minor` / `patch` (dev version is higher — named after the part that changed), `drift` (same version, different files — bump the version on dev first), `behind` (release branch is higher — a hotfix), `master-only`, `same`, `invalid` (no semver version). Only `new` / `major` / `minor` / `patch` are releasable.
- **Excluded files** — `artifacts/ai-artifacts/**` and `package-lock.json` are never compared, released or deleted (`isExcluded`). None of them ever reached master in the hand-made releases; without the rule 38 connectors looked drifted.
- **Release** — `src/lib/server/release/publish.js`, `releaseConnectors(userId, items, {dryRun})`. One commit per connector with the message `<connector> <version> (<new|major|minor|patch>)`, the convention of the hand-made releases on master. Each commit mirrors the connector directory from dev: files are added, changed **and deleted** (the page warns when a release removes components from production). It also carries the namespace's added/changed shared files, in the first commit of that namespace only. Shared files are never deleted, because other connectors of the namespace may still use them.
- **Atomic publish** — missing blobs are copied through the Git Data API (`git/blobs` → `git/trees` with `base_tree` → `git/commits`, chained). The branch ref moves **once** at the end with `force: false`: either every commit lands or none does, and a branch that moved meanwhile rejects the update (409, nothing published). The request carries the `devVersion` the admin reviewed, and the release is refused when dev has moved to another version since. `dryRun: true` returns the planned commits; the confirmation dialog shows them.
- **GitHub calls** — `githubRequest()` retries reads (network errors, 5xx) with a 30 s timeout per request: GitHub occasionally closes the connection halfway through a 3 MB tree download, which used to hang a page load for minutes.
- **Token** — the caller's GitHub token (Settings) or `SANITY_GITHUB_TOKEN`: read access to both repos (appmixer-components is private), push access to the release repo. Commits are authored by the token's owner.
- **Admin gating** — the page is open to every signed-in user; checkboxes, the Release buttons and `POST /api/releases` require `isAdmin`.
- **Trying it without deploying** — point `RELEASE_TARGET_REPO` / `RELEASE_TARGET_BRANCH` at a branch of a fork (forks don't run the marketplace workflow). The dialog shows the production warning only for `Appmixer-ai/appmixer-components` `master`.

Routes:

- `GET api/releases` — the comparison (session auth).
- `POST api/releases` — body `{connectors: [{name, devVersion}], dryRun?}`; plans or performs a release (admin only).

Environment: `RELEASE_SOURCE_REPO` / `RELEASE_SOURCE_BRANCH` (default `Appmixer-ai/appmixer-connectors` / `dev`), `RELEASE_TARGET_REPO` / `RELEASE_TARGET_BRANCH` (default `Appmixer-ai/appmixer-components` / `master`).

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

## Automation Hub (`/automation-hub`)

Embeds Appmixer's own marketplace widget — `appmixer.ui.AutomationHub` from the Appmixer UI SDK — for the caller's Appmixer configuration, so integrations (the `appmixer-sanity-hub` template category: the Copilot review and `@apx-vero` mention responders) can be activated, started/stopped and inspected without leaving the app.

- **`src/routes/automation-hub/+page.server.js`** — `load()` calls `getAppmixerSession(userId)`, `findCategoryByName(userId, 'appmixer-sanity-hub')` and `listCategoryTemplates(userId, category.id)` and returns `{ baseUrl, uiUrl, token, category, templates }` (or `error`). A missing category is `null` and a failed template lookup is `[]`, not an error.
- **`src/routes/automation-hub/+page.svelte`** — lists the category's templates with Designer links to the template and to its draft (`<uiUrl>/integration-designer/<flowId>` — Studio's route for integrations; `/designer/` is for plain flows; the draft is the template's `originFlowId`). Then it loads the SDK from the instance itself (`<uiUrl>/appmixer/package/appmixer.js`, ~5 MB, cached by the browser) and calls `new Appmixer({ baseUrl })`, `set('accessToken', token)`, `AutomationHub({ el, options })`, `state('flows/query/templates/categoryIds', [id])` and `open()`.
- **`getAppmixerSession(userId)`** / **`appmixerUiUrl(baseUrl)`** / **`findCategoryByName(userId, name)`** / **`listCategoryTemplates(userId, categoryId)`** in `src/lib/api/appmixer.js` — the UI URL is derived from the API URL (`api-<tenant>` → `<tenant>`), the same rule the PRs page uses for Designer links. Templates are filtered server-side with `GET /flows?filter=type:integration-template&filter=categories:<id>`.

**The widget is put back into the page flow.** The SDK's widget root (`.am-widget`) is `position: absolute; inset: 0; overflow: auto`: it fills the nearest positioned ancestor and scrolls inside it. In a plain `div` it covered the whole page (nav, heading, template list); in a sized container it added a second scrollbar. The page's `<style>` makes it `position: relative; overflow: visible` inside `#automation-hub`, so the hub takes its natural height, only the page scrolls and the hub's sticky headers stick to the viewport; `min-height: 75vh` keeps the `flex: 1` panels (Logs) from collapsing. Don't use `transform`/`contain` on the container — the hub's dialogs and the Wizard are `position: fixed` and must stay full-screen.

**"Browse available" lists only published templates.** The widget queries `type:integration-template`, `categories:<id>`, `sharedWithPermissions=read` **and `sharedWith:![]`** — a template whose `sharedWith` is empty is hidden there, while the page's own template list (no `sharedWith` filter) still shows it.

**Console noise in dev.** Svelte's dev build patches `Array.prototype.includes`/`indexOf` and warns `state_proxy_equality_mismatch` when an array element answers `in` for its `$state` symbol. The SDK's Vue components with runtime-compiled templates use a proxy whose `has` trap answers true for every symbol, so every hub re-render logged dozens of these. They are false positives; the page drops that one warning from `console.warn` while it is open (dev only — production has no patch).

**The access token reaches the browser.** That is inherent to embedding the SDK; the page is behind the app login (`hooks.server.js`), but whoever opens it acts on the instance as the configured Appmixer user (per-user Settings, else the env account).

**Filtering.** The instance is shared, so the unfiltered widget lists every template anyone published. The SDK widget does not read the hub's tabs from `/automation-hub/settings` — the page narrows it itself: `options.flows.templates.header.categories = { visible: true, tabs: [{ category: <categoryId>, label }] }` offers only that category next to "All", and the `categoryIds` state preselects it (the templates query filters on the *selected* categories, so without it the list starts on "All"). "All" still lists everything. "My automations" (instances) is per-user and the widget has no category filter for it — only search and `onlyRunning`. Options are deep-merged (`deepmerge`) over the widget defaults, so a partial `options` object is fine.

**Wizard and customization.** The hub has no built-in handler for "Start automation" (templates) or "Edit settings" (instances): it emits `flow:open-wizard` and the page opens `appmixer.ui.Wizard({ flowId })` as a modal. Given a template, the Wizard clones it into a new `integration-instance` as soon as it opens; its default `flow:start` action starts the instance and then emits `flow:start-after`. **SDK widgets run an event's default action only when nothing listens to it** (`emit()` calls `next()` only for unbound events). The page leaves `flow:start-after` unbound (its default emits `close`) and handles two events. **`close`**: runs the default (`event.next()`, unmount), then `hub.reload({ mode: 'soft', scope: { flows: { instances: true } } })` — instances only. A plain `hub.reload()` is a hard reload of instances *and* templates, and the SDK's templates paging then runs away: it keeps requesting the next offset while loaded < count (0 < 3), every ~50 ms, and "Browse available" stays empty. **`cancel`** (the ×) is left to its default — delete the instance if it was never started, then emit `close` — but the Wizard is created with its own `deleteFlow` (widget option `api`: methods there override `appmixer.api` for that widget) that only remembers the id and resolves. The default deletes while the Wizard is still mounted, and the Wizard then kept assigning accounts (`PUT /auth/account/<id>/components`) and fetching `/variables/<id>/fetch` for the deleted flow — a burst of 404s. The `close` handler above runs `event.next()` (unmount), then waits for the Wizard's teardown and only then deletes the remembered ids and reloads instances. Unmounting does not stop work already under way — the Wizard still assigns accounts and re-fetches variables for about a second, with nothing signalling the end — so `wizardSettled()` watches finished requests (`PerformanceObserver`, type `resource`) that mention the instance or `/auth/account/` and resolves after 600 ms without one (no sooner than 1 s, no later than 10 s). Both halves are needed: deleting right after unmount collided with the teardown, and waiting without unmounting let the still-mounted Wizard re-fetch the deleted instance. Leaving the page before the wait ends leaves the stopped instance behind. Don't replace this with a `cancel` listener that calls `wizard.close()`: the public widget object (`open`, `close`, `reload`, `reset`, `on`, `off`, `state`, `set`, `get` — no `unmount`) hides the Wizard without unmounting it or emitting `close`, and the still-mounted Wizard re-fetched the variables of the instance as soon as it was deleted. "Customize in Editor" would need a Designer the app doesn't embed (the hub emits `flow:open-designer` after creating a stopped `custom-integration-instance`), so `customization.entryPoints` is off — which also keeps those "Custom" copies out of "My automations".

## Migrating a flow to an integration

An Appmixer flow that someone keeps running by hand becomes an **integration**: a template users activate themselves from `/automation-hub`, filling in a Wizard. Three flow types are involved:

- **`integration-draft`** — the editable source (opens in the Designer), created from a flow JSON.
- **`integration-template`** — published from the draft: a clone with `originFlowId` = the draft and `sharedWith` = every user of the instance. The page lists templates of the `appmixer-sanity-hub` category.
- **`integration-instance`** — one user's copy, created by the Wizard from the template (`templateId` = the template, its own component IDs).

Worked example: the Copilot review and `@apx-vero` mention responders in [`Appmixer-ai/appmixer-connectors` → `.github/appmixer-flows/`](https://github.com/Appmixer-ai/appmixer-connectors/tree/dev/.github/appmixer-flows) — the JSON format `scripts/publish-integration.js` reads, with a README on what each flow does.

### 1. The flow JSON

Keep it in the repository of whatever the flow automates (not here), as `{ name, description, flow, notes, wizard }`:

- Start from the running flow — `GET /flows/<flowId>` — and keep those keys. Component IDs can stay: the draft keeps them, the template and every instance get their own (`componentIdMap`).
- **`description`** — one plain sentence. The hub card shows it under the name, the Wizard in its header (as HTML).
- **`notes`** — top-level `{ <uuid>: { x, y, width, height, content } }`, Markdown; for whoever opens an instance in the Designer.
- Per component: pin `version` to what the instance has (`GET /components`; `appmixer component ls` reads the local connectors tree, not the instance) and set `onError` — only `errorPort`, `stopFlow` or `storeUnprocessed` are accepted; a polling trigger wants `storeUnprocessed` with auto-retry.
- Everything a user has to choose (accounts, repository, channel, …) goes through the wizard; everything else stays fixed in the flow.

### 2. The wizard

`wizard.fields[]`, in the order the Wizard asks; every field has `type`, `label`, `tooltip`, `placeholder`:

- **`account`** — `attrs: { service: 'appmixer:github', components: [<cid>, …] }`. The only field that fills several components.
- **`inspectorField`** — a **top-level `source`** (not inside `attrs`) naming exactly one input: `<cid>.config.properties.<name>` for a component property, or `<cid>.config.transform.in.<senderCid>.out.lambda.<name>` for an input-port field fed from `<senderCid>`.
- `inspectorFieldset` (a component's whole inspector), `customField`, `text`, `image`.

One value cannot be written into two components. When two need it, let the wizard fill one and wire the other to it in the flow (e.g. the dispatch takes `repository.full_name` from the trigger's output), so there is one place to enter it. The publish script refuses a wizard field that points at a component the flow doesn't have — such a field is silently dropped and the Wizard then asks for nothing.

### 3. Publish

```bash
node --env-file=.env scripts/publish-integration.js <flow.json> --dry-run   # what would change
node --env-file=.env scripts/publish-integration.js <flow.json>
```

- Credentials: `APPMIXER_BASE_URL`, `APPMIXER_USERNAME`, `APPMIXER_PASSWORD`; variables set in the shell win over `.env`. Point them at the instance the hub runs against (dev-automated-00001 for the responders) — `.env` may name another one.
- **First run** creates the draft, publishes the template from it and puts it into the category (`--category <name>`, default `appmixer-sanity-hub`, created when missing).
- **Later runs** (same `name`) update the draft and re-publish onto the **same** template the way the Designer's Publish does: component IDs remapped through the template's `componentIdMap`, `revision` bumped. Nothing is written when nothing changed. Existing instances stay on their revision until `appmixer integration update-instances <templateId>`.
- Publishing shares the template with every user of the instance, so an agent's permission check may stop it — then the user runs the command.
- API quirks the script handles: the clone's `additional` takes only `type` and `sharedWith` (anything else is a 400), so categories and the description are set with a `PUT` afterwards; a draft's wizard copied onto a template without remapping points every field at the draft's component IDs.

### 4. Activate and verify

- `/automation-hub` → the card → **Use → Start automation** → Wizard → **Start**. The instance belongs to the Appmixer user the page runs as, and so do the accounts the Wizard offers.
- "My automations" shows it running. Make the trigger fire once for real and check **See logs**.
- Without the UI: `POST /flows/<templateId>/clone` with `{ setOriginFlowId: true, additional: { type: 'integration-instance' } }`, then `PUT /flows/<id>` with `{ templateId }` (the clone alone is not linked to the template), bind accounts to the clone's **new** component IDs (`componentIdMap`) and start it. Prefer the Wizard.

### 5. Retire the old flow

Stop the original flow only after the instance has handled a real event, and leave it stopped — not deleted — as the fallback for a while. Retry its dead-letter queue before stopping it: `appmixer dead-letter retry` into a stopped flow loses the message.

**Delete** under "My automations" deletes the running instance itself; whatever it automated stops until someone activates it again.

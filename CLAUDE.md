# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Appmixer Sanity Check - A SvelteKit application for tracking sanity checks of Appmixer connectors. It creates snapshots of connector versions, allows testing and documenting component status, and tracks progress with visual dashboards. It also runs the E2E test flows, shows the merge readiness of connector PRs, manages Auth Hub bundles, and releases connectors from appmixer-connectors `dev` to appmixer-components `master` (`/releases`).

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

Compares the **release repo** (`Appmixer-ai/appmixer-components` `master` — every push there runs the **Marketplace PRD** workflow, which installs each new bundle version to production) with the **development repo** (`Appmixer-ai/appmixer-connectors` `dev`), and releases connectors from one to the other through a `[RELEASE]` pull request — the app never pushes to master itself.

- **Comparison** — `src/lib/server/release/compare.js`, `compareReleases(userId)` / `loadReleaseState(token)`. One recursive git tree per repo (cached in memory by tree sha) plus every connector's `bundle.json` (cached in the **`release_bundle_blobs`** table by blob sha — content-addressed, never invalidated). A connector is a directory under `src/appmixer/` with a `bundle.json`; a file belongs to the **nearest** one (`utils/http`, not its parent `utils`), and files no connector owns belong to their **namespace** (`google/auth.js`, `microsoft/microsoft-commons.js`). Files are compared by blob sha, so nothing is downloaded to find out they differ.
- **Status** per connector: `new` (not on the release branch), `major` / `minor` / `patch` (dev version is higher — named after the part that changed), `drift` (same version, different files — bump the version on dev first), `behind` (release branch is higher — a hotfix), `master-only`, `same`, `invalid` (no semver version). Only `new` / `major` / `minor` / `patch` are releasable.
- **In release PR** — with an open release PR the comparison also reads its branch: a connector whose `bundle.json` differs there from master gets `inPr {number, url, version}`, and it is not releasable while the PR already carries its current dev version.
- **Readiness** — `src/lib/server/release/readiness.js`, the **Project** column and the **Ready** tile/filter: is the work a release would ship finished on the GitHub project (`RELEASE_PROJECT`, default `Appmixer-ai/7` "@appmixer-connectors"; ready = Status `Done`, `RELEASE_READY_STATUSES`)? Per releasable connector it finds the PRs merged into dev since the last release and reads how each is tracked — both supported ways: the PR **closes an issue** that is a project item (`closingIssuesReferences` — a "Closes" keyword or the Development sidebar, across repos; e.g. connectors #1273 → components #2848), or the **PR itself** is a project item (e.g. connectors #1320). Issues win when both are there. States: `ready` (every tracked PR is ready), `not-ready`, `untracked` (PRs found, none on the project), `unknown` (no PR found). **Untracked PRs never block** — cross-cutting chores (outPort examples, test-flow sweeps) rarely have an item; they are listed and counted as `+N` next to the badge. It is an indicator and a filter, not a gate: the Release button works regardless.
  - **Which PRs are unreleased** — two angles, merged: commits under the connector's directory `since` the last release (the **authored** date of the newest master commit under the directory — "Rebase and merge" rewrites the committer date to the merge time), and commits that changed `bundle.json` to a version above the released one (finds branches merged with a merge commit whose commits predate the release, and master commits that were not a release of dev). A connector with connectors nested in it (`utils`) goes by `bundle.json` alone. Only PRs into the source branch count (`associatedPullRequests` also returns sync/release PRs containing the commit).
  - **Cost** — GitHub GraphQL through `githubRequest(token, 'POST', '/graphql')`: history by path is slow, so 6 connectors per query, 4 queries at a time; each PR is read once however many connectors it touched. ~7 s for 54 connectors, so `compareReleases(userId, {readiness: true})` returns it as a **promise** — the page streams it in (table after <1 s, spinners in the Project column meanwhile), `GET /api/releases` awaits it. Statuses are never cached: moving a card and clicking Refresh must show.
  - **Token** needs **`read:project`** on top of the repo access; without it the page shows a notice and no badges (`INSUFFICIENT_SCOPES` → `ReadinessError` code `scope`), the comparison still works. `loadReadiness` is pure (GitHub injected as `graphql`), so it runs outside SvelteKit, e.g. against `gh api graphql`.
  - Seen on 2026-09-18: several issues are **closed but still in Backlog** on the project (components #2667, #2833, #2850) — their connectors show Not ready until the card is moved.
- **Excluded files** — `artifacts/ai-artifacts/**` and `package-lock.json` are never compared, released or deleted (`isExcluded`). None of them ever reached master in the hand-made releases; without the rule 38 connectors looked drifted.
- **Release** — `src/lib/server/release/publish.js`, `releaseConnectors(userId, items, {dryRun})`. One commit per connector with the message `<connector> <version> (<new|major|minor|patch>)`, the convention of the hand-made releases on master. Each commit mirrors the connector directory from dev: files are added, changed **and deleted** (the page warns when a release deletes components dev no longer has; a component whose directory only changed case or place — `MakeAPICall` → `MakeApiCall` — is reported as renamed, not deleted). It also carries the namespace's added/changed shared files, in the first commit of that namespace only. Shared files are never deleted, because other connectors of the namespace may still use them.
- **Release branch and PR** — the commits are created in the **head repo** (`RELEASE_HEAD_REPO` / `RELEASE_HEAD_BRANCH`, default `vtalas/appmixer-components` `release`, the head of every hand-made `[RELEASE]` PR) through the Git Data API (`git/blobs` → `git/trees` with `base_tree` → `git/commits`, chained). A fork shares its parent's objects, so only blobs new to the network are copied.
  - Without an open release PR the commits build on master, the head branch is created or **reset** onto them, and a `[RELEASE]` PR into master is opened. Before the reset `assertNothingUnmerged` refuses (409) when the branch carries commits whose messages are not on master — "Rebase and merge" rewrites the shas but keeps the messages.
  - With an open PR the commits build on its branch, which is fast-forwarded (`force: false`; a branch that moved meanwhile → 409, nothing published), and the commit list in the PR body is updated.
  - The branch moves once at the end, so either every commit lands or none does. The request carries the `devVersion` the admin reviewed and is refused when dev has moved since. `dryRun: true` returns the planned commits for the confirmation dialog.
- **Merging** happens by hand on GitHub with **Rebase and merge**, which keeps one commit per connector on master (a squash merge folds them into one). The merge starts Marketplace PRD.
- **In use** since 2026-09-15: the first page-made `[RELEASE]` PRs, Appmixer-ai/appmixer-components #2861 (37 commits) and #2862 (63 commits), were rebase-merged and Marketplace PRD ran green. `vtalas:release` is not deleted after a merge; the next release without an open PR resets it — its merged commits pass `assertNothingUnmerged` because rebase merging keeps the messages.
- **GitHub calls** — `githubRequest()` retries reads (network errors, 5xx) with a 30 s timeout per request: GitHub occasionally closes the connection halfway through a 3 MB tree download, which used to hang a page load for minutes.
- **Token** — the caller's GitHub token (Settings) or `SANITY_GITHUB_TOKEN`: read access to both repos (appmixer-components is private), push access to the head repo; the PR is opened in the target repo. Commits and the PR are authored by the token's owner. With a fork as the head repo the token also needs the **`workflow` scope**: the release branch is built on upstream master, so it brings `.github/workflows/` changes the fork's branches don't have yet (vtalas' fork master is hundreds of commits behind), and without the scope GitHub answers the ref update with **404** while blobs, trees and commits go through. `publish.js` turns that 404 into an explanatory 403.
- **Admin gating** — the page is open to every signed-in user; checkboxes, the Release buttons and `POST /api/releases` require `isAdmin`.
- **Trying it out** — point both `RELEASE_TARGET_*` and `RELEASE_HEAD_*` at branches of a fork: the PR is then opened inside the fork, and forks don't run the marketplace workflow.

Routes:

- `GET api/releases` — the comparison plus `readiness` (`{connectors: {<name>: {state, since, prs, directCommits, truncated}}, error}`) and `project` (session auth).
- `POST api/releases` — body `{connectors: [{name, devVersion}], dryRun?}`; plans or performs a release (admin only).

Environment: `RELEASE_SOURCE_REPO` / `RELEASE_SOURCE_BRANCH` (default `Appmixer-ai/appmixer-connectors` / `dev`), `RELEASE_TARGET_REPO` / `RELEASE_TARGET_BRANCH` (PR base, default `Appmixer-ai/appmixer-components` / `master`), `RELEASE_HEAD_REPO` / `RELEASE_HEAD_BRANCH` (PR head, default `vtalas/appmixer-components` / `release`), `RELEASE_PROJECT` (`<org>/<project number>`, default `Appmixer-ai/7`) / `RELEASE_READY_STATUSES` (comma-separated Status values that mean ready, default `Done`).

## Auth Hub (`/authub`)

Auth Hub is a separate page for browsing and managing OAuth connector configs/bundles registered in an external Auth Hub service — the **production** or the **QA** one.

### Key Features

- **Environments** — a Production / QA switcher in the header (`?env=prod|qa`, remembered in the `authhub_env` cookie). Every Auth Hub API route takes `?env=` (default `prod`); an environment whose variables are missing is shown disabled. Non-production is marked with a yellow badge, and every upload/delete dialog names its target.
- **Status tracking** — per-connector verification status (`not_verified` | `in_progress` | `verified`) stored in DB **per environment** and updated inline. **Production only** — QA shows a config check in that column instead.
- **Config check (QA)** — ✅ Configured when the service config has any key besides `serviceId` (the list response already carries the configs; the loader sends only the key names, `configKeys`), ❌ Not configured when it's the bare `{serviceId}` uploads create. Filterable; updated after Details → Edit, Upload New and uploads that register a connector. Shared definition: `src/lib/authhub-config.js`.
- **Notes** — free-text notes per connector and environment, stored in DB, edited via dialog
- **Whitelist management** — add/remove individual service-config keys to the Auth Hub whitelist (admin only)
- **Bundle download** — proxy-download a connector's ZIP bundle from Auth Hub
- **Bundle upload** — upload a new or replacement bundle, either a ZIP file or **packed from the repository** (below); polls a ticket until processing completes (admin only)
- **Service config edit** — view and edit connector config in field mode or raw JSON mode (admin only). A click anywhere in the read-only config (Enter/Space too; not its whitelist buttons) opens it as JSON, focused; **Save & Close** saves and closes Details, footer **Edit** opens field mode. Values are saved as strings, objects as their JSON.
- **Batch upload** (admin only) — row checkboxes (select all shown, **Select outdated** = the ⚠️ rows), a sticky bar and **Upload from repository…**: one preview of every selected connector at one commit, then sequential uploads (below).
- **GitHub oauth2 connector cache** — scans the GitHub repo for oauth2 connectors + `bundle.json` versions and caches results in DB; surfaced as a merged connector list. Connectors the repo has but the Auth Hub doesn't get an **Add** action (Upload New, prefilled, bundle from the repository).
- **Version comparison** — compares the Auth Hub bundle version against the cached GitHub version and highlights outdated/matching/newer connectors

### Upload from the repository

`src/lib/server/authhub/pack.js` builds the ZIP `appmixer pack` would build from a checkout, reading the files from GitHub — no clone, no CLI:

- **Sources** — `dev`: the repo/branch from Settings or env (the one the version column compares with, default `Appmixer-ai/appmixer-connectors@dev`); `release`: `RELEASE_TARGET_REPO@RELEASE_TARGET_BRANCH` (`Appmixer-ai/appmixer-components@master`, what the PRD marketplace is built from). The dialog preselects `release` for Production and `dev` for QA.
- **What is packed** — `serviceId` → `src/<vendor>/<service>[/<module>]`, which must hold a `bundle.json`. A `service.json` directory packs everything under it as `<vendor>/<service>/…`; a `module.json` directory packs the module plus the service-level files of its parent except the module directories (shared `auth.js`, commons, icons). Never `node_modules/`, `artifacts/`, `package-lock.json`, `test-flow*.json` or hidden files. Prefixes come from the manifest `name`, like the CLI. A namespace (`appmixer:google` — `service.json` but no `bundle.json`) is refused with the list of its modules: each module upload carries the shared files. Verified identical (file set and contents) to `appmixer pack` for `appmixer:box` and `appmixer:google:drive`.
- **One commit** — the preview (`GET api/auth-hub/upload-from-repo`) resolves the branch head and returns its sha; the upload (`POST`) requires that `commitSha` and packs exactly that commit, so what was reviewed is what goes up. Trees are listed per directory (`git/trees/<sha>:<dir>?recursive=1`), blobs fetched 8 at a time and kept in a 32 MB in-memory cache by sha; the ZIP (`src/lib/server/zip.js`, deflate, no zip64) is deterministic — entries are dated with the commit.
- **The preview** shows the manifest name, bundle version against the Auth Hub's (upgrade / same / **downgrade**), commit and path links, the file list, and a Download ZIP link (`?download=1`) for inspection.

### Batch upload

- `POST api/auth-hub/upload-from-repo/preview` `{serviceIds, source}` resolves the branch head once and plans every connector at that commit (4 at a time, at most 100); per item either the pack summary or `error`. Commits and directory listings are cached in memory by commit sha, so modules of one service share their parent's listing.
- The dialog shows the Auth Hub version next to the packed one with a verdict: **new** (not listed in the Auth Hub), **upgrade**, **same**, **downgrade**, **version not loaded** (the page knows Auth Hub versions only from the bundle cache — Refresh / Details), or the planning error. New, upgrade and unknown are ticked by default; same and downgrade only by hand.
- Uploads run in the browser one after another (each is a short `POST upload-from-repo` + ticket polling), so no request runs long. A failure doesn't stop the batch; **Retry** re-runs the failed ones; **Stop** finishes the current upload and leaves the rest. Uploaded connectors leave the selection. The environment is fixed when the batch starts, and the switcher is disabled while it runs.

### Service config = listed

`GET /service-config` (the page's list) returns only connectors with a service config — a bundle uploaded alone stays invisible and the row keeps offering **Add**. `GET /service-config/<id>` answers **200 `{}`** for a missing config (`ServiceConfig.load`), so "does it exist" means a non-empty object; the old `res.ok` check asked to overwrite a config that didn't exist. Therefore:
- Upload New always saves a config — `{serviceId}` when no keys were entered.
- **PUT replaces the whole config** (`ServiceConfig.update` = `findOneAndReplace` with upsert, appmixer-core `engine/src/auth/ServiceConfig.js`), so Details → Edit sends every key, and Upload New's **Overwrite** of an existing config drops the keys not entered in the dialog (clientId/clientSecret included).
- After any successful upload of a connector the list doesn't have yet (Add, Upload New, batch), `ensureServiceConfig()` creates `{serviceId}` if it's missing. clientId/clientSecret are added later via Details → Edit.
- A row the repo has, with a cached bundle but no config, is badged **bundle only, no service config** (the state a bundle-only upload used to leave behind); **Add** fixes it — a ZIP-file upload with no file saves just the config.
- Tenants aren't affected by a config without credentials: a tenant goes to Auth Hub only when its own config says so (`authHubUrl`) or via the automatic fallback, and Auth Hub validates the credentials either way (`engine/src/auth/ServiceFactory.js`).

### Upload tickets

Auth Hub (`appmixer-core` `auth-hub/routes/component.js` → engine `Uploader`) answers `POST /components` with a `ticket` and processes the bundle in the background (unzip, validate, npm install, test components, swap files). `GET /components/uploader/<ticket>` returns 404 until the ticket is stored, `{started}` while running, then `{finished, installed}` **or `{finished, err, data}`** — `finished` is set on failure too, so `err` must be checked first (the page used to report failed uploads as complete). `waitForUpload()` in the page polls every 2 s for up to 5 minutes.

### Architecture

- **`src/lib/server/authhub/hub.js`** — environments (`listAuthHubEnvs`, `resolveAuthHub(id)`, `resolveAuthHubFromUrl(url)`, `isAuthHubEnv`), `authHubFetch(hub, path, init)` with the bearer token, `uploadToAuthHub(hub, zip)`. Add an environment to its `ENVIRONMENTS` list.
- **`src/lib/server/authhub/pack.js`** — `getPackSources(userId)`, `planPack({token, source, serviceId, commitSha})` (file list + manifest info, no blob downloads except the manifests), `buildPack(token, plan)` (the ZIP).
- **`src/routes/authub/+page.svelte`** — Main SPA page. Displays a filterable connector table (search, status filter, "not in Auth Hub" toggle) with version comparison indicators, status dropdowns, notes, and admin dialogs (upload bundle, upload new connector, view/edit service config, delete connector). All API calls go through `api(path, params)`, which adds `env`. Per-environment state (`connectors`, `cachedInfo`, `statuses`, `notes`, `githubVersions`) is an **overridable `$derived`** of `data`: switching `?env=` re-runs `load` and replaces it, local updates assign to it. Page `data` is not deeply reactive — `data.connectors = …` never re-rendered, so deletes and uploads didn't show until a reload. The switcher is disabled while an operation runs; dialogs close when the environment changes.
- **`src/routes/authub/+page.server.js`** — Server `load` function. Picks the environment (`?env=`, else the cookie, else `prod`), fetches the connector list from that Auth Hub, cached bundle info, its DB-stored statuses/notes, and cached GitHub oauth2 connector data. Returns a merged connector list tagged by `source` (`authhub` | `github` | `both`) — only `serviceId` + `source` per connector: the upstream objects carry `clientSecret`, and the page data reaches every signed-in user. Also returns `env`, `envs` and the admin's `packSources`. Uses `getGitHubRepoInfo` from `src/lib/api/github.js` to populate the GitHub repo link shown to admins.

### API Routes (`src/routes/api/auth-hub/`)

Every route that talks to Auth Hub or stores per-connector data takes `?env=prod|qa` (default `prod`, unknown → 400, unconfigured → 500).

| Route | Methods | Description |
|---|---|---|
| `+server.js` | GET | List all connectors from Auth Hub (`GET /service-config`) |
| `bundle/+server.js` | GET | Read cached bundle info (version, icon, label) from disk for all connectors of the environment |
| `bundle/+server.js` | POST | Download bundle ZIP from Auth Hub for a single `serviceId`, extract to the environment's local cache, return version |
| `bundle-download/+server.js` | GET | Proxy-download a connector bundle ZIP to the browser as `<selector>.zip` (auth required) |
| `connector/+server.js` | DELETE | Delete service config + bundle from Auth Hub (admin only) |
| `github-oauth/+server.js` | GET | Return cached GitHub oauth2 connector list from DB (environment-independent) |
| `github-oauth/+server.js` | POST | Scan GitHub repo for oauth2 connectors + bundle.json versions, save to DB, return result |
| `notes/+server.js` | POST | Save per-connector notes to DB (auth required) |
| `service-config/+server.js` | GET | Fetch service config for a single connector; `?whitelist=1` fetches the whitelist instead (auth required) |
| `service-config/+server.js` | PUT | Update service config for a connector (admin only) |
| `service-config/whitelist-key/+server.js` | PUT | Add a single whitelist key for a connector (admin only) |
| `service-config/whitelist-key/+server.js` | DELETE | Remove a single whitelist key from a connector (admin only) |
| `status/+server.js` | POST | Save verification status (`verified` / `not_verified` / `in_progress`) to DB |
| `../public/connectors/+server.js` | GET | **Public** (no auth) list of Auth Hub connectors — returns only `connector`, `status`, `clientId`; optional `?env=` and `?status=` |
| `upload/+server.js` | POST | Upload a ZIP bundle to Auth Hub; returns `{ ticket }` (admin only) |
| `upload/+server.js` | GET | Poll upload ticket status (`?ticket=…`) (admin only) |
| `upload-from-repo/+server.js` | GET | Pack preview: `?serviceId=&source=dev\|release[&commit=]` → manifest name, version, commit, file list; `&download=1` returns the ZIP (admin only) |
| `upload-from-repo/+server.js` | POST | `{serviceId, source, commitSha}` → pack that commit and upload it; returns `{ ticket, …info, size }` (admin only) |
| `upload-from-repo/preview/+server.js` | POST | Batch preview: `{serviceIds, source}` → `{commitSha, …, items: [{serviceId, ok, name, kind, version, fileCount, totalSize} \| {serviceId, ok: false, error}]}` (admin only) |

### Database Tables

- **`authhub_env_status`** — Per-environment verification status and notes: `env`, `service_id` (primary key together), `status`, `notes`, `updated_at`. Replaces **`authhub_status`** (prod only, keyed by `service_id`), which is kept: on every startup its rows are copied in as `prod` when newer than the new table's, so a deployment still running the old code loses nothing during the switch.
- **`github_oauth_connectors`** — Cached GitHub scan results: `service_id`, `path`, `github_version`, `is_oauth2`, `updated_at`. Populated by `github-oauth` POST, read by GET.

### DB Helpers (`src/lib/db/authhub.js`)

- `getAuthHubStatuses(env)` — Returns `Record<serviceId, status>` for all connectors of the environment
- `setAuthHubStatus(env, serviceId, status)` — Upserts verification status
- `getAuthHubNotes(env)` — Returns `Record<serviceId, notes>` (non-empty only)
- `setAuthHubNotes(env, serviceId, notes)` — Upserts notes
- `getGithubOAuthConnectors()` — Returns `{ oauth2: [{serviceId, path}], versions: {serviceId: version} }` from DB
- `setGithubOAuthConnectors(connectors)` — Replaces all cached GitHub connector data

### Admin Gating

Admin features (edit service config, whitelist keys, upload bundle, upload from the repository, delete connector — and releasing connectors on `/releases`) are gated by `isAdmin(email)` from `src/lib/admin.js`. It reads `ADMIN_EMAILS` (comma-separated) from env and checks if the session user's email is in the list.

### Environment Variables

- `AUTH_HUB_URL_PROD` / `AUTH_HUB_API_TOKEN_PROD` — production Auth Hub (`https://auth-hub.appmixer.com`) and its bearer token
- `AUTH_HUB_URL_QA` / `AUTH_HUB_API_TOKEN_QA` — QA Auth Hub (`https://auth-hub.dev.appmixer.ai`, deployed from app-config `env/dev-ec1/system/authhub`); optional. `https://authhub.eks.appmixer.co` (an old commented-out value) no longer serves the API.
- `ADMIN_EMAILS` — Comma-separated list of admin email addresses
- Upload from the repository uses the GitHub token (Settings or `SANITY_GITHUB_TOKEN`) — read access to both source repos — and `RELEASE_TARGET_REPO` / `RELEASE_TARGET_BRANCH` for the `release` source.

### Testing locally

A worktree with `node_modules` symlinked to the main checkout needs Vite's `server.fs.allow` to include the main checkout, otherwise the client entry is refused (403) and the page never hydrates. To exercise uploads without touching a real Auth Hub, point `AUTH_HUB_URL_QA` at a local mock of `/service-config`, `POST /components` and `/components/uploader/<ticket>` (shell variables win over `.env`).

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

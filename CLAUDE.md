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

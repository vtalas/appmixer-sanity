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

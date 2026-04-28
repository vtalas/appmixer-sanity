# Appmixer Sanity Check

A SvelteKit application for tracking sanity checks of Appmixer connectors. It creates snapshots of connector versions, allows testing and documenting component status, and tracks progress with visual dashboards.

**Pages:**
- `/` — Dashboard: list test runs, create new ones
- `/test-runs/[runId]` — Test run detail: connectors with status badges
- `/test-runs/[runId]/[connectorId]` — Connector detail: components, update test results
- `/authub` — Auth Hub: browse and manage OAuth connector configs/bundles registered in Auth Hub

**Stack:** SvelteKit 2, Svelte 5, Turso (libSQL), Tailwind CSS, Bits UI, deployed on Vercel.

See `CLAUDE.md` for full architecture documentation.

## Developing

Once you've installed dependencies with `pnpm install`, add your environment variables as needed (see `.env.example`), and then you can start a development server:

```bash
pnpm run dev

# or start the server and open the app in a new browser tab
pnpm run dev -- --open
```

## Building

To create a production version of your app:

```bash
pnpm run build
```

You can preview the production build with `npm run preview`.

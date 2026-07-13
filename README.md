# Appmixer Sanity Check

A SvelteKit application for tracking sanity checks of Appmixer connectors. It creates snapshots of connector versions, allows testing and documenting component status, and tracks progress with visual dashboards.

**Pages:**
- `/` — Dashboard: list test runs, create new ones
- `/test-runs/[runId]` — Test run detail: connectors with status badges
- `/test-runs/[runId]/[connectorId]` — Connector detail: components, update test results
- `/authub` — Auth Hub: browse and manage OAuth connector configs/bundles registered in Auth Hub

**Stack:** SvelteKit 2, Svelte 5, Turso (libSQL), Tailwind CSS, Bits UI, deployed on Vercel.

See `CLAUDE.md` for full architecture documentation.

## Public API

### `GET /api/public/connectors`

Public endpoint (no authentication required) that lists OAuth connectors registered in Auth Hub, together with their verification status.

**Query parameters**

| Param | Required | Description |
|---|---|---|
| `status` | no | Filter by verification status: `verified`, `in_progress`, or `not_verified`. Omit to return all connectors. |

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

| Field | Description |
|---|---|
| `connector` | Connector service ID (e.g. `appmixer:airtable`) |
| `status` | Verification status: `verified` \| `in_progress` \| `not_verified` (default when never set) |
| `clientId` | OAuth client ID registered in Auth Hub |

**Example**

```bash
curl "https://<host>/api/public/connectors?status=verified"
```

**Notes**

- Responses are cacheable for 60 s (`Cache-Control: public, max-age=60`).
- No secrets are exposed — the response contains only the three fields above.
- An unknown `status` value returns an empty array.
- Errors return `{ "error": "..." }` with `500` (service not configured / internal) or `502` (Auth Hub upstream error).

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

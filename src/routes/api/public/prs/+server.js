import { json } from '@sveltejs/kit';
import { buildPROverview } from '$lib/server/e2e/prs.js';

/**
 * GET — public E2E status of open connector PRs.
 *
 * SECURITY: This endpoint is unauthenticated (whitelisted in hooks.server.js).
 * It serves only cached data (e2e_prs + e2e_flows tables, env-credential scope)
 * — no live GitHub or instance calls — and the fields are explicitly
 * whitelisted below. Refreshed by the cron scan or the PRs page.
 *
 * Query params:
 * - connector=<name>  only PRs touching this connector
 *
 * Shape per PR: { number, title, url, author, draft, updatedAt, readyToMerge,
 *   checklist: [{ key, label, status, detail }],
 *   linkedIssues: [{ repo, number, state, url }], connectors:
 *   [{ name, accountAvailable, flows: [{ name, syncStatus, deployed,
 *      lastResult, lastResultAt, changedInPR, newInPR }] }] }
 */
export async function GET({ url }) {
  try {
    // null user = env credentials (same scope the cron scan writes)
    const { repo, prs, lastScanAt } = await buildPROverview(null);

    const connectorFilter = url.searchParams.get('connector');

    const result = prs
      .filter((pr) => !connectorFilter || pr.connectors.some((c) => c.name === connectorFilter))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        draft: pr.draft,
        baseBranch: pr.baseBranch,
        updatedAt: pr.updatedAt,
        readyToMerge: pr.readyToMerge,
        checklist: pr.checklist,
        linkedIssues: (pr.linkedIssues || []).map((issue) => ({
          repo: issue.repo,
          number: issue.number,
          state: issue.state,
          url: issue.url
        })),
        connectors: pr.connectors.map((c) => ({
          name: c.name,
          accountAvailable: c.accountAvailable,
          flows: c.flows.map((f) => ({
            name: f.flowName,
            syncStatus: f.syncStatus,
            deployed: !!f.flowId,
            lastResult: f.lastResult,
            lastResultAt: f.lastResultAt,
            changedInPR: f.changedInPR,
            newInPR: f.newInPR
          }))
        }))
      }));

    return json(
      { repo, lastScanAt, prs: result },
      { headers: { 'Cache-Control': 'public, max-age=60' } }
    );
  } catch (e) {
    console.error('Public PR status failed:', e);
    return json({ error: 'Failed to load PR status' }, { status: 500 });
  }
}

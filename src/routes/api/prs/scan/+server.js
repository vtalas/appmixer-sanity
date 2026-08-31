import { json, error } from '@sveltejs/kit';
import { scanPRs } from '$lib/server/e2e/prs.js';

/**
 * POST /api/prs/scan
 * Refresh the e2e_prs cache: open PRs of the connectors repo, the connectors
 * each PR touches, and the test-flow files it adds/changes.
 */
export async function POST({ locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  try {
    const summary = await scanPRs(session.user.email);
    return json(summary);
  } catch (e) {
    console.error('PR scan failed:', e);
    throw error(500, /** @type {any} */ (e)?.message || 'PR scan failed');
  }
}

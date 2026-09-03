import { json, error } from '@sveltejs/kit';
import { scanPR } from '$lib/server/e2e/prs.js';

/**
 * POST /api/prs/[number]/scan
 * Refresh one PR in the e2e_prs cache — the same data as the full scan but for
 * a single PR, so a card can be brought up to date without rescanning all of
 * them. Returns `{ removed: true }` when the PR is no longer open.
 */
export async function POST({ locals, params }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const number = Number(params.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw error(400, 'Invalid PR number');
  }

  try {
    return json(await scanPR(session.user.email, number));
  } catch (e) {
    console.error(`PR #${number} scan failed:`, e);
    throw error(500, /** @type {any} */ (e)?.message || 'PR scan failed');
  }
}

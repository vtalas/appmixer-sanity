import { json, error } from '@sveltejs/kit';
import { getAccountsOverview } from '$lib/server/e2e/accounts.js';

/**
 * GET /api/e2e-flows/accounts
 * Accounts the cached E2E flows need — one row per (service, scope set) with the
 * accounts currently valid for it. Read live from the instance.
 */
export async function GET({ locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  try {
    return json(await getAccountsOverview(session.user.email));
  } catch (e) {
    console.error('Failed to load E2E accounts:', e);
    throw error(500, /** @type {any} */ (e)?.message || 'Failed to load accounts');
  }
}

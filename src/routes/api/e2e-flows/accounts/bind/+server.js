import { json, error } from '@sveltejs/kit';
import { bindAccountToConnectors } from '$lib/server/e2e/accounts.js';

/**
 * POST /api/e2e-flows/accounts/bind
 * Bind an account to every deployed E2E flow of the given connectors.
 * Body: { accountId, connectors: string[] } — connectors are cache paths ("google/drive").
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const { accountId, connectors } = await request.json().catch(() => ({}));
  if (typeof accountId !== 'string' || !accountId) {
    throw error(400, 'accountId is required');
  }
  if (!Array.isArray(connectors) || connectors.length === 0) {
    throw error(400, 'connectors array is required');
  }

  try {
    return json(await bindAccountToConnectors(session.user.email, accountId, connectors));
  } catch (e) {
    console.error('Failed to bind account:', e);
    throw error(500, /** @type {any} */ (e)?.message || 'Failed to bind account');
  }
}

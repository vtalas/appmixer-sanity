import { json, error } from '@sveltejs/kit';
import { getAccountAuthStatus } from '$lib/api/appmixer.js';

/**
 * GET /api/e2e-flows/accounts/status?ticket=…
 * Poll an auth ticket: { finished, error, accountId }. `expired: true` when the
 * instance no longer knows the ticket.
 */
export async function GET({ url, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    throw error(400, 'ticket is required');
  }

  try {
    const status = await getAccountAuthStatus(session.user.email, ticket);
    return json(status || { finished: false, error: null, accountId: null, expired: true });
  } catch (e) {
    throw error(502, /** @type {any} */ (e)?.message || 'Failed to read auth status');
  }
}

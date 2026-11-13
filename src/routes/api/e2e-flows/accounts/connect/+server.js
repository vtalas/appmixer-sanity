import { json, error } from '@sveltejs/kit';
import { startAccountAuth } from '$lib/api/appmixer.js';

/**
 * POST /api/e2e-flows/accounts/connect
 * Start connecting an account for a connector module. Body: { authType } — the
 * dot-separated module type ("appmixer.google.drive"); the instance derives the
 * service and the scopes from it. Answers the ticket to poll and the URL to open.
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const { authType } = await request.json().catch(() => ({}));
  if (typeof authType !== 'string' || !/^[\w-]+(\.[\w-]+){1,2}$/.test(authType)) {
    throw error(400, 'authType must be a module type like "appmixer.google.drive"');
  }

  try {
    return json(await startAccountAuth(session.user.email, authType));
  } catch (e) {
    console.error(`Failed to start auth for ${authType}:`, e);
    throw error(502, /** @type {any} */ (e)?.message || 'Failed to start authentication');
  }
}

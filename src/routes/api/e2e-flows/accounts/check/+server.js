import { json, error } from '@sveltejs/kit';
import { checkAccountRow } from '$lib/server/e2e/accounts.js';

/**
 * GET /api/e2e-flows/accounts/check?authType=appmixer.google.drive
 * Live status of one accounts row: { status, validAccounts, error }. The instance
 * validates tokens for it, so the dialog calls this per row instead of in bulk.
 */
export async function GET({ url, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const authType = url.searchParams.get('authType') || '';
  if (!/^[\w-]+(\.[\w-]+){1,2}$/.test(authType)) {
    throw error(400, 'authType must be a module type like "appmixer.google.drive"');
  }

  return json(await checkAccountRow(session.user.email, authType));
}

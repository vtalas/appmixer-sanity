import { isAdmin } from '$lib/admin.js';
import { compareReleases } from '$lib/server/release/compare.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;
  const admin = isAdmin(userId);

  try {
    return { ...(await compareReleases(userId)), isAdmin: admin, error: null };
  } catch (e) {
    console.error('Release comparison failed:', e);
    return {
      source: null,
      target: null,
      connectors: [],
      namespaces: [],
      isAdmin: admin,
      error: /** @type {any} */ (e)?.message || 'Release comparison failed'
    };
  }
}

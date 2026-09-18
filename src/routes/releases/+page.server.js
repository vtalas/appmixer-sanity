import { isAdmin } from '$lib/admin.js';
import { compareReleases } from '$lib/server/release/compare.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;
  const admin = isAdmin(userId);

  try {
    // `readiness` stays a promise — SvelteKit streams it to the page once the
    // project statuses are in, the comparison renders right away
    return { ...(await compareReleases(userId, { readiness: true })), isAdmin: admin, error: null };
  } catch (e) {
    console.error('Release comparison failed:', e);
    return {
      source: null,
      target: null,
      connectors: [],
      namespaces: [],
      readiness: null,
      isAdmin: admin,
      error: /** @type {any} */ (e)?.message || 'Release comparison failed'
    };
  }
}

import { loadStatistics } from '$lib/server/statistics.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email || '';

  try {
    return { ...(await loadStatistics(userId)), error: null };
  } catch (e) {
    console.error('Statistics failed:', e);
    return {
      repo: null,
      counts: { connectors: 0, components: 0, e2eFlows: 0 },
      connectors: [],
      e2eFlows: [],
      error: /** @type {any} */ (e)?.message || 'Statistics failed'
    };
  }
}

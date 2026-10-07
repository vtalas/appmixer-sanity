import { loadMonthlyStatistics, monthRange } from '$lib/server/statistics.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals, url }) {
  const session = await locals.auth();
  const userId = session?.user?.email || '';
  const month = url.searchParams.get('month');

  try {
    return { ...(await loadMonthlyStatistics(userId, month)), error: null };
  } catch (e) {
    console.error('Statistics failed:', e);
    const range = monthRange(month);
    return {
      repo: null,
      month: {
        key: range.key,
        current: range.current,
        previousKey: range.previousKey,
        nextKey: range.nextKey
      },
      head: null,
      counts: { connectors: 0, components: 0, e2eFlows: 0 },
      previous: null,
      releases: [],
      releasesByType: /** @type {Record<string, number>} */ ({
        new: 0,
        major: 0,
        minor: 0,
        patch: 0
      }),
      other: [],
      connectors: [],
      e2eFlows: [],
      error: /** @type {any} */ (e)?.message || 'Statistics failed'
    };
  }
}

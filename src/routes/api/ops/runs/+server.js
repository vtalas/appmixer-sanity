import { json, error } from '@sveltejs/kit';
import { listFlowRuns } from '$lib/server/ops.js';

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/ops/runs?flowId=<id>[&errors=1]
 * Recent runs of one integration instance for the run tree on /ops — loaded on demand so
 * the page itself does not fetch every instance's logs.
 */
export async function GET({ locals, url }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const flowId = url.searchParams.get('flowId') || '';
  if (!FLOW_ID.test(flowId)) {
    throw error(400, 'Invalid flowId');
  }

  try {
    const runs = await listFlowRuns(session.user.email, flowId, {
      errorsOnly: url.searchParams.get('errors') === '1'
    });
    return json({ runs });
  } catch (e) {
    console.error(`Runs of ${flowId} failed:`, e);
    throw error(502, /** @type {any} */ (e)?.message || 'Log search failed');
  }
}

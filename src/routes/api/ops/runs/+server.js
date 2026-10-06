import { json, error } from '@sveltejs/kit';
import { listFlowRuns } from '$lib/server/ops.js';

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/ops/runs?flowId=<id>[&errors=1][&before=<next of the page above>]
 * One page of the recent runs of an integration instance for the run tree on /ops — loaded
 * on demand so the page itself does not fetch every instance's logs. `next` in the response
 * is the `before` of the following page, null on the last one.
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
  // The cursor goes into the log query, so only a timestamp gets through
  const before = url.searchParams.get('before') || '';
  if (before && isNaN(Date.parse(before))) {
    throw error(400, 'Invalid before');
  }

  try {
    return json(
      await listFlowRuns(session.user.email, flowId, {
        errorsOnly: url.searchParams.get('errors') === '1',
        before: before && new Date(before).toISOString()
      })
    );
  } catch (e) {
    console.error(`Runs of ${flowId} failed:`, e);
    throw error(502, /** @type {any} */ (e)?.message || 'Log search failed');
  }
}

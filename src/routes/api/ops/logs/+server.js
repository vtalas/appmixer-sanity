import { json, error } from '@sveltejs/kit';
import { listFlowLogs } from '$lib/server/ops.js';

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/ops/logs?flowId=<id>[&errors=1]
 * Recent log entries of one integration instance for the log panel on /ops — loaded on
 * demand so the page itself does not fetch every instance's logs.
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
    const logs = await listFlowLogs(session.user.email, flowId, {
      errorsOnly: url.searchParams.get('errors') === '1'
    });
    return json({ logs });
  } catch (e) {
    console.error(`Logs of ${flowId} failed:`, e);
    throw error(502, /** @type {any} */ (e)?.message || 'Log search failed');
  }
}

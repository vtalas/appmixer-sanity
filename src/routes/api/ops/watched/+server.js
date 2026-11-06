import { json, error } from '@sveltejs/kit';
import { addWatchedFlow, removeWatchedFlow, WatchError } from '$lib/server/ops.js';

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ops/watched {flow, label?} — adds a flow to the caller's watched flows on /ops.
 * `flow` is the flow id or a URL holding it (the designer link).
 */
export async function POST({ locals, request }) {
  const session = await locals.auth();
  if (!session?.user?.email) throw error(401, 'Unauthorized');
  const body = await request.json().catch(() => ({}));
  try {
    return json(await addWatchedFlow(session.user.email, body?.flow, body?.label));
  } catch (e) {
    if (e instanceof WatchError) throw error(e.status, e.message);
    console.error('Watching a flow failed:', e);
    throw error(502, /** @type {any} */ (e)?.message || 'Watching the flow failed');
  }
}

/** DELETE /api/ops/watched?flowId=<id> — stops watching a flow. */
export async function DELETE({ locals, url }) {
  const session = await locals.auth();
  if (!session?.user?.email) throw error(401, 'Unauthorized');
  const flowId = url.searchParams.get('flowId') || '';
  if (!FLOW_ID.test(flowId)) throw error(400, 'Invalid flowId');
  return json(await removeWatchedFlow(session.user.email, flowId.toLowerCase()));
}

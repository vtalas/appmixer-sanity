import { json, error } from '@sveltejs/kit';
import { getE2EFlows, enqueueRuns, cancelQueuedRuns, getRunnerSnapshot } from '$lib/db/e2e.js';
import { tickPass } from '$lib/server/e2e/runner.js';
import { getInstanceUrl } from '$lib/api/appmixer.js';

/**
 * POST /api/e2e-flows/run
 * Enqueue E2E runs. Body: { flowNames?: string[], connector?: string, all?: boolean }
 * Only deployed flows are enqueued. Immediately runs one tick pass so the first
 * flow(s) start right away.
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const userId = session.user.email;

  try {
    const { flowNames, connector, all } = await request.json();

    const instanceUrl = await getInstanceUrl(userId);
    const flows = await getE2EFlows(instanceUrl);
    let targets;

    if (Array.isArray(flowNames) && flowNames.length > 0) {
      const requested = new Set(flowNames);
      targets = flows.filter((f) => requested.has(f.flowName));
    } else if (connector) {
      targets = flows.filter((f) => f.connector === connector);
    } else if (all) {
      targets = flows;
    } else {
      throw error(400, 'Provide flowNames, connector, or all');
    }

    const deployed = targets.filter((f) => f.flowId);
    const notDeployed = targets.length - deployed.length;

    const { enqueued, skipped } = await enqueueRuns(
      instanceUrl,
      deployed.map((f) => f.flowName),
      userId
    );

    // Kick the runner so the first flows start without waiting for the next tick
    const tick = await tickPass(userId);

    return json({ enqueued, skipped, notDeployed, tick });
  } catch (e) {
    if (e?.status) throw e;
    console.error('Failed to enqueue E2E runs:', e);
    throw error(500, e.message || 'Failed to enqueue runs');
  }
}

/**
 * DELETE /api/e2e-flows/run
 * Cancel all queued runs (running ones finish or time out on their own).
 */
export async function DELETE({ locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  try {
    const instanceUrl = await getInstanceUrl(session.user.email);
    const cancelled = await cancelQueuedRuns(instanceUrl);
    const snapshot = await getRunnerSnapshot(instanceUrl);
    return json({ cancelled, snapshot });
  } catch (e) {
    console.error('Failed to cancel queued runs:', e);
    throw error(500, e.message || 'Failed to cancel runs');
  }
}

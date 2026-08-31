import { json, error } from '@sveltejs/kit';
import { updateFlow, getInstanceUrl } from '$lib/api/appmixer.js';
import { fetchTestFlowJson } from '$lib/api/github.js';
import { getE2EFlows } from '$lib/db/e2e.js';

/**
 * POST /api/e2e-flows/revert
 * Revert a flow on Appmixer to match the GitHub version.
 * The GitHub file is resolved via the e2e_flows cache (githubPath) — one fetch.
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    return error(401, 'Unauthorized');
  }

  const userId = session.user.email;

  try {
    const { flowId, flowName } = await request.json();

    if (!flowId || !flowName) {
      return error(400, 'flowId and flowName are required');
    }

    const flows = await getE2EFlows(await getInstanceUrl(userId));
    const cached = flows.find((f) => f.flowName === flowName);

    if (!cached?.githubPath) {
      return error(404, 'Flow not found in GitHub repository (run a Scan first)');
    }

    const githubFlow = await fetchTestFlowJson(userId, cached.githubPath);
    await updateFlow(userId, flowId, githubFlow);

    return json({ success: true });
  } catch (e) {
    console.error('Failed to revert flow:', e);
    return error(500, e.message || 'Failed to revert flow');
  }
}

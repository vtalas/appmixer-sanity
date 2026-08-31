import { json, error } from '@sveltejs/kit';
import { fetchFlowById, cleanFlowForComparison, getInstanceUrl } from '$lib/api/appmixer.js';
import { fetchTestFlowJson } from '$lib/api/github.js';
import { getE2EFlows } from '$lib/db/e2e.js';
import { sortKeysDeep } from '$lib/server/e2e/scan.js';

/**
 * POST /api/e2e-flows/diff
 * Returns cleaned server flow and GitHub flow JSON for comparison.
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

    const [fullFlow, githubFlow] = await Promise.all([
      fetchFlowById(userId, flowId),
      fetchTestFlowJson(userId, cached.githubPath)
    ]);

    // Both sides normalized (instance-specific bindings, server-stamped fields)
    // and key-sorted so the diff shows logic changes only, no ordering noise
    const cleanedServerFlow = sortKeysDeep(cleanFlowForComparison(fullFlow, flowName));
    const cleanedGithubFlow = sortKeysDeep(cleanFlowForComparison(githubFlow, flowName));

    return json({
      server: JSON.stringify(cleanedServerFlow, null, 2),
      github: JSON.stringify(cleanedGithubFlow, null, 2),
      githubPath: cached.githubPath
    });
  } catch (e) {
    console.error('Failed to compute diff:', e);
    return error(500, e.message || 'Failed to compute diff');
  }
}

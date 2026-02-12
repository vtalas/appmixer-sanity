import { json, error } from '@sveltejs/kit';
import { fetchFlowById, cleanFlowForComparison } from '$lib/api/appmixer.js';
import { buildFlowNameToGitHubMap } from '$lib/api/github.js';

/**
 * POST /api/e2e-flows/diff
 * Returns cleaned server flow and GitHub flow JSON for comparison
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

        // Fetch server flow and GitHub map in parallel
        const [fullFlow, githubFlowMap] = await Promise.all([
            fetchFlowById(userId, flowId),
            buildFlowNameToGitHubMap(userId)
        ]);

        const githubInfo = githubFlowMap.get(flowName);
        if (!githubInfo) {
            return error(404, 'Flow not found in GitHub repository');
        }

        const cleanedServerFlow = cleanFlowForComparison(fullFlow);

        return json({
            server: JSON.stringify(cleanedServerFlow, null, 2),
            github: JSON.stringify(githubInfo.content, null, 2),
            githubPath: githubInfo.path
        });
    } catch (e) {
        console.error('Failed to compute diff:', e);
        return error(500, e.message || 'Failed to compute diff');
    }
}

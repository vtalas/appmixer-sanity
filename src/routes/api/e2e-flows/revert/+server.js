import { json, error } from '@sveltejs/kit';
import { updateFlow } from '$lib/api/appmixer.js';
import { buildFlowNameToGitHubMap } from '$lib/api/github.js';

/**
 * POST /api/e2e-flows/revert
 * Revert a flow on Appmixer to match the GitHub version
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

        const githubFlowMap = await buildFlowNameToGitHubMap(userId);
        const githubInfo = githubFlowMap.get(flowName);

        if (!githubInfo || !githubInfo.content) {
            return error(404, 'Flow not found in GitHub repository');
        }

        await updateFlow(userId, flowId, githubInfo.content);

        return json({ success: true });
    } catch (e) {
        console.error('Failed to revert flow:', e);
        return error(500, e.message || 'Failed to revert flow');
    }
}
